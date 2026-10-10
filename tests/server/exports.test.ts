// Finished audiobooks over HTTP: built, listed, downloaded and forgotten.
//
// The reading half is checked against rows written the way the round-trip test writes them, so it
// stands on its own; the building half drives the real runner and the real encoder and checks the
// file that comes out.
import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { Book, Chapter, ExportItem, ExportSettings, Job } from "@/types";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { makeWorld } from "~/demo/seed/world";
import { exportFileToken } from "~/db/exports";
import { fakeSpeechProvider, SAMPLE_RATE, toneOf, toneWav } from "~/providers/fakeSpeech";
import type { SpeechProvider } from "~/providers/speech";
import type { AudiobookEncoder } from "~/providers/encoder";
import { ffmpegAvailable, ffmpegEncoder, ffmpegEncoders } from "~/providers/ffmpegEncoder";
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
    // Every chapter it claimed went, so it goes too — the rule the page already applies to its own
    // copy, now kept where the row and its files are.
    expect(body.exports).toEqual([]);
  });
});

// ---------- building one ----------
//
// The build job end to end: the real runner, the real routes, ffmpeg, and clips a fake speech model
// actually wrote to disk. What is asserted is the file — how long it plays, as ffprobe reads it —
// rather than the row's account of itself, because a row that agrees with itself and not with the
// disk is the failure this page exists to catch.
//
// Where a build has to be genuinely in flight, `controlledEncoder` holds the door until the test
// opens it, so nothing here waits on a timer except the two fire-and-forget removals. The door is
// on the API's own encoder rather than a second runner beside it, because the route enqueues into
// the API's runner and a second one would only sometimes win the race to claim the job.

interface BuildResult {
  job: Job;
  export: ExportItem;
}

/**
 * The encoder, with a door the test can close.
 *
 * `hold()` resolves once a build is inside the encoder and keeps it there until `open()`; a cancel
 * while it waits rejects the way an aborted encode would. `fail(message)` makes the next build
 * throw instead, which is the one failure path a fake speech model cannot produce.
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
 * A speech model whose second reading of a line is ten seconds longer than its first.
 *
 * The audio is lengthened, not just the duration it reports: a build reads the file, so a fake
 * that only claimed to be slower would leave the chapter exactly as long as it was and prove
 * nothing about what was re-encoded.
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
 * A three-chapter book to narrate and build, one line of dialogue and its attribution a chapter.
 *
 * A few seconds of audio a chapter: the length of what is narrated is what every build here costs,
 * and under ffmpeg nearly all of it. At `story()`'s full length the two ffmpeg builds were most of
 * the whole suite's running time and proved nothing more. No line is repeated from one chapter to
 * the next, so `slowerOnRetake` lengthens only the chapter a test reads again.
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
    // A header is Latin-1. An em dash, a curly apostrophe or a Chinese title in it used to make
    // `Headers` throw, and the download a 500.
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

    // and a part of it, so a player can seek: the route answers through the clips' range helper,
    // whose edge cases are in ranges.test.ts
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
    // The encoder has returned and the build is on its way to committing — the window the
    // encoders' own signal checks cannot see. Before the build checked once more, it committed,
    // marked the old version `replaced`, and was then called cancelled and deleted: no current
    // audiobook at all.
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
    // Held after the first of two files is written, where a build that carried on would reserve
    // the second and `mkdir` the book's directory back. It is cancelled and settled before the
    // rows and the directory go, so its `onSettled` clears what it wrote while it still can.
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
//
// What the files hold beyond their length: the format the settings asked for, the chapter marks a
// player reads, and an update encoded whole.

const ffmpeg = await ffmpegAvailable();

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
    // ffmpeg reads a relative path in a concat list against the list's own folder — a temporary
    // one — and then blames the list: "Error opening input file …/concat.txt". A library on the
    // default AUDIO_DIR could not build with ffmpeg at all.
    // Under the working folder, as `data/audio` is: a path climbing out of a deep temporary folder
    // reaches the root and happens to resolve from anywhere.
    const dir = mkdtempSync(join(process.cwd(), ".audiobook-relative-"));
    try {
      writeFileSync(join(dir, "a.wav"), toneWav(440, 0.5));
      writeFileSync(join(dir, "b.wav"), toneWav(660, 0.5));
      const clip = (name: string) => ({
        kind: "clip" as const,
        path: relative(process.cwd(), join(dir, name)),
      });
      expect(clip("a.wav").path.startsWith(".audiobook-relative-")).toBe(true);

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
      });
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
    // the loudness the panel offered was measured rather than waved away, with the figure the
    // file measured before it was levelled
    expect(job.activity?.some((e) => e.detail?.measured != null)).toBe(true);
    expect(job.activity?.find((e) => e.message.endsWith("is written"))?.detail?.loudness).toMatch(
      /^-?\d+\.\d LUFS in, levelled to -\d+$/,
    );
  }, 30_000);

  test("an update encodes the whole audiobook again, with the chapter read again in it", async () => {
    const api = testApi({ encoder: ffmpegEncoders(), speech: slowerOnRetake() });
    const { id } = await narratedBook(api, { chapters: THREE });
    // the levels are left alone here: this is about what was encoded, and a two-pass loudnorm
    // over a whole audiobook twice over is minutes of a test suite for nothing
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
  }, 30_000);
});
