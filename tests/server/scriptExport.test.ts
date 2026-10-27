// A book's script written out as `<book>.script.zip`: which chapter a script belongs to is told by
// the words of its source, and the file holds the script and nothing local to this install.
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { eq } from "drizzle-orm";
import JSZip from "jszip";

import type {
  Book,
  ChapterScript,
  Character,
  CharacterVoice,
  Effect,
  Endpoint,
  ScriptFileChapter,
  ScriptFileSpeaker,
  ScriptExportSamples,
  ScriptFileTerm,
  ScriptFileVoice,
  ScriptManifest,
} from "@/types";
import { previousRecap } from "~/db/library";
import { clonedVoices } from "~/db/schema";
import { NEW_EFFECT } from "@/lib/scriptFile";
import { planScriptImport } from "~/script/importPlan";
import { readCarried } from "~/db/voiceSamples";
import { sourceHash } from "~/script/transfer";
import { keepSampleFiles } from "~/voices/ops";
import { voiceFiles } from "~/voices/files";
import { epubFile, story } from "../support/epub";
import { jsonBody, saveEndpoints, speechEndpoint, testApi, voicedBook } from "../support/server";

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
    ...jsonBody({ ...mara, voice: "studio/ash", speed: 1.25 }),
    method: "PUT",
  });
  // a persona of hers, carried by name, at her voice's own pace
  await api.request(`/api/books/${id}/characters/${encodeURIComponent("The Mask")}`, {
    ...jsonBody({
      ...mara,
      name: "The Mask",
      voice: null,
      personaOf: mara.name,
      masked: true,
      age: "teen",
      voiceType: { pitch: "low", delivery: ["sly"] },
      wiki: { url: "https://w.test/wiki/Mask", at: 1 },
      speed: 1,
    }),
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
    "book.json",
    "cast.json",
    "chapters/",
    "chapters/0001-one.json",
    "effects.json",
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
  // the link stays behind its spoiler on the other side
  expect(speakers.find((s) => s.name === "The Mask")).toMatchObject({
    personaOf: mara.name,
    masked: true,
    age: "teen",
    voiceType: { pitch: "low", delivery: ["sly"] },
    wiki: { url: "https://w.test/wiki/Mask", at: 1 },
  });
  expect(speakers.find((s) => s.name === mara.name)?.personaOf).toBeUndefined();
  expect(speakers.find((s) => s.name === mara.name)?.speed).toBe(1.25);
  expect(speakers.find((s) => s.name === "The Mask")?.speed).toBe(1);
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
  const wav = (tag: string) => new TextEncoder().encode(`RIFF\0\0\0\0WAVEfmt ${tag}`);

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
    // the file they came in: Vex's clone is on another account, so only its recordings travel
    const carried = new JSZip();
    carried.file(
      "manifest.json",
      JSON.stringify({
        format: "audiobook-studio/script",
        version: 2,
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
    // an older export's consent.json listing, with two fields nothing reads now
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

  test("a kept recording gone from disk is left out of the export and of its count alike", async () => {
    const { api, speaker, recordings, zipOf, summary } = await cloned();
    const [first] = readCarried(api.db, "fish", "v1")!.samples;
    rmSync(voiceFiles(api.voiceDir).path("fish", "v1", first.file)!);

    const zip = await zipOf("?samples=1");
    const cast = JSON.parse(await zip.file("cast.json")!.async("string")) as ScriptFileSpeaker[];
    const folder = cast.find((c) => c.name === speaker)!.samples!;
    const record = JSON.parse(
      await zip.file(folder + "samples.json")!.async("string"),
    ) as ScriptFileVoice;
    const { voices } = await summary();
    expect(voices.map((v) => v.count)).toEqual([record.samples.length]);
    expect(record.samples.length).toBe(recordings.length - 1);
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

test("a round trip carries line effects, speakers' effects, recaps and the book's own settings", async () => {
  const api = testApi();
  const paragraphs = ["“We are short again,” said Mara.", ...story(2)];
  const withBea = speechEndpoint({
    voices: [...speechEndpoint().voices, { id: "bea", gender: "f", label: "Bea" }],
  });
  const characterVoice: CharacterVoice = {
    by: "one",
    one: "studio/ash",
    male: null,
    female: null,
    other: null,
  };
  // one-voice mode keeps its age voices, so they travel too
  const girl = { slot: "female", age: "child", voice: "studio/ash" } as const;
  const oldMan = { slot: "male", age: "elderly", voice: "studio/bea" } as const;
  const id = await voicedBook(api, {
    endpoints: [withBea],
    paragraphs,
    voiceOf: "studio/ash",
    chapters: ["One", "Two"],
  });
  const phone = (
    await api.request<{ effect: Effect }>(
      "/api/effects",
      jsonBody({
        name: "Phone",
        chain: [{ plugin: "HighpassFilter", params: { cutoff_frequency_hz: 300 }, on: true }],
      }),
    )
  ).body.effect;
  const put = (book: string, body: unknown) =>
    api.request(`/api/books/${book}/chapters/1/script`, { ...jsonBody(body), method: "PUT" });
  const script = (await api.request<ChapterScript>(`/api/books/${id}/chapters/1/script`)).body;
  const [first, ...rest] = script.segments;
  await put(id, {
    segments: [{ ...first, effects: [phone.id] }, ...rest],
    ifRevision: script.revision,
    recap: "Mara counts the shortfall.",
  });
  const cast = (await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`)).body;
  const mara = cast.characters.find((c) => c.name !== "Narrator")!;
  await api.request(`/api/books/${id}/characters/${encodeURIComponent(mara.name)}`, {
    ...jsonBody({ ...mara, effect: phone.id, thoughts: "none" }),
    method: "PUT",
  });
  const pacing = { line: 0.4, turn: 0.9, inlineShort: 0.3, inlineLong: 1 };
  await api.request(`/api/books/${id}`, {
    ...jsonBody({
      pacing,
      readNotes: true,
      thoughts: "inner-voice",
      characterVoice: { ...characterVoice, ages: [girl, oldMan] },
    }),
    method: "PATCH",
  });
  const bytes = new Uint8Array(
    await (await api.fetch(`/api/books/${id}/script-export`)).arrayBuffer(),
  );

  // read back into the book it came from, its settings are no choice to offer
  expect(
    (await planScriptImport(api.db, id, { name: "Ledger.script.zip", bytes })).book,
  ).toBeUndefined();

  // the install it lands on has no Phone or Bea, and a fresh copy of the book
  await api.request(`/api/effects/${phone.id}`, { method: "DELETE" });
  await saveEndpoints(api, [speechEndpoint()]);
  const copy = (
    await api.import<{ book: Book }>(
      await epubFile({ chapters: ["One", "Two"].map((title) => ({ title, paragraphs })) }),
    )
  ).body.book.id;
  await api.request(`/api/books/${copy}/confirm`, { method: "POST" });
  const plan = await planScriptImport(api.db, copy, { name: "Ledger.script.zip", bytes });

  expect(plan.effects.add.map((e) => e.name)).toEqual(["Phone"]);
  expect(plan.effects.known).toEqual([{ name: "Inner voice", id: "inner-voice", sameChain: true }]);
  expect(plan.effects.missing).toEqual([]);
  const [line] = plan.chapters[0].segments;
  expect(line.effects).toEqual([NEW_EFFECT + "Phone"]);
  expect(plan.cast.add.find((s) => s.name === mara.name)).toMatchObject({
    effect: "Phone",
    thoughts: "none",
  });
  expect(plan.book?.file).toEqual({
    pacing,
    readNotes: true,
    thoughts: "Inner voice",
    characterVoice: { ...characterVoice, ages: [girl] },
    unmatchedVoices: [{ slot: "male", age: "elderly" }],
  });
  expect(new Set(plan.book?.differ)).toEqual(
    new Set(["pacing", "readNotes", "thoughts", "characterVoice"]),
  );

  // the recap lands with the script, where the next chapter's run reads it
  const recap = plan.chapters[0].recap;
  expect(recap).toBe("Mara counts the shortfall.");
  // and the copy's own, which an Undo writes back
  expect(plan.chapters[0].recapBefore).toBe("");
  const theirs = (await api.request<ChapterScript>(`/api/books/${copy}/chapters/1/script`)).body;
  const res = await put(copy, {
    segments: plan.chapters[0].segments.map(({ effects: _new, ...s }) => s),
    ifRevision: theirs.revision,
    recap,
  });
  expect(res.status).toBe(200);
  expect(previousRecap(api.db, copy, 2)).toBe(recap!);
});
