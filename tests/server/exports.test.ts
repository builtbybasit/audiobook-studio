// Finished audiobooks over HTTP: built, listed, downloaded and removed. Building drives the real
// runner and encoder and checks the file that comes out.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

import type { Book, Chapter, ExportItem, ExportSettings, Job } from "@/types";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { makeWorld } from "~/demo/seed/world";
import { exportFileToken } from "~/db/exports";
import { fakeSpeechProvider, SAMPLE_RATE, toneOf, toneWav } from "~/providers/fakeSpeech";
import type { SpeechProvider } from "~/providers/speech";
import type { AudiobookEncoder, EncodeChapter, EncodeInput } from "~/providers/encoder";
import { FRAME, pruneSegments } from "~/providers/segments";
import { wavHeader } from "~/providers/wav";
import {
  ffmpegAvailable,
  ffmpegEncoder,
  ffmpegEncoders,
  sweepWork,
  type FfmpegOptions,
} from "~/providers/ffmpegEncoder";
import { epubFile, line, story } from "../support/epub";
import { writeExport } from "../support/persist";
import { jsonBody, narratedBook, testApi, type TestApi } from "../support/server";

interface ImportResult {
  book: Book;
  chapters: Chapter[];
}
interface Failure {
  error: { code: string; message: string; detail?: string };
}

/** A finished export of the seeded world's, read once: building the world is the costly part. */
let seededExport: ExportItem | undefined;
const seededDone = (): ExportItem =>
  (seededExport ??= makeWorld().exports.find(
    (e) => e.status === "done" && e.chapterIds.length <= 3,
  )!);

/** A shelved book, and a seeded export re-keyed onto it. */
async function withExport() {
  const api = testApi();
  const { body } = await api.import<ImportResult>(
    await epubFile({
      chapters: ["One", "Two", "Three"].map((title) => ({ title, paragraphs: story(2) })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  const seeded = seededDone();
  const exported: ExportItem = {
    ...seeded,
    id: 1,
    bookId: id,
    chapterIds: [1, 2],
    files: seeded.files.slice(0, 1).map((f) => ({ ...f, chapterIds: [1, 2] })),
    state: { 1: "a", 2: "b" },
    timeline: [
      { id: 1, title: "One", duration: 100 },
      { id: 2, title: "Two", duration: 120 },
    ],
    replaces: null,
    version: 1,
  };
  delete exported.jobId;
  writeExport(api.db, exported, Date.parse(seeded.createdAt));
  return { api, id, exported };
}

describe("a book's exports over HTTP", () => {
  test("are listed with the chapters and files they were built from", async () => {
    const { api, id, exported } = await withExport();
    const { body } = await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`);
    expect(body.exports).toHaveLength(1);
    expect(body.exports[0]).toMatchObject({
      id: 1,
      bookId: id,
      chapterIds: [1, 2],
      state: { 1: "a", 2: "b" },
      timeline: exported.timeline,
    });
    const one = await api.request<{ export: ExportItem }>(`/api/books/${id}/exports/1`);
    expect(one.body.export.id).toBe(1);
  });

  test("an export of another book is not found through this one", async () => {
    const { api } = await withExport();
    const other = await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "Solo", paragraphs: story(1) }] }),
    );
    const { status } = await api.request<Failure>(`/api/books/${other.body.book.id}/exports/1`);
    expect(status).toBe(404);
  });

  test("forgetting one takes it off the list, and a second try is a 404", async () => {
    const { api, id } = await withExport();
    const gone = await api.request<{ removed: number }>(`/api/books/${id}/exports/1`, {
      method: "DELETE",
    });
    expect(gone.body.removed).toBe(1);
    expect(
      (await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`)).body.exports,
    ).toEqual([]);
    expect(
      (await api.request<Failure>(`/api/books/${id}/exports/1`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  test("removing the volume that was all of an export takes the export with it", async () => {
    const { api, id } = await withExport();
    await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "Four", paragraphs: story(1) }] }),
      { bookId: id },
    );
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.request(`/api/books/${id}/volumes/1`, { method: "DELETE" });
    const { body } = await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`);
    // Every chapter it claimed went, so the export goes too.
    expect(body.exports).toEqual([]);
  });
});

// ---------- building one ----------
// Asserts on the file (its length per ffprobe), not the row: a row that disagrees with the disk is
// the failure this catches. `controlledEncoder` sits on the API's own encoder because the route
// enqueues into the API's runner, and a second runner would only sometimes win the claim.

interface BuildResult {
  job: Job;
  export: ExportItem;
}

/**
 * The encoder with a door: `hold()` keeps a build inside until `open()` (a cancel rejects like an
 * aborted encode); `fail(message)` makes the next build throw.
 */
function controlledEncoder(): AudiobookEncoder & {
  hold(): Promise<void>;
  open(): void;
  fail(message: string): void;
} {
  const inner = ffmpegEncoder();
  let door: { enter: () => void; open: () => void; opened: Promise<void> } | null = null;
  let failure: string | null = null;
  return {
    ...inner,
    async encode(input) {
      if (failure) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      if (door) {
        door.enter();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(input.signal.reason);
          if (input.signal.aborted) return abort();
          input.signal.addEventListener("abort", abort, { once: true });
          void door!.opened.then(() => {
            input.signal.removeEventListener("abort", abort);
            resolve();
          });
        });
      }
      return inner.encode(input);
    },
    hold() {
      let enter!: () => void;
      let open!: () => void;
      const inside = new Promise<void>((r) => (enter = r));
      const opened = new Promise<void>((r) => (open = r));
      door = { enter, open, opened };
      return inside;
    },
    open: () => door?.open(),
    fail: (message: string) => (failure = message),
  };
}

/**
 * A speech model whose second reading of a line is ten seconds longer. The audio itself grows: a
 * build reads the file, so a fake that only reported a longer duration would prove nothing.
 */
function slowerOnRetake(): SpeechProvider {
  const inner = fakeSpeechProvider();
  const seen = new Set<string>();
  return {
    name: inner.name,
    async speak(input) {
      const clip = await inner.speak(input);
      if (!seen.has(input.text)) {
        seen.add(input.text);
        return clip;
      }
      const duration = clip.duration + 10;
      return { ...clip, duration, bytes: toneWav(toneOf(input.speaker), duration) };
    },
  };
}

const settingsFor = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  title: "Moonlight Ledger",
  filename: "Moonlight Ledger",
  ...over,
});

const build = (api: TestApi, id: string, body: unknown) =>
  api.request<BuildResult>(`/api/books/${id}/exports`, jsonBody(body));

const exportsOf = async (api: TestApi, id: string) =>
  (await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`)).body.exports;

const chaptersOf = async (api: TestApi, id: string) =>
  (await api.request<ImportResult>(`/api/books/${id}`)).body.chapters;

const jobById = async (api: TestApi, id: number) =>
  (await api.request<{ job: Job }>(`/api/jobs/${id}`)).body.job;

/**
 * A three-chapter book, one line of dialogue and its attribution a chapter. Kept short: build time
 * is mostly ffmpeg over this audio. No line repeats, so `slowerOnRetake` lengthens one chapter only.
 */
const THREE: [string, string][] = [
  ["One", line("One")],
  ["Two", line("Two", "Tomas")],
  ["Three", line("Three", "Ines")],
];

/** Where one output file of an export landed on disk. */
const filePath = (api: TestApi, bookId: string, exportId: number, position = 0): string => {
  const token = exportFileToken(api.db, exportId, position);
  return token ? (api.exports.files.path(bookId, token) ?? "") : "";
};

const fileBytes = (
  api: TestApi,
  bookId: string,
  exportId: number,
  position = 0,
): Uint8Array<ArrayBuffer> =>
  new Uint8Array(readFileSync(filePath(api, bookId, exportId, position)));

/** How long a built file plays, read out of the file rather than off the row. */
const playsFor = async (api: TestApi, bookId: string, exportId: number, position = 0) =>
  (await probe(filePath(api, bookId, exportId, position))).seconds;

/** A removal nothing waits for — a settle's, or a route's — so the test waits a little. */
async function untilGone(path: string): Promise<boolean> {
  for (let i = 0; i < 50 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 2));
  return !existsSync(path);
}

describe("building an audiobook", () => {
  test("writes one real file, and the row describes what is in it", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: THREE });
    const settings = settingsFor();
    const queued = await build(api, id, { ids: [1, 2, 3], settings });
    expect(queued.status).toBe(202);
    expect(queued.body.export.status).toBe("building");
    expect(queued.body.job.exportRun?.exportId).toBe(queued.body.export.id);
    await api.runner.idle();

    const [done] = await exportsOf(api, id);
    expect(done.status).toBe("done");
    expect(done.files).toHaveLength(1);
    expect(done.size).toBeGreaterThan(0);

    expect(fileBytes(api, id, done.id).byteLength).toBeGreaterThan(0);
    // where it really is, for "copy path"
    expect(done.files[0].path).toBe(filePath(api, id, done.id));
    // The running time on the row is the file's, not the plan's estimate of it.
    expect(await playsFor(api, id, done.id)).toBeCloseTo(done.duration, 1);
    // and what is in the file is every chapter, with one gap between each pair and none after
    const chapters = await chaptersOf(api, id);
    const expected = chapters.reduce((a, c) => a + c.duration, 0) + 2 * settings.chapterGap;
    expect(done.duration).toBeCloseTo(expected, 0);
  });

  test("the layout the page drew is the set of files that was written", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: THREE });
    await build(api, id, { ids: [1, 2, 3], settings: settingsFor({ grouping: "chapter" }) });
    await api.runner.idle();

    const [done] = await exportsOf(api, id);
    expect(done.files).toHaveLength(3);
    expect(done.files.map((f) => f.chapterIds)).toEqual([[1], [2], [3]]);
    expect(done.files.every((f) => f.name.endsWith(".m4b"))).toBe(true);
    for (const [position, file] of done.files.entries())
      expect(await playsFor(api, id, done.id, position)).toBeCloseTo(file.duration, 1);
  });

  test("a finished file downloads under its name, even one no header can carry, and answers a range", async () => {
    // A header is Latin-1: an em dash, curly apostrophe or Chinese title must not make `Headers` throw.
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: THREE });
    const name = "The Philosopher’s Stone — 三体";
    await build(api, id, { ids: [1, 2], settings: settingsFor({ filename: name }) });
    await api.runner.idle();
    const [done] = await exportsOf(api, id);
    expect(done.files[0].name).toContain("三体");
    const url = `/api/books/${id}/exports/${done.id}/files/0`;
    const onDisk = fileBytes(api, id, done.id);

    const res = await api.fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mp4");
    const header = res.headers.get("content-disposition")!;
    // The name a browser reads, in UTF-8, and an ASCII stand-in beside it for one that cannot.
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent(done.files[0].name)}`);
    expect(header).toMatch(/^attachment; filename="[\x20-\x7e]+"/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(onDisk);

    // and a part of it, so a player can seek
    const part = await api.fetch(url, { headers: { range: "bytes=0-43" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-43/${onDisk.byteLength}`);
    expect(part.headers.get("content-disposition")).toBe(header);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(onDisk.slice(0, 44));
  });

  test("a chapter with no audio refuses the build in the page's own words", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: THREE.slice(0, 2), ids: [1] });

    const refused = await api.request<Failure>(
      `/api/books/${id}/exports`,
      jsonBody({ ids: [1, 2], settings: settingsFor() }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("no audio");
    // and no version went up for an audiobook that was never going to be built
    expect(await exportsOf(api, id)).toEqual([]);
  });

  test("a cancel that arrives after the last file is written still leaves the old version current", async () => {
    // The encoder has returned and the build is committing, a window the encoders' signal checks
    // cannot see. A cancel here must not leave the book with no current audiobook.
    const inner = ffmpegEncoder();
    let written!: () => void;
    const encoded = new Promise<void>((r) => (written = r));
    let release!: () => void;
    const closing = new Promise<void>((r) => (release = r));
    let hold = false;
    const encoder = {
      ...inner,
      async encode(input: Parameters<typeof inner.encode>[0]) {
        const result = await inner.encode(input);
        if (hold) {
          written();
          await closing;
        }
        return result;
      },
    };
    const api = testApi({ encoder });
    const { id } = await narratedBook(api, { chapters: THREE });
    const settings = settingsFor();
    await build(api, id, { ids: [1, 2], settings });
    await api.runner.idle();
    const [v1] = await exportsOf(api, id);

    hold = true;
    const second = await build(api, id, { ids: [1, 2], settings, updates: v1.id });
    await encoded;
    await api.request(`/api/jobs/${second.body.job.id}/cancel`, { method: "POST" });
    release();
    await api.runner.idle();

    expect((await jobById(api, second.body.job.id)).status).toBe("cancelled");
    const left = await exportsOf(api, id);
    expect(left.map((e) => [e.id, e.status])).toEqual([[v1.id, "done"]]);
    expect(existsSync(filePath(api, id, v1.id))).toBe(true);
  });

  test("a cancelled build leaves nothing behind, and the version on disk still plays", async () => {
    const encoder = controlledEncoder();
    const api = testApi({ encoder });
    const { id } = await narratedBook(api, { chapters: THREE });
    const settings = settingsFor();
    await build(api, id, { ids: [1, 2], settings });
    await api.runner.idle();
    const [v1] = await exportsOf(api, id);
    const kept = filePath(api, id, v1.id);

    const inside = encoder.hold();
    const second = await build(api, id, { ids: [1, 2], settings, updates: v1.id });
    await inside;
    const halfWritten = filePath(api, id, second.body.export.id);
    await api.request(`/api/jobs/${second.body.job.id}/cancel`, { method: "POST" });
    encoder.open();
    await api.runner.idle();

    // there is no half an audiobook: the version it was making is gone entirely
    const left = await exportsOf(api, id);
    expect(left.map((e) => e.id)).toEqual([v1.id]);
    expect(left[0].status).toBe("done");
    expect(existsSync(kept)).toBe(true);
    expect(await untilGone(halfWritten)).toBe(true);
  });

  test("a build that fails keeps its reason, and the audiobook already there is untouched", async () => {
    const encoder = controlledEncoder();
    const api = testApi({ encoder });
    const { id } = await narratedBook(api, { chapters: THREE });
    const settings = settingsFor();
    await build(api, id, { ids: [1, 2], settings });
    await api.runner.idle();
    const [v1] = await exportsOf(api, id);
    const kept = fileBytes(api, id, v1.id);

    encoder.fail("The encoder ran out of disk");
    const second = await build(api, id, { ids: [1, 2], settings, updates: v1.id });
    await api.runner.idle();

    const versions = await exportsOf(api, id);
    const failed = versions.find((e) => e.id === second.body.export.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("ran out of disk");
    expect((await jobById(api, second.body.job.id)).status).toBe("failed");
    // v1 was never touched: still current, still the same file
    expect(versions.find((e) => e.id === v1.id)!.status).toBe("done");
    expect(fileBytes(api, id, v1.id)).toEqual(kept);
  });

  test("one build at a time per book, and one being built cannot be forgotten", async () => {
    const encoder = controlledEncoder();
    const api = testApi({ encoder });
    const { id } = await narratedBook(api, { chapters: THREE });
    const inside = encoder.hold();
    const first = await build(api, id, { ids: [1, 2], settings: settingsFor() });
    await inside;

    const second = await api.request<Failure>(
      `/api/books/${id}/exports`,
      jsonBody({ ids: [3], settings: settingsFor({ filename: "Something else" }) }),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain("already building");

    const kept = await api.request<Failure>(`/api/books/${id}/exports/${first.body.export.id}`, {
      method: "DELETE",
    });
    expect(kept.status).toBe(409);
    expect(kept.body.error.message).toContain("still being built");

    encoder.open();
    await api.runner.idle();
    expect((await exportsOf(api, id))[0].status).toBe("done");
  });

  test("removing a book takes its audiobooks off the disk with it", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: THREE });
    await build(api, id, { ids: [1, 2], settings: settingsFor() });
    await api.runner.idle();
    const [done] = await exportsOf(api, id);
    const path = filePath(api, id, done.id);
    expect(existsSync(path)).toBe(true);

    await api.request(`/api/books/${id}`, { method: "DELETE" });
    expect(await untilGone(path)).toBe(true);
  });

  test("removing a book mid-build stops the build, and leaves no directory behind", async () => {
    // Held after the first of two files is written. The build is cancelled and settled before the rows
    // and directory go, so its `onSettled` clears what it wrote and nothing recreates the directory.
    const inner = ffmpegEncoder();
    let written!: () => void;
    const between = new Promise<void>((r) => (written = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let calls = 0;
    const encoder: AudiobookEncoder = {
      ...inner,
      async encode(input) {
        const result = await inner.encode(input);
        if (calls++ === 0) {
          written();
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(input.signal.reason);
            if (input.signal.aborted) return abort();
            input.signal.addEventListener("abort", abort, { once: true });
            void released.then(resolve);
          });
        }
        return result;
      },
    };
    const api = testApi({ encoder });
    const { id } = await narratedBook(api, { chapters: THREE });
    await build(api, id, { ids: [1, 2], settings: settingsFor({ grouping: "chapter" }) });
    await between;

    const removed = await api.request(`/api/books/${id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    release();
    await api.runner.idle();
    expect(await untilGone(join(api.exportDir, id))).toBe(true);
  });

  test("an audiobook says which chapters moved since it was built, with no script loaded", async () => {
    // The server's reading: a page that never read the scripts gets the same answer.
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: THREE });
    await build(api, id, { ids: [1, 2, 3], settings: settingsFor({ grouping: "volume" }) });
    await api.runner.idle();
    expect((await exportsOf(api, id))[0].changed).toEqual([]);

    await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [3], scope: "all" }));
    await api.runner.idle();
    expect((await exportsOf(api, id))[0].changed).toEqual([3]);

    // a renamed volume renames the file every chapter is in, though no audio moved
    const [volume] = (await api.request<ImportResult>(`/api/books/${id}`)).body.book.volumes;
    await api.request(`/api/books/${id}/volumes/${volume.id}`, {
      ...jsonBody({ name: "Renamed" }),
      method: "PATCH",
    });
    expect((await exportsOf(api, id))[0].changed).toEqual([1, 2, 3]);
  });

  test("a build that lands replaces every earlier version, whichever one it was queued against", async () => {
    // A retry names the version its failed attempt meant to replace, which a later build already has.
    const encoder = controlledEncoder();
    const api = testApi({ encoder });
    const { id } = await narratedBook(api, { chapters: THREE });
    const settings = settingsFor({ normalize: false });
    await build(api, id, { ids: [1, 2], settings });
    await api.runner.idle();
    const [v1] = await exportsOf(api, id);
    encoder.fail("The encoder ran out of disk");
    await build(api, id, { ids: [1, 2], settings, updates: v1.id });
    await api.runner.idle();
    await build(api, id, { ids: [1, 2], settings });
    await api.runner.idle();

    const retry = await build(api, id, { ids: [1, 2], settings, updates: v1.id });
    await api.runner.idle();
    const done = (await exportsOf(api, id)).filter((e) => e.status === "done");
    expect(done.map((e) => e.id)).toEqual([retry.body.export.id]);
  });

  test("forgetting an audiobook takes its files with it", async () => {
    const api = testApi();
    const { id } = await narratedBook(api, { chapters: THREE });
    await build(api, id, { ids: [1, 2], settings: settingsFor() });
    await api.runner.idle();
    const [done] = await exportsOf(api, id);
    const path = filePath(api, id, done.id);

    await api.request(`/api/books/${id}/exports/${done.id}`, { method: "DELETE" });
    expect(await exportsOf(api, id)).toEqual([]);
    expect(await untilGone(path)).toBe(true);
  });
});

// ---------- with a real encoder behind it ----------
// The format the settings asked for, the chapter marks a player reads, and an update encoded whole.

const ffmpeg = await ffmpegAvailable();

test("a work folder whose server died is cleared; a live one's is left alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audiobook-sweep-"));
  try {
    // no process has a pid this high
    for (const name of [`audiobook-ffmpeg-${process.pid}-a`, "audiobook-ffmpeg-999999999-b"])
      mkdirSync(join(dir, name));
    await sweepWork(dir);
    expect(existsSync(join(dir, `audiobook-ffmpeg-${process.pid}-a`))).toBe(true);
    expect(existsSync(join(dir, "audiobook-ffmpeg-999999999-b"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a machine without the ffmpeg it was told to run is told so, rather than failing a build", async () => {
  // What boot asks before the server is allowed to start: without ffmpeg it refuses to.
  expect(await ffmpegAvailable("/nonexistent/ffmpeg")).toBeNull();
});

/** What ffprobe says is in a file: how long it plays, its audio's rate, and the marks inside it. */
async function probe(
  path: string,
): Promise<{ seconds: number; rate: number; chapters: { title: string }[] }> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-show_chapters",
      path,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = JSON.parse(await new Response(proc.stdout).text()) as {
    format: { duration: string };
    streams: { codec_type: string; sample_rate?: string }[];
    chapters: { tags?: { title?: string } }[];
  };
  return {
    seconds: Number(out.format.duration),
    rate: Number(out.streams.find((s) => s.codec_type === "audio")?.sample_rate),
    chapters: (out.chapters ?? []).map((c) => ({ title: c.tags?.title ?? "" })),
  };
}

describe.skipIf(!ffmpeg)("building with ffmpeg", () => {
  test("finds a clip named relative to the server's folder, as the default `./data/audio` names it", async () => {
    // ffmpeg reads relative paths in a concat list against the list's own (temporary) folder, so a
    // relative AUDIO_DIR failed with "Error opening input file …/concat.txt". The folder sits under the
    // cwd like `data/audio`: from a deep temporary folder, `..` reaches the root and resolves anyway.
    const dir = mkdtempSync(join(process.cwd(), ".audiobook-relative-"));
    try {
      writeFileSync(join(dir, "a.wav"), toneWav(440, 0.5));
      writeFileSync(join(dir, "b.wav"), toneWav(660, 0.5));
      const clip = (name: string) => ({
        kind: "clip" as const,
        path: relative(process.cwd(), join(dir, name)),
      });
      expect(clip("a.wav").path.startsWith(".audiobook-relative-")).toBe(true);

      // a chapter counts as it goes in, not once the whole file is done
      let beforeTheFile: boolean | undefined;
      const written = await ffmpegEncoder({ format: "mp3" }).encode({
        chapters: [
          {
            id: 1,
            title: "One",
            parts: [clip("a.wav"), { kind: "silence", seconds: 0.25 }, clip("b.wav")],
          },
        ],
        gap: 1,
        out: join(dir, "out.mp3"),
        signal: new AbortController().signal,
        onChapter: () => (beforeTheFile ??= !existsSync(join(dir, "out.mp3"))),
      });
      expect(beforeTheFile).toBe(true);
      expect(written.seconds).toBeCloseTo(1.25, 1);
      expect((await probe(join(dir, "out.mp3"))).seconds).toBeCloseTo(1.25, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("writes the format that was asked for, with the chapter marks in it", async () => {
    const api = testApi({ encoder: ffmpegEncoders() });
    const { id } = await narratedBook(api, { chapters: THREE });
    await build(api, id, {
      ids: [1, 2, 3],
      settings: settingsFor({ markerPattern: "{n}. {title}" }),
    });
    await api.runner.idle();

    const [done] = await exportsOf(api, id);
    expect(done.status).toBe("done");
    expect(done.files[0].name.endsWith(".m4b")).toBe(true);
    // the plan promised three marks in the one file, and three is what is in it
    expect(done.markers).toBe(3);

    const read = await probe(filePath(api, id, done.id));
    expect(read.chapters.map((c) => c.title)).toEqual(["1. One", "2. Two", "3. Three"]);
    expect(read.seconds).toBeCloseTo(done.duration, 0);
    // at the clips' rate, though loudnorm resamples inside and the encoder would otherwise pick
    expect(read.rate).toBe(SAMPLE_RATE);
    const job = await jobById(api, done.jobId!);
    // the loudness was measured, with the file's figure before levelling
    expect(job.activity?.some((e) => e.detail?.measured != null)).toBe(true);
    expect(job.activity?.find((e) => e.message.endsWith("is written"))?.detail?.loudness).toMatch(
      /^-?\d+\.\d LUFS in, -?\d+\.\d out · one gain/,
    );
  }, 30_000);

  test.each([true, false])(
    "the chapter-marks switch is what the M4B gets (%p)",
    async (markers) => {
      const api = testApi({ encoder: ffmpegEncoders() });
      const { id } = await narratedBook(api, { chapters: THREE });
      await build(api, id, { ids: [1, 2], settings: settingsFor({ markers, normalize: false }) });
      await api.runner.idle();
      const [done] = await exportsOf(api, id);
      const read = await probe(filePath(api, id, done.id));
      expect(read.chapters).toHaveLength(markers ? 2 : 0);
      expect(done.markers).toBe(read.chapters.length);
    },
    30_000,
  );

  test("a quiet clip with loud peaks is limited, then levelled by one gain, and the measuring pass reports progress", async () => {
    // −29 LUFS with clicks near −7 dBFS: the 11 dB gain would carry them past the ceiling
    const dir = mkdtempSync(join(tmpdir(), "audiobook-loud-"));
    try {
      const rate = 24_000;
      const pcm = new Int16Array(rate * 8);
      for (let i = 0; i < pcm.length; i++)
        pcm[i] = Math.round(
          1600 * Math.sin((2 * Math.PI * 440 * i) / rate) + (i % rate < 24 ? 14_000 : 0),
        );
      const body = new Uint8Array(pcm.buffer);
      const head = wavHeader({ channels: 1, sampleRate: rate, bits: 16 }, body.byteLength);
      writeFileSync(join(dir, "a.wav"), Buffer.concat([head, body]));
      const ticks: string[] = [];
      const written = await ffmpegEncoder({ loudness: -18 }).encode({
        chapters: [{ id: 1, title: "One", parts: [{ kind: "clip", path: join(dir, "a.wav") }] }],
        gap: 0,
        out: join(dir, "out.m4b"),
        signal: new AbortController().signal,
        onMeasured: () => ticks.push("measured"),
        onChapter: () => ticks.push("encoded"),
      });
      expect(ticks).toEqual(["measured", "encoded"]);
      expect(written.levelled?.limited).toBeGreaterThan(0);
      expect(Math.abs((await lufsOf(join(dir, "out.m4b"))) + 18)).toBeLessThan(0.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("an update encodes only the chapter read again, and the file plays it", async () => {
    const api = testApi({ encoder: ffmpegEncoders(), speech: slowerOnRetake() });
    const { id } = await narratedBook(api, { chapters: THREE });
    // levelled, the longer chapter moves this short book's loudness past keeping the gain
    const settings = settingsFor({ normalize: false });
    await build(api, id, { ids: [1, 2, 3], settings });
    await api.runner.idle();
    const [v1] = await exportsOf(api, id);
    const was = await probe(filePath(api, id, v1.id));

    await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [3], scope: "all" }));
    await api.runner.idle();
    await build(api, id, { ids: [1, 2, 3], settings, updates: v1.id });
    await api.runner.idle();

    const v2 = (await exportsOf(api, id)).find((e) => e.version === 2)!;
    expect(v2.status).toBe("done");
    const now = await probe(filePath(api, id, v2.id));
    // the marks still land on all three, and the chapter that was read again made it longer
    expect(now.chapters).toHaveLength(3);
    expect(now.seconds).toBeGreaterThan(was.seconds);
    expect(now.seconds).toBeCloseTo(v2.duration, 0);
    const written = (await jobById(api, v2.jobId!)).activity?.find((e) =>
      e.message.endsWith("is written"),
    );
    expect(written?.detail?.reused).toBe("2 of 3 chapters");
  }, 30_000);
});

// ---------- chapter audio kept between builds ----------

const RATE = 24_000;

/** A 16-bit mono tone at `amp` of full scale. */
function tone(hz: number, seconds: number, amp = 0.3): Uint8Array {
  const pcm = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++)
    pcm[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * i) / RATE));
  const body = new Uint8Array(pcm.buffer);
  return Buffer.concat([
    wavHeader({ channels: 1, sampleRate: RATE, bits: 16 }, body.byteLength),
    body,
  ]);
}

/** The file's samples as a player decodes them. */
async function decoded(path: string): Promise<Int16Array> {
  const proc = Bun.spawn(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-"], {
    stdout: "pipe",
  });
  return new Int16Array((await new Response(proc.stdout).bytes()).slice().buffer);
}

/** The file's integrated loudness, measured whole. */
async function lufsOf(path: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffmpeg", "-nostdin", "-i", path, "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
    { stderr: "pipe" },
  );
  const log = await new Response(proc.stderr).text();
  return Number(/I:\s+(-?[\d.]+) LUFS/.exec(log.slice(log.lastIndexOf("Summary:")))?.[1]);
}

describe.skipIf(!ffmpeg)("chapter audio kept between builds", () => {
  let dir = "";
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "audiobook-segments-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const clip = (name: string, wav: Uint8Array) => {
    writeFileSync(join(dir, name), wav);
    return { kind: "clip" as const, path: join(dir, name) };
  };
  /** one chapter per tone length, the second with a pause and a second clip */
  const chaptersOf = (lengths: number[], pause = 0.25): EncodeChapter[] =>
    lengths.map((seconds, i) => ({
      id: i + 1,
      title: `${i + 1}`,
      parts: [
        clip(`${i}.wav`, tone(300 + 150 * i, seconds)),
        ...(i === 1
          ? [{ kind: "silence" as const, seconds: pause }, clip("1b.wav", tone(500, 0.5))]
          : []),
      ],
    }));
  let n = 0;
  const encode = (
    chapters: EncodeChapter[],
    { signal, onChapter, ...options }: FfmpegOptions & Partial<EncodeInput> = {},
  ) => {
    const out = join(dir, `out-${n++}.m4b`);
    return ffmpegEncoder(options)
      .encode({
        chapters,
        gap: 1,
        out,
        cache: join(dir, "cache"),
        signal: signal ?? new AbortController().signal,
        onChapter,
      })
      .then((written) => ({ ...written, out }));
  };

  test("the joined file plays each chapter where its mark says, with silence between and nothing added", async () => {
    const lengths = [1.3, 0.7, 2.1];
    const written = await encode(chaptersOf(lengths));
    const pcm = await decoded(written.out);
    const at = (ms: number) => Math.round((ms * RATE) / 1000);
    const rms = (from: number, to: number) => {
      let sum = 0;
      for (let i = at(from); i < at(to); i++) sum += pcm[i] ** 2;
      return Math.sqrt(sum / (at(to) - at(from)));
    };
    const ends = written.chapters.map((c) => c.start + c.length);
    // AAC's priming and padding are accounted for to the sample, and after the last chapter is
    // only its tail, one or two frames
    expect(pcm.length).toBe(Math.round(written.seconds * RATE));
    const after = pcm.length - at(ends.at(-1)!);
    expect(after).toBeGreaterThanOrEqual(FRAME - 24);
    expect(after).toBeLessThan(2 * FRAME + 24);
    expect(written.chapters.map((c) => c.seconds)).toEqual([1.3, 1.45, 2.1]);
    // a mark a frame (43 ms) out would put silence inside or sound outside these windows
    for (const c of written.chapters) {
      expect(rms(c.start + 5, c.start + 30)).toBeGreaterThan(4000);
      expect(rms(c.start + c.length - 30, c.start + c.length - 5)).toBeGreaterThan(4000);
    }
    for (const [i, c] of written.chapters.slice(1).entries()) {
      // the gap asked for, give or take half a frame
      expect(Math.abs(c.start - ends[i] - 1000)).toBeLessThan(22);
      expect(rms(ends[i] + 10, c.start - 10)).toBeLessThan(150);
    }
  }, 30_000);

  test.each<[string, (chapters: EncodeChapter[]) => EncodeChapter[], FfmpegOptions, number]>([
    ["nothing changed", (c) => c, {}, 3],
    // a new voice, a re-applied effect, a corrected line: the clip changes, its length need not
    ["a clip rewritten at the same length", (c) => (clip("2.wav", tone(700, 2.1)), c), {}, 2],
    [
      "a longer pause",
      (c) =>
        c.map((x) => ({
          ...x,
          parts: x.parts.map((p) => (p.kind === "silence" ? { ...p, seconds: 0.5 } : p)),
        })),
      {},
      2,
    ],
    ["another bitrate", (c) => c, { bitrate: 96 }, 0],
    ["another loudness target", (c) => c, { loudness: -16 }, 0],
  ])(
    "a rebuild after %s encodes only what it changed",
    async (_, change, options, reused) => {
      const chapters = chaptersOf([1.3, 0.7, 2.1]);
      await encode(chapters, { loudness: -18 });
      const again = await encode(change(chapters), { loudness: -18, ...options });
      expect(again.reused).toBe(reused);
    },
    30_000,
  );

  test("a kept chapter whose file has gone is encoded again", async () => {
    const chapters = chaptersOf([1.3, 0.7, 2.1]);
    const first = await encode(chapters);
    const cache = join(dir, "cache");
    rmSync(
      join(
        cache,
        readdirSync(cache).find((f) => f.endsWith(".aac"))!,
      ),
    );
    const again = await encode(chapters);
    expect(again.reused).toBe(2);
    expect(again.seconds).toBe(first.seconds);
  }, 30_000);

  test("a cancelled build leaves no half-written chapter, and the next one keeps what finished", async () => {
    const chapters = chaptersOf([1.3, 0.7, 2.1, 1, 1.2]);
    const stop = new AbortController();
    const cancelled = encode(chapters, { signal: stop.signal, onChapter: () => stop.abort() });
    expect(cancelled).rejects.toBeDefined();
    await cancelled.catch(() => {});
    expect(readdirSync(join(dir, "cache")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect((await encode(chapters)).reused).toBeGreaterThan(0);
  }, 30_000);

  test("an earlier build's gain is kept while a selection stays within half a LU of the target", async () => {
    const [one, two, three, quieter] = [0.1, 0.1, 0.105, 0.05].map((amp, i) => ({
      id: i + 1,
      title: `${i + 1}`,
      parts: [clip(`q${i}.wav`, tone(400 + 50 * i, 2, amp))],
    }));
    const first = await encode([one, two], { loudness: -18 });
    const more = await encode([one, two, three], { loudness: -18 });
    expect(more.levelled?.kept).toBe(true);
    expect(more.reused).toBe(2);
    // a chapter 6 dB down moves the whole past the tolerance: a new gain, every chapter again
    const louder = await encode([one, two, quieter], { loudness: -18 });
    expect(louder.levelled?.kept).toBe(false);
    expect(louder.reused).toBe(0);
    for (const file of [first, more, louder])
      expect(Math.abs((await lufsOf(file.out)) + 18)).toBeLessThan(0.5);
  }, 30_000);
});

test("cached chapter audio unused for two weeks is cleared, as are drafts of a process that died", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audiobook-prune-"));
  try {
    const old = Date.now() / 1000 - 15 * 86_400;
    for (const name of [
      "old.aac",
      "fresh.aac",
      "a.json.999999999-x.tmp",
      `b.json.${process.pid}-y.tmp`,
    ])
      writeFileSync(join(dir, name), "");
    utimesSync(join(dir, "old.aac"), old, old);
    await pruneSegments(dir);
    expect(readdirSync(dir).sort()).toEqual([`b.json.${process.pid}-y.tmp`, "fresh.aac"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
