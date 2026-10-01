// A book's script written out as `<book>.script.zip`: which chapter a script belongs to is told by
// the words of its source, and the file holds the script and nothing local to this install.
// See docs/script-transfer.md#the-file-and-the-export.
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import JSZip from "jszip";

import type {
  Book,
  Character,
  Endpoint,
  ScriptFileChapter,
  ScriptFileSpeaker,
  ScriptExportSamples,
  ScriptFileTerm,
  ScriptFileVoice,
  ScriptManifest,
} from "@/types";
import { clonedVoices } from "~/db/schema";
import { sourceHash } from "~/script/transfer";
import { keepSampleFiles } from "~/voices/ops";
import { voiceFiles } from "~/voices/files";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi } from "../support/server";

describe("sourceHash", () => {
  const body = "The *ledger* lay open. “We are short again,” said Mara.";

  test.each([
    ["markup", "The ledger lay **open**. “We are short again,” said Mara."],
    ["straight quotes", 'The ledger lay open. "We are short again," said Mara.'],
    ["spacing and line breaks", "The ledger  lay open.\n\n“We are short again,”\nsaid Mara."],
  ])("a source that differs only in %s is the same chapter", (_, other) => {
    expect(sourceHash(other)).toEqual(sourceHash(body));
  });

  test("one changed word is another chapter", () => {
    expect(sourceHash(body.replace("short", "shy")).hash).not.toBe(sourceHash(body).hash);
    expect(sourceHash(body)).toMatchObject({
      hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      words: 10,
    });
  });
});

const studio: Endpoint = {
  id: "studio",
  name: "Studio speech",
  baseUrl: "http://localhost:8880/v1",
  model: "studio-tts",
  concurrency: 2,
  enabled: true,
  latency: 0,
  failRate: 0,
  price: 15,
  billing: { unit: "chars", rate: 15 },
  needsKey: false,
  maxChars: 0,
  splitAt: "sentence",
  voices: [{ id: "ash", gender: "m", label: "Ash" }],
  history: [],
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
};

test("the zip holds a manifest, the cast with voice hints, the dictionary and one file per scripted chapter", async () => {
  const api = testApi();
  await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [studio], profiles: [], credentials: [] }),
    method: "PUT",
  });
  const { body } = await api.import<{ book: Book }>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: ["One", "Two"].map((title) => ({
        title,
        paragraphs: ["“We are short again,” said Mara.", ...story(2)],
      })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
  await api.runner.idle();
  const cast = (await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`)).body;
  const mara = cast.characters.find((c) => c.name !== "Narrator")!;
  await api.request(`/api/books/${id}/characters/${encodeURIComponent(mara.name)}`, {
    ...jsonBody({ ...mara, voice: "studio/ash" }),
    method: "PUT",
  });
  await api.request(`/api/books/${id}/lexicon`, {
    ...jsonBody({ entries: [{ id: 1, term: "Mara", say: "MAH-ra", enabled: true }] }),
    method: "PUT",
  });

  const res = await api.fetch(`/api/books/${id}/script-export`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("content-disposition")).toContain("Moonlight Ledger.script.zip");
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  const read = async <T>(name: string) => JSON.parse(await zip.file(name)!.async("string")) as T;

  const manifest = await read<ScriptManifest>("manifest.json");
  // chapter two has no script, so it has no file
  expect(manifest.chapters.map((c) => [c.file, c.title])).toEqual([
    ["chapters/0001-one.json", "One"],
  ]);
  expect(Object.keys(zip.files).sort()).toEqual([
    "cast.json",
    "chapters/",
    "chapters/0001-one.json",
    "lexicon.json",
    "manifest.json",
  ]);

  const chapter = await read<ScriptFileChapter>("chapters/0001-one.json");
  const script = await api.request<{ segments: { text: string }[] }>(
    `/api/books/${id}/chapters/1/script`,
  );
  expect(chapter.sourceHash).toBe(manifest.chapters[0].sourceHash);
  expect(chapter.lines.map((l) => l.text)).toEqual(script.body.segments.map((s) => s.text));
  expect(JSON.stringify(chapter)).not.toContain('"audio"');

  const speakers = await read<ScriptFileSpeaker[]>("cast.json");
  expect(speakers.find((s) => s.name === mara.name)?.voice).toEqual({
    endpoint: "Studio speech",
    provider: "localhost:8880",
    voiceId: "ash",
    voiceLabel: "Ash",
  });
  expect(JSON.stringify(speakers)).not.toContain("studio/ash");
  expect(await read<ScriptFileTerm[]>("lexicon.json")).toEqual([
    { term: "Mara", say: "MAH-ra", enabled: true },
  ]);
});

describe("voice samples", () => {
  const fish: Endpoint = {
    ...studio,
    id: "fish",
    name: "Fish Audio",
    baseUrl: "https://api.fish.audio",
    voices: [{ id: "v1", gender: "f", label: "Mara (clone)" }],
  };
  // a WAV header is all a kept recording needs to be: nothing here decodes it
  const wav = (tag: string) =>
    new Uint8Array([...`RIFF\0\0\0\0WAVEfmt ${tag}`].map((c) => c.charCodeAt(0)));

  /** A scripted book whose one speaker is voiced by a clone with two recordings kept. */
  async function cloned() {
    const api = testApi();
    await api.request("/api/endpoints", {
      ...jsonBody({ endpoints: [fish], profiles: [], credentials: [] }),
      method: "PUT",
    });
    const { body } = await api.import<{ book: Book }>(
      await epubFile({
        title: "Moonlight Ledger",
        chapters: [{ title: "One", paragraphs: ["“We are short again,” said Mara.", ...story(1)] }],
      }),
    );
    const id = body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
    await api.runner.idle();
    const cast = (await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`)).body;
    const mara = cast.characters.find((c) => c.name !== "Narrator")!;
    await api.request(`/api/books/${id}/characters/${encodeURIComponent(mara.name)}`, {
      ...jsonBody({ ...mara, voice: "fish/v1" }),
      method: "PUT",
    });
    const recordings = [wav("one"), wav("two")];
    await keepSampleFiles(api.db, voiceFiles(api.voiceDir), {
      endpointId: "fish",
      voiceId: "v1",
      title: "Mara (clone)",
      attached: true,
      samples: recordings.map((r, i) => ({
        name: `take-${i + 1}.wav`,
        blob: new Blob([r]),
        format: "wav" as const,
      })),
    });
    const zipOf = async (query = "") =>
      JSZip.loadAsync(
        await (await api.fetch(`/api/books/${id}/script-export${query}`)).arrayBuffer(),
      );
    const summary = async () =>
      (await api.request<ScriptExportSamples>(`/api/books/${id}/script-export/samples`)).body;
    return { api, id, speaker: mara.name, recordings, zipOf, summary };
  }

  test("an export carries no recordings unless asked", async () => {
    const { zipOf } = await cloned();
    for (const query of ["", "?samples=0"]) {
      const zip = await zipOf(query);
      expect(Object.keys(zip.files).some((f) => f.startsWith("voices/"))).toBe(false);
      const cast = JSON.parse(await zip.file("cast.json")!.async("string")) as ScriptFileSpeaker[];
      expect(cast.every((c) => c.samples === undefined)).toBe(true);
    }
  });

  test("asked, it carries the clone's recordings as they were kept, listed in samples.json", async () => {
    const { speaker, recordings, zipOf, summary } = await cloned();
    const zip = await zipOf("?samples=1");
    const cast = JSON.parse(await zip.file("cast.json")!.async("string")) as ScriptFileSpeaker[];
    const folder = cast.find((c) => c.name === speaker)!.samples!;
    expect(folder).toMatch(/^voices\/[a-z0-9-]+\/$/);

    const record = JSON.parse(
      await zip.file(folder + "samples.json")!.async("string"),
    ) as ScriptFileVoice;
    expect(record).toEqual({
      format: "audiobook-studio/voice-samples",
      version: 1,
      title: "Mara (clone)",
      samples: [
        { file: "sample-1.wav", name: "take-1.wav", format: "wav" },
        { file: "sample-2.wav", name: "take-2.wav", format: "wav" },
      ],
    });
    for (const [i, r] of recordings.entries())
      expect(await zip.file(`${folder}sample-${i + 1}.wav`)!.async("uint8array")).toEqual(r);

    expect(await summary()).toEqual({
      voices: [
        {
          speaker,
          title: "Mara (clone)",
          count: 2,
          bytes: recordings.reduce((n, r) => n + r.length, 0),
        },
      ],
    });
  });

  test("recordings still waiting from an import go again, an older consent.json's listing with them", async () => {
    const api = testApi();
    const { body } = await api.import<{ book: Book }>(
      await epubFile({ title: "Ledger", chapters: [{ title: "One", paragraphs: story(1) }] }),
    );
    const id = body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.request(`/api/books/${id}/characters/Vex`, {
      ...jsonBody({
        name: "Vex",
        aliases: [],
        gender: "f",
        description: "",
        voice: null,
        style: "",
        color: "#f472b6",
        major: false,
      }),
      method: "PUT",
    });
    // the file they came in: Vex's clone lives on someone else's account, so only its recordings travel
    const carried = new JSZip();
    carried.file(
      "manifest.json",
      JSON.stringify({
        format: "audiobook-studio/script",
        version: 1,
        title: "Ledger",
        author: "",
        chapters: [],
      }),
    );
    carried.file(
      "cast.json",
      JSON.stringify([
        {
          name: "Vex",
          aliases: [],
          gender: "f",
          description: "",
          style: "",
          samples: "voices/vex/",
        },
      ]),
    );
    // an older export: the listing was called consent.json and carried two fields nothing reads now
    const original: ScriptFileVoice = {
      format: "audiobook-studio/voice-samples",
      version: 1,
      title: "Vex (clone)",
      samples: [{ file: "take.wav", name: "take.wav", format: "wav" }],
    };
    carried.file(
      "voices/vex/consent.json",
      JSON.stringify({ ...original, consentAt: "2026-09-12T10:00:00.000Z", consentText: "Yes." }),
    );
    carried.file("voices/vex/take.wav", wav("vex"));
    const form = new FormData();
    form.set(
      "file",
      new File([await carried.generateAsync({ type: "uint8array" })], "Theirs.script.zip"),
    );
    form.set("speakers", JSON.stringify(["Vex"]));
    expect(
      (await api.request(`/api/books/${id}/speaker-samples`, { method: "POST", body: form }))
        .status,
    ).toBe(201);

    const zip = await JSZip.loadAsync(
      await (await api.fetch(`/api/books/${id}/script-export?samples=1`)).arrayBuffer(),
    );
    const cast = JSON.parse(await zip.file("cast.json")!.async("string")) as ScriptFileSpeaker[];
    const folder = cast.find((c) => c.name === "Vex")!.samples!;
    expect(zip.file(folder + "consent.json")).toBeNull();
    expect(JSON.parse(await zip.file(folder + "samples.json")!.async("string"))).toEqual({
      ...original,
      samples: [{ file: "sample-1.wav", name: "take.wav", format: "wav" }],
    });
    expect(await zip.file(`${folder}sample-1.wav`)!.async("uint8array")).toEqual(wav("vex"));
    expect(
      (await api.request<ScriptExportSamples>(`/api/books/${id}/script-export/samples`)).body,
    ).toEqual({
      voices: [{ speaker: "Vex", title: "Vex (clone)", count: 1, bytes: wav("vex").length }],
    });
  });

  test.each([
    ["forgotten", { forgottenAt: 1 }],
    ["missing from the saved configuration", { missingSince: 1 }],
  ])("a clone whose recordings are %s is left out", async (_, set) => {
    const { api, zipOf, summary } = await cloned();
    api.db.update(clonedVoices).set(set).where(eq(clonedVoices.voiceId, "v1")).run();
    const zip = await zipOf("?samples=1");
    expect(Object.keys(zip.files).some((f) => f.startsWith("voices/"))).toBe(false);
    expect(await summary()).toEqual({ voices: [] });
  });
});
