// A book's script written out as `<book>.script.zip`: which chapter a script belongs to is told by
// the words of its source, and the file holds the script and nothing local to this install.
// See docs/script-transfer.md#the-file-and-the-export.
import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type {
  Book,
  Character,
  Endpoint,
  ScriptFileChapter,
  ScriptFileSpeaker,
  ScriptFileTerm,
  ScriptManifest,
} from "@/types";
import { sourceHash } from "~/script/transfer";
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
