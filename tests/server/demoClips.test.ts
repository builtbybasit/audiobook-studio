// The demo's clips are made the first time something reads them; the real library's never are.
//
// The demo is seeded with thousands of narrated lines whose files were never written, each clip row
// holding a url in the demo's usual form. These tests write such rows themselves — a book imported
// into each library, and a script written straight into its database with clips whose files do not
// exist — so what is proved is the seam, whatever the seed happens to hold: the route serves a tone
// as long as the row says, made once however many ask at once; a build stitches clips nobody has
// played; and a name no clip holds, or a clip of the real library's that is not on disk, is the 404
// it always was.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Book, ExportItem, Segment } from "@/types";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { demoClips } from "~/audio/demoClips";
import { audioFiles, type MakeClip } from "~/audio/files";
import { writeScript } from "~/db/script";
import { settleChapter } from "~/narration/chapter";
import { DEMO_BASE, openLibrary, REAL_BASE, type Library } from "~/libraries";
import { SAMPLE_RATE, toneOf, toneWav } from "~/providers/fakeSpeech";
import { byteRate, readWavHeader, wavEncoders } from "~/providers/wavEncoder";
import type { Providers } from "~/providers/target";
import { epubFile, story } from "../support/epub";
import {
  collectingLogger,
  jsonBody,
  tempAudioDir,
  tempExportDir,
  tempVoiceDir,
} from "../support/server";

/** Nothing here scripts or narrates, so a provider asked for anything fails the test. */
const refuse = () => Promise.reject(new Error("a test of clip files asked a provider for work"));
const noProviders = {
  scripting: { name: "none", script: refuse },
  speech: { name: "none", speak: refuse },
} as unknown as Providers;

interface Opened extends Library {
  audioDir: string;
}

function open(name: string, base: string, demo: boolean): Opened {
  const audioDir = tempAudioDir();
  const library = openLibrary({
    name,
    base,
    databaseUrl: ":memory:",
    audioDir,
    exportDir: tempExportDir(),
    voiceDir: tempVoiceDir(),
    encoders: wavEncoders(),
    log: collectingLogger().log,
    providers: noProviders,
    demo,
  });
  return Object.assign(library, { audioDir });
}

// One of each for the file: the demo's seed is the whole browser world, and every test here works
// in a book of its own.
const demo = open("demo", DEMO_BASE, true);
const real = open("real", REAL_BASE, false);

const get = (library: Library, path: string, init?: RequestInit) =>
  library.app.request(`http://api.test${path}`, init);

/** A one-chapter book, through its contents review. */
async function shelved(library: Library): Promise<string> {
  const form = new FormData();
  form.set("file", await epubFile({ chapters: [{ title: "One", paragraphs: story(1) }] }));
  const res = await get(library, `${library.base}/books/import`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  const { book } = (await res.json()) as { book: Book };
  await get(library, `${library.base}/books/${book.id}/confirm`, { method: "POST" });
  return book.id;
}

interface Line {
  speaker: string;
  duration: number;
  sampleRate?: number;
}

/**
 * Chapter 1 of a new book, narrated as the seed narrates it: a clip row for every line, with a url
 * in the library's usual form, and no file behind any of them.
 */
async function unmade(
  library: Library,
  lines: Line[],
): Promise<{ bookId: string; urls: string[] }> {
  const bookId = await shelved(library);
  const segs: Segment[] = lines.map((l, i) => ({
    id: i + 1,
    type: "narration",
    speaker: l.speaker,
    text: `Line ${i + 1}.`,
    direction: "",
    audio: {
      status: "done",
      endpoint: "simulated",
      ms: 0,
      duration: l.duration,
      url: `${library.base}/audio/${bookId}/${crypto.randomUUID()}.wav`,
      ...(l.sampleRate ? { sampleRate: l.sampleRate } : {}),
    },
  }));
  writeScript(library.db, bookId, 1, segs);
  library.db.transaction((tx) => settleChapter(tx, bookId, 1));
  return { bookId, urls: segs.map((s) => s.audio.url!) };
}

/** What is on disk in a book's clip folder; nothing when the folder was never made. */
const onDisk = (library: Opened, bookId: string): string[] => {
  const dir = join(library.audioDir, bookId);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

const fileOf = (url: string) => url.split("/").at(-1)!;

const bytesOf = async (res: Response): Promise<Uint8Array> =>
  new Uint8Array(await res.arrayBuffer());

/** How long a WAV plays, from its own header. */
const secondsOf = (bytes: Uint8Array): number => {
  const body = readWavHeader(bytes);
  return body.length / byteRate(body);
};

describe("a demo clip whose file was never written", () => {
  test("is served as the speaker's tone, as long as its row says, at the rate its row says", async () => {
    const { urls } = await unmade(demo, [
      { speaker: "Narrator", duration: 2.5 },
      { speaker: "Mara", duration: 1.25, sampleRate: 16000 },
    ]);
    for (const [url, rate, seconds] of [
      [urls[0], SAMPLE_RATE, 2.5],
      [urls[1], 16000, 1.25],
    ] as const) {
      const res = await get(demo, url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("audio/wav");
      const bytes = await bytesOf(res);
      expect(readWavHeader(bytes).sampleRate).toBe(rate);
      expect(secondsOf(bytes)).toBeCloseTo(seconds, 3);
    }
    // the tone is the one a simulated endpoint answers the same speaker with
    const bytes = await bytesOf(await get(demo, urls[0]));
    expect(bytes).toEqual(toneWav(toneOf("Narrator"), 2.5, SAMPLE_RATE));
  });

  test("answers a player's Range from the start, as a clip written by a run does", async () => {
    const { urls } = await unmade(demo, [{ speaker: "Narrator", duration: 1 }]);
    const res = await get(demo, urls[0], { headers: { range: "bytes=40-59" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 40-59/${44 + SAMPLE_RATE}`);
    expect((await res.arrayBuffer()).byteLength).toBe(20);
  });

  test("is made once: a second request is served the same file, not a new one", async () => {
    const { bookId, urls } = await unmade(demo, [{ speaker: "Narrator", duration: 1 }]);
    const first = await bytesOf(await get(demo, urls[0]));
    const path = join(demo.audioDir, bookId, fileOf(urls[0]));
    const made = statSync(path);
    const again = await bytesOf(await get(demo, urls[0]));
    expect(again).toEqual(first);
    // a file written again would be a new one renamed into place
    expect(statSync(path).ino).toBe(made.ino);
    expect(statSync(path).mtimeMs).toBe(made.mtimeMs);
  });

  test("asked for by many at once is one file, whole for every one of them", async () => {
    const { bookId, urls } = await unmade(demo, [{ speaker: "Mara", duration: 3 }]);
    const answers = await Promise.all(Array.from({ length: 8 }, () => get(demo, urls[0])));
    const bodies = await Promise.all(answers.map(bytesOf));
    expect(answers.map((r) => r.status)).toEqual(Array(8).fill(200));
    for (const b of bodies) expect(b).toEqual(toneWav(toneOf("Mara"), 3, SAMPLE_RATE));
    // and nothing half-written left beside it
    expect(onDisk(demo, bookId)).toEqual([fileOf(urls[0])]);
  });

  test("is only made for a name a clip holds: any other is a 404, and nothing is written", async () => {
    const { bookId, urls } = await unmade(demo, [{ speaker: "Narrator", duration: 1 }]);
    const stranger = `${DEMO_BASE}/audio/${bookId}/${crypto.randomUUID()}.wav`;
    expect((await get(demo, stranger)).status).toBe(404);
    // the clip's own name under another book is not the clip
    const other = await shelved(demo);
    expect((await get(demo, `${DEMO_BASE}/audio/${other}/${fileOf(urls[0])}`)).status).toBe(404);
    expect(onDisk(demo, bookId)).toEqual([]);
    expect(onDisk(demo, other)).toEqual([]);
  });

  test("is stitched by a build that reaches it before any player has", async () => {
    const lines = [
      { speaker: "Narrator", duration: 1.5 },
      { speaker: "Mara", duration: 0.75 },
      { speaker: "Narrator", duration: 2 },
    ];
    const { bookId, urls } = await unmade(demo, lines);
    expect(onDisk(demo, bookId)).toEqual([]);

    const queued = await get(
      demo,
      `${DEMO_BASE}/books/${bookId}/exports`,
      jsonBody({ ids: [1], settings: DEFAULT_EXPORT_SETTINGS }),
    );
    expect(queued.status).toBe(202);
    await demo.runner.idle();
    const listed = await get(demo, `${DEMO_BASE}/books/${bookId}/exports`);
    const [built] = ((await listed.json()) as { exports: ExportItem[] }).exports;
    expect(built.status).toBe("done");
    expect(onDisk(demo, bookId)).toEqual(urls.map(fileOf).sort());
  });
});

describe("the real library", () => {
  test("makes no file a clip names and it does not have: that is a 404, as it always was", async () => {
    const { bookId, urls } = await unmade(real, [{ speaker: "Narrator", duration: 1 }]);
    expect(urls[0].startsWith(`${REAL_BASE}/audio/`)).toBe(true);
    expect((await get(real, urls[0])).status).toBe(404);
    expect(onDisk(real, bookId)).toEqual([]);
  });
});

describe("audio files that can make a clip", () => {
  /** Files over a maker that counts how often it is asked, and answers every url with a tone. */
  function counted() {
    const asked: string[] = [];
    const make: MakeClip = (_bookId, url) => {
      asked.push(url);
      return toneWav(220, 0.5);
    };
    return { asked, files: audioFiles(tempAudioDir(), DEMO_BASE, make) };
  }
  const BOOK = "a-book";
  const FILE = `${crypto.randomUUID()}.wav`;

  test("ask for a missing file once, however many are waiting on it", async () => {
    const { asked, files } = counted();
    const paths = await Promise.all(Array.from({ length: 10 }, () => files.ready(BOOK, FILE)));
    expect(new Set(paths)).toEqual(new Set([files.path(BOOK, FILE)]));
    expect(asked).toEqual([`${DEMO_BASE}/audio/${BOOK}/${FILE}`]);
    await files.ready(BOOK, FILE);
    expect(asked.length).toBe(1);
  });

  test("never ask for a name that cannot be a file", async () => {
    const { asked, files } = counted();
    expect(await files.ready(BOOK, "../evil.wav")).toBeNull();
    expect(await files.ready("../etc", FILE)).toBeNull();
    expect(asked).toEqual([]);
  });

  test("the demo's maker makes nothing but a WAV a clip row holds", () => {
    const make = demoClips(demo.db);
    expect(make("no-such-book", `${DEMO_BASE}/audio/no-such-book/${FILE}`)).toBeNull();
    expect(
      make("no-such-book", `${DEMO_BASE}/audio/no-such-book/${FILE.replace(".wav", ".mp3")}`),
    ).toBeNull();
  });
});
