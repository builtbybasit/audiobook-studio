// Reading a script file back: what `planScriptImport` makes of an upload before anything is written.
//
// Every test imports a real EPUB into a private database, then hands the planner a zip built here
// with the fingerprints of that book's own chapters — so what is checked is the reading, the
// matching and the diffs, never a fixture that agrees with itself. The planner writes nothing (the
// cast and dictionary's last test holds it to that), so the groups that only plan share one book;
// a group that puts a speaker, a term or an endpoint in first shelves a fresh one for each test.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import JSZip from "jszip";

import type {
  Book,
  Chapter,
  Character,
  Endpoint,
  FoundVoice,
  ScriptFileChapter,
  ScriptFileLine,
  ScriptFileSpeaker,
  ScriptFileTerm,
  ScriptManifest,
  VoiceMatch,
} from "@/types";
import { readCast, readLexicon, replaceLexicon, upsertCharacter } from "~/db/cast";
import { getChapterBody } from "~/db/library";
import { readScript } from "~/db/script";
import { plainText } from "~/epub/markdown";
import { AppError } from "~/lib/errors";
import type { VoiceLister, VoiceQuery } from "~/providers/voices";
import { planScriptImport, type ImportPorts } from "~/script/importPlan";
import { sourceHash } from "~/script/transfer";
import { SAMPLE_LIMITS } from "~/speakerSamples/folder";
import { epubFile } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";
import { claiming } from "../support/zip";

const MB = 1024 * 1024;

/** Three chapters whose words differ, so each has a fingerprint of its own. */
const prose = (n: number) => [
  `The lamp in room ${n} burned low while the clerk counted the ${n}th ledger.`,
  `“We are short again,” said Mara, closing ledger ${n}.`,
];

let api: TestApi;
let id: string;
let bodies: Map<number, string>;

async function shelve(titles = ["One", "Two", "Three"], text = (i: number) => prose(i + 1)) {
  api = testApi();
  const { body } = await api.import<{ book: Book; chapters: Chapter[] }>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: titles.map((title, i) => ({ title, paragraphs: text(i) })),
    }),
  );
  id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  bodies = new Map(body.chapters.map((c) => [c.id, getChapterBody(api.db, id, c.id)!]));
}

/** A chapter file for chapter `n` of the shelved book: its fingerprint, and its words as one line. */
function chapterOf(
  n: number,
  over: Partial<ScriptFileChapter> = {},
  text?: string,
): ScriptFileChapter {
  const body = bodies.get(n)!;
  const { hash, words } = sourceHash(body);
  return {
    format: "audiobook-studio/script-chapter",
    version: 1,
    title: `Chapter ${n}`,
    sourceHash: hash,
    words,
    lines: [{ speaker: "Narrator", type: "narration", text: text ?? plainText(body) }],
    ...over,
  };
}

const manifest = (chapters: ScriptFileChapter[] = []): ScriptManifest => ({
  format: "audiobook-studio/script",
  version: 1,
  title: "Moonlight Ledger",
  author: "A. Writer",
  chapters: chapters.map((c, i) => ({
    file: `chapters/${String(i + 1).padStart(4, "0")}.json`,
    title: c.title,
    sourceHash: c.sourceHash,
    words: c.words,
  })),
});

interface ZipInput {
  chapters?: ScriptFileChapter[];
  cast?: ScriptFileSpeaker[];
  lexicon?: ScriptFileTerm[];
  /** everything goes under this folder, the way Finder's Compress wraps it */
  wrap?: string;
  extra?: Record<string, string | Uint8Array>;
}

async function zipOf({ chapters = [], cast, lexicon, wrap = "", extra = {} }: ZipInput) {
  const zip = new JSZip();
  zip.file(`${wrap}manifest.json`, JSON.stringify(manifest(chapters)));
  if (cast) zip.file(`${wrap}cast.json`, JSON.stringify(cast));
  if (lexicon) zip.file(`${wrap}lexicon.json`, JSON.stringify(lexicon));
  chapters.forEach((c, i) =>
    zip.file(`${wrap}chapters/${String(i + 1).padStart(4, "0")}.json`, JSON.stringify(c)),
  );
  for (const [name, data] of Object.entries(extra)) zip.file(name, data);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const plan = async (bytes: Uint8Array, ports: ImportPorts = {}, name = "Moonlight.script.zip") =>
  planScriptImport(api.db, id, { name, bytes }, { voices: silent, ...ports });

const refusal = (e: unknown) => {
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
};

/** A lister that knows no voices at all, so no test reaches a provider by accident. */
const silent: VoiceLister = {
  list: async (_t, q) => ({ voices: [], total: 0, page: q.page ?? 1, hasMore: false }),
};

describe("reading the file", () => {
  beforeAll(() => shelve());

  test("a zip Finder wrapped in a folder, with its __MACOSX and .DS_Store, reads as if it were not", async () => {
    const got = await plan(
      await zipOf({
        chapters: [chapterOf(1)],
        wrap: "Moonlight/",
        extra: {
          "__MACOSX/Moonlight/._manifest.json": "junk",
          "Moonlight/.DS_Store": "junk",
          "Moonlight/chapters/._0001.json": "junk",
          "Moonlight/notes.txt": "mine",
        },
      }),
    );
    expect(got.chapters.map((c) => c.chapterId)).toEqual([1]);
    expect(got.title).toBe("Moonlight Ledger");
    // what a person put there is listed; what the Mac put there is not
    expect(got.ignored).toEqual(["notes.txt"]);
  });

  test.each([
    ["no manifest at all", { "chapters/0001.json": "{}" }, "That zip is not a script file"],
    [
      "two manifests at the same depth",
      {
        "a/manifest.json": JSON.stringify(manifest()),
        "b/manifest.json": JSON.stringify(manifest()),
      },
      "That zip holds more than one script",
    ],
  ])("%s is refused", async (_, files, message) => {
    const zip = new JSZip();
    for (const [name, data] of Object.entries(files)) zip.file(name, data);
    const e = await plan(await zip.generateAsync({ type: "uint8array" })).catch((e: unknown) => e);
    expect(refusal(e).message).toBe(message);
  });

  test("a zip that unzips past the limit on one document is refused by the shared guard", async () => {
    // a chapter that says it unzips to 33 MB, past the 32 MB limit on one document
    const zip = await zipOf({ extra: { "chapters/0001.json": "{}" } });
    const e = await plan(claiming(zip, "chapters/0001.json", 33 * MB)).catch((e: unknown) => e);
    expect(refusal(e).status).toBe(413);
    expect((e as AppError).message).toBe("A file inside that script file is too large to read");
  });

  test("one chapter's .json on its own is a one-chapter import", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(chapterOf(2)));
    const got = await plan(bytes, {}, "0002-two.json");
    expect(got.chapters.map((c) => [c.chapterId, c.file])).toEqual([[2, "0002-two.json"]]);
    expect(got.title).toBe("");
  });

  test.each([
    ["not JSON", () => "{ nope", "It is not valid JSON."],
    [
      "a line with no speaker",
      () => JSON.stringify({ ...chapterOf(1), lines: [{ type: "narration", text: "x" }] }),
      "lines.0.speaker",
    ],
    [
      "an unclosed marker",
      () => JSON.stringify(chapterOf(1, {}, "{sigh Don't move.")),
      "lines.0.text",
    ],
  ])(
    "a chapter file with %s is refused by name, and the rest still import",
    async (_, bad, detail) => {
      const zip = await zipOf({ chapters: [chapterOf(1)], extra: { "chapters/0009.json": bad() } });
      const got = await plan(zip);
      expect(got.chapters.map((c) => c.chapterId)).toEqual([1]);
      expect(got.refused).toHaveLength(1);
      expect(got.refused[0]).toMatchObject({ file: "chapters/0009.json", reason: "malformed" });
      expect(got.refused[0].detail).toContain(detail);
    },
  );

  test("a chapter whose zipped data is damaged is refused by name, not passed over as a stray file", async () => {
    const zip = await zipOf({
      chapters: [chapterOf(1)],
      extra: { "chapters/0009.json": JSON.stringify(chapterOf(2)) },
    });
    // Overwrite the start of that entry's deflated data, found past its local header.
    const name = new TextEncoder().encode("chapters/0009.json");
    const at = Buffer.from(zip).indexOf(Buffer.from(name)) + name.length;
    const view = new DataView(zip.buffer, zip.byteOffset);
    const extraLen = view.getUint16(at - name.length - 2, true);
    zip.fill(0xff, at + extraLen, at + extraLen + 8);
    const got = await plan(zip);
    expect(got.chapters.map((c) => c.chapterId)).toEqual([1]);
    expect(got.ignored).toEqual([]);
    expect(got.refused).toEqual([
      expect.objectContaining({
        file: "chapters/0009.json",
        reason: "malformed",
        detail: expect.stringContaining("could not be unzipped"),
      }),
    ]);
  });
});

describe("matching chapters", () => {
  beforeAll(() => shelve());

  test("pairs on the words of the source, not the title or the number", async () => {
    // The file was made from a copy numbered and titled differently: its chapter 3 is our 1.
    const got = await plan(
      await zipOf({
        chapters: [
          chapterOf(3, { title: "Chapter Three (revised)" }),
          chapterOf(1, { title: "Prologue" }),
        ],
      }),
    );
    expect(got.chapters.map((c) => [c.chapterId, c.title, c.fileTitle])).toEqual([
      [1, "One", "Prologue"],
      [3, "Three", "Chapter Three (revised)"],
    ]);
  });

  test("one changed word in the source refuses that chapter", async () => {
    const theirs = sourceHash(bodies.get(2)!.replace("closing", "opening"));
    const got = await plan(await zipOf({ chapters: [chapterOf(2, { sourceHash: theirs.hash })] }));
    expect(got.chapters).toEqual([]);
    expect(got.refused.map((r) => r.reason)).toEqual(["unmatched"]);
  });

  test("an honest correction passes the check on the lines; a rewritten chapter does not", async () => {
    const body = plainText(bodies.get(1)!);
    const corrected = await plan(
      await zipOf({ chapters: [chapterOf(1, {}, body.replace("burned", "burnt"))] }),
    );
    expect(corrected.chapters).toHaveLength(1);
    const rewritten = await plan(
      await zipOf({
        chapters: [chapterOf(1, {}, "Something else happened entirely, in other words.")],
      }),
    );
    expect(rewritten.chapters).toEqual([]);
    expect(rewritten.refused[0].reason).toBe("fidelity");
  });

  test("lines become segments numbered afresh, with no audio and the markers read back", async () => {
    const [text] = plainText(bodies.get(1)!).split(" ");
    const lines: ScriptFileLine[] = [
      { speaker: "Narrator", type: "narration", text: `${text} {sigh}`, pause: 0.5, sep: "\n\n" },
      {
        speaker: "Mara",
        type: "dialogue",
        text: plainText(bodies.get(1)!).slice(text.length + 1),
        direction: "tired",
        edited: true,
      },
    ];
    const got = await plan(await zipOf({ chapters: [chapterOf(1, { lines })] }));
    const [a, b] = got.chapters[0].segments;
    expect(a).toMatchObject({ id: 1, text: `${text} `, pause: 0.5, sep: "\n\n" });
    expect(a.audio).toEqual({ status: "none", endpoint: null, ms: 0, duration: 0 });
    // no endpoint here offers `sigh`, so it arrives for someone to look at rather than dropped
    expect(a.expressions).toMatchObject([{ id: "sigh", at: text.length + 1, needsReview: true }]);
    expect(b).toMatchObject({ id: 2, speaker: "Mara", direction: "tired", edited: true });
  });
});

describe("two chapters with the same words", () => {
  // the chapter's heading is part of its words, so the two notes share a title as well
  beforeAll(() => shelve(["Note", "Story", "Note"], (i) => (i === 1 ? prose(9) : prose(0))));

  test("pair in reading order", async () => {
    const a = chapterOf(1, { title: "first note" });
    const b = chapterOf(3, { title: "second note" });
    expect(a.sourceHash).toBe(b.sourceHash);
    const got = await plan(await zipOf({ chapters: [a, b] }));
    expect(got.chapters.map((c) => [c.chapterId, c.fileTitle])).toEqual([
      [1, "first note"],
      [3, "second note"],
    ]);
  });
});

describe("the cast and the dictionary", () => {
  beforeEach(() => shelve());

  const speaker = (over: Partial<ScriptFileSpeaker>): ScriptFileSpeaker => ({
    name: "Mara",
    aliases: [],
    gender: "f",
    description: "",
    style: "",
    ...over,
  });
  const have = (c: Partial<Character>) =>
    upsertCharacter(api.db, id, {
      name: "Mara",
      aliases: [],
      gender: "f",
      description: "",
      style: "",
      voice: null,
      color: "#000",
      major: false,
      ...c,
    });

  test("adds who the book lacks, keeps who it has, and unions their aliases", async () => {
    have({ description: "the clerk's sister", aliases: ["Mar"] });
    const got = await plan(
      await zipOf({
        cast: [
          speaker({ description: "a clerk", aliases: ["Mar", "Miss Mara"] }),
          speaker({ name: "Tobin", gender: "m" }),
        ],
      }),
    );
    expect(got.cast.add.map((s) => s.name)).toEqual(["Tobin"]);
    expect(got.cast.differ).toEqual([
      {
        name: "Mara",
        book: { gender: "f", description: "the clerk's sister", style: "" },
        file: { gender: "f", description: "a clerk", style: "" },
      },
    ]);
    expect(got.cast.aliases).toEqual([{ name: "Mara", add: ["Miss Mara"] }]);
  });

  test("adds the terms the book lacks and lists the ones it spells differently", async () => {
    replaceLexicon(api.db, id, [{ id: 1, term: "Aeloria", say: "ay-LOR-ee-ah", enabled: true }]);
    const got = await plan(
      await zipOf({
        lexicon: [
          { term: "Aeloria", say: "ay-LOR-ya", enabled: true },
          { term: "Tobin", say: "TOE-bin", enabled: true },
        ],
      }),
    );
    expect(got.lexicon.add.map((t) => t.term)).toEqual(["Tobin"]);
    expect(got.lexicon.differ).toEqual([
      {
        term: "Aeloria",
        book: { say: "ay-LOR-ee-ah", enabled: true },
        file: { say: "ay-LOR-ya", enabled: true },
      },
    ]);
  });

  test("nothing is written: not the script, not the cast, not the dictionary", async () => {
    have({});
    const before = [readScript(api.db, id, 1), readCast(api.db, id), readLexicon(api.db, id)];
    await plan(
      await zipOf({
        chapters: [chapterOf(1)],
        cast: [speaker({ name: "Tobin" }), speaker({ description: "changed" })],
        lexicon: [{ term: "Tobin", say: "TOE-bin", enabled: true }],
      }),
    );
    expect([readScript(api.db, id, 1), readCast(api.db, id), readLexicon(api.db, id)]).toEqual(
      before,
    );
  });
});

describe("voices", () => {
  beforeEach(() => shelve());

  const endpoint = (over: Partial<Endpoint>): Endpoint => ({
    id: "fish",
    name: "Fish Audio",
    baseUrl: "https://api.fish.audio/v1",
    model: "s2.1-pro",
    concurrency: 1,
    enabled: true,
    latency: 0,
    failRate: 0,
    price: 0,
    needsKey: true,
    maxChars: 0,
    splitAt: "sentence",
    voices: [],
    history: [],
    failures: 0,
    rateLimits: 0,
    backoffUntil: 0,
    ...over,
  });
  const save = (endpoints: Endpoint[]) =>
    api.request("/api/endpoints", {
      ...jsonBody({ endpoints, profiles: [], credentials: [] }),
      method: "PUT",
    });
  const hint = (voiceId: string, voiceLabel = "Sera") => ({
    endpoint: "Their Fish",
    provider: "api.fish.audio",
    voiceId,
    voiceLabel,
  });
  const withVoice = (name: string, voiceId: string, voiceLabel?: string): ScriptFileSpeaker => ({
    name,
    aliases: [],
    gender: "?",
    description: "",
    style: "",
    voice: hint(voiceId, voiceLabel),
  });
  /** A lister that finds `found` by id in Fish's public catalogue, and nothing in a library. */
  const publicOnly = (found: FoundVoice[]): VoiceLister => ({
    list: async (_t, q: VoiceQuery) => ({
      voices: q.source === "public" ? found.filter((v) => v.id === q.query) : [],
      total: 0,
      page: 1,
      hasMore: false,
    }),
  });

  const here: VoiceMatch = {
    kind: "here",
    options: [{ endpointId: "fish", endpointName: "Fish Audio", ref: "fish/v1" }],
  };
  const privateVoice: VoiceMatch = { kind: "private" };

  test.each<[string, Endpoint["voices"], boolean, VoiceMatch]>([
    [
      "the same id and label on an enabled endpoint is here",
      [{ id: "v1", label: "Sera", gender: "f" }],
      true,
      here,
    ],
    [
      "the same id under another label is someone else",
      [{ id: "v1", label: "Doran", gender: "m" }],
      true,
      privateVoice,
    ],
    [
      "the voice on a disabled endpoint is not offered",
      [{ id: "v1", label: "Sera", gender: "f" }],
      false,
      privateVoice,
    ],
  ])("%s", async (_, voices, enabled, match) => {
    await save([endpoint({ voices, enabled })]);
    const got = await plan(await zipOf({ cast: [withVoice("Tobin", "v1")] }));
    expect(got.voices.map((r) => r.match)).toEqual([match]);
  });

  /** A lister that answers `found` as the account's own library, and nothing in public. */
  const libraryOnly = (found: FoundVoice[]): VoiceLister => ({
    list: async (_t, q: VoiceQuery) => ({
      voices: q.source === "library" ? found : [],
      total: 0,
      page: 1,
      hasMore: false,
    }),
  });
  const sera = { id: "a".repeat(32), label: "Sera", gender: "f" as const };
  const publicSera: VoiceMatch = {
    kind: "public",
    endpointId: "fish",
    endpointName: "Fish Audio",
    voice: sera,
  };

  test.each([
    ["Fish's public catalogue", "Sera", publicOnly, publicSera],
    ["the account's own library", "Sera", libraryOnly, publicSera],
    ["the account's own library", "Doran", libraryOnly, privateVoice],
  ] as const)("a voice found in %s, under the label %s", async (_, label, lister, match) => {
    await save([endpoint({})]);
    const got = await plan(await zipOf({ cast: [withVoice("Tobin", sera.id, label)] }), {
      voices: lister([{ ...sera, sample: { url: "x", text: "y" } }]),
    });
    expect(got.voices[0].match).toEqual(match);
  });

  test.each([
    ["refuses", { list: () => Promise.reject(new Error("no key")) }, "no key"],
    ["never answers", { list: () => new Promise(() => {}) }, "ran out of time"],
  ] as [string, VoiceLister, string][])(
    "a provider that %s leaves the voice unchecked and unticked, not private, and the import stands",
    async (_, voices, reason) => {
      await save([endpoint({})]);
      const got = await plan(await zipOf({ cast: [withVoice("Tobin", "v9")] }), {
        voices,
        lookupMs: 5,
      });
      expect(got.voices[0].match).toEqual({
        kind: "unchecked",
        reason: expect.stringContaining(reason),
      });
      expect(got.voices[0].ticked).toBe(false);
    },
  );

  test("only a new speaker or one on the Narrator's voice starts ticked, and never a private clone", async () => {
    await save([endpoint({ voices: [{ id: "v1", label: "Sera", gender: "f" }] })]);
    const base = {
      aliases: [],
      gender: "f" as const,
      description: "",
      style: "",
      color: "#000",
      major: false,
    };
    upsertCharacter(api.db, id, { ...base, name: "Mara", voice: "fish/other" });
    upsertCharacter(api.db, id, { ...base, name: "Ines", voice: null });
    const got = await plan(
      await zipOf({
        cast: [
          withVoice("Mara", "v1"),
          withVoice("Ines", "v1"),
          withVoice("Tobin", "v1"),
          withVoice("Vex", "clone"),
        ],
      }),
    );
    expect(got.voices.map((r) => [r.speaker, r.isNew, r.current, r.ticked])).toEqual([
      ["Mara", false, "fish/other", false],
      ["Ines", false, null, true],
      ["Tobin", true, null, true],
      ["Vex", true, null, false],
    ]);
  });
});

describe("voice samples in the file", () => {
  beforeAll(() => shelve());

  // a WAV header is all a recording needs to be here: it is sniffed, never decoded
  const wav = (tag: string) =>
    new Uint8Array([...`RIFF\0\0\0\0WAVEfmt ${tag}`].map((c) => c.charCodeAt(0)));
  const CONSENT_AT = "2026-09-12T10:00:00.000Z";
  const consent = (
    samples = [{ file: "sample-1.wav", name: "take-1.wav", format: "wav" }],
    over: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      format: "audiobook-studio/voice-samples",
      version: 1,
      title: "Vex (clone)",
      consentAt: CONSENT_AT,
      consentText: "This is my voice.",
      samples,
      ...over,
    });
  const vex: ScriptFileSpeaker = {
    name: "Vex",
    aliases: [],
    gender: "f",
    description: "",
    style: "",
    voice: {
      endpoint: "Fish Audio",
      provider: "api.fish.audio",
      voiceId: "clone",
      voiceLabel: "Vex (clone)",
    },
    samples: "voices/vex/",
  };
  const one = { "voices/vex/consent.json": consent(), "voices/vex/sample-1.wav": wav("one") };

  test("a voice whose recordings come with it says how many, how big, and under what consent", async () => {
    const got = await plan(
      await zipOf({
        chapters: [chapterOf(1)],
        cast: [vex],
        wrap: "Ledger/",
        extra: {
          "Ledger/voices/vex/consent.json": consent(),
          "Ledger/voices/vex/sample-1.wav": wav("one"),
        },
      }),
    );
    expect(got.voices).toHaveLength(1);
    expect(got.voices[0]).toMatchObject({
      speaker: "Vex",
      match: { kind: "private" },
      samples: {
        kind: "ok",
        count: 1,
        bytes: wav("one").length,
        consentAt: CONSENT_AT,
        consentText: "This is my voice.",
      },
    });
    expect(got.ignored).toEqual([]);
  });

  test.each<[string, Record<string, string | Uint8Array>, Partial<typeof SAMPLE_LIMITS>, RegExp]>([
    [
      "a recording that is not audio",
      { ...one, "voices/vex/sample-1.wav": "not a recording" },
      {},
      /sample-1\.wav is not a WAV/,
    ],
    ["no consent record", { "voices/vex/sample-1.wav": wav("one") }, {}, /no consent\.json/],
    [
      "a consent record with no consent in it",
      { ...one, "voices/vex/consent.json": consent(undefined, { consentText: " " }) },
      {},
      /consentText/,
    ],
    [
      "a recording named but not in the folder",
      { "voices/vex/consent.json": consent([{ file: "gone.wav", name: "", format: "wav" }]) },
      {},
      /gone\.wav is named in consent\.json but is not in voices\/vex\//,
    ],
    ["a recording over the limit on one", one, { clip: 8 }, /over the 0\.0 MB limit on one/],
    [
      "more recordings than a voice is cloned from",
      {
        "voices/vex/consent.json": consent([
          { file: "a.wav", name: "", format: "wav" },
          { file: "b.wav", name: "", format: "wav" },
        ]),
        "voices/vex/a.wav": wav("a"),
        "voices/vex/b.wav": wav("b"),
      },
      { clips: 1 },
      /2 recordings, over the 1/,
    ],
    [
      "recordings over the limit for one voice",
      one,
      { voice: 8 },
      /over 0\.0 MB, the limit for one voice/,
    ],
  ])("%s refuses that voice's recordings, and nothing else", async (_, extra, limits, reason) => {
    const got = await plan(await zipOf({ chapters: [chapterOf(1)], cast: [vex], extra }), {
      sampleLimits: { ...SAMPLE_LIMITS, ...limits },
    });
    expect(got.voices[0].samples).toEqual({
      kind: "refused",
      reason: expect.stringMatching(reason),
    });
    expect(got.chapters.map((c) => c.chapterId)).toEqual([1]);
    expect(got.refused).toEqual([]);
    expect(got.cast.add.map((c) => c.name)).toEqual(["Vex"]);
  });

  test("a folder of recordings no speaker names is a stray, listed as ignored", async () => {
    const got = await plan(await zipOf({ cast: [{ ...vex, samples: undefined }], extra: one }));
    expect(got.voices[0].samples).toBeUndefined();
    expect(got.ignored).toEqual(["voices/vex/consent.json", "voices/vex/sample-1.wav"]);
  });
});
