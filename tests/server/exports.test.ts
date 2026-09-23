// Finished audiobooks over HTTP: built, listed, downloaded and forgotten.
//
// The reading half is checked against rows written the way the round-trip test writes them, so it
// stands on its own; the building half drives the real runner and the real encoder and checks the
// file that comes out.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import type { Book, Chapter, ExportItem, ExportSettings, Job } from "@/types";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { makeWorld } from "@/mock";
import { chapterSpans, exportFileToken } from "~/db/exports";
import { fakeSpeechProvider, toneOf, toneWav } from "~/providers/fakeSpeech";
import type { SpeechProvider } from "~/providers/speech";
import type { AudiobookEncoder } from "~/providers/encoder";
import { ffmpegAvailable, ffmpegEncoders } from "~/providers/ffmpegEncoder";
import { byteRate, readWavHeader, wavEncoder } from "~/providers/wavEncoder";
import { epubFile, story } from "../support/epub";
import { writeExport } from "../support/persist";
import { jsonBody, testApi, type TestApi } from "../support/server";

interface ImportResult {
  book: Book;
  chapters: Chapter[];
}
interface Failure {
  error: { code: string; message: string; detail?: string };
}

/** A shelved book, and a seeded export re-keyed onto it. */
async function withExport() {
  const api = testApi();
  const { body } = await api.import<ImportResult>(
    await epubFile({
      chapters: ["One", "Two", "Three"].map((title) => ({ title, paragraphs: story() })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  const seeded = makeWorld().exports.find((e) => e.status === "done" && e.chapterIds.length <= 3)!;
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
      await epubFile({ chapters: [{ title: "Solo", paragraphs: story() }] }),
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

  test("removing a volume takes the chapters an export claimed off it", async () => {
    const { api, id } = await withExport();
    await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "Four", paragraphs: story() }] }),
      { bookId: id },
    );
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.request(`/api/books/${id}/volumes/1`, { method: "DELETE" });
    const { body } = await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`);
    // the export row stays, with no chapters left in it: what the client makes of that is its own
    expect(body.exports[0].chapterIds).toEqual([]);
  });
});

// ---------- building one ----------
//
// The build job end to end: the real runner, the real routes, the WAV stitcher, and clips a fake
// speech model actually wrote to disk. What is asserted is the file — its length, its bytes, and
// the span each chapter occupies inside it — rather than the row's account of itself, because a
// row that agrees with itself and not with the disk is the failure this page exists to catch.
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
 * The stitcher, with a door the test can close.
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
  const inner = wavEncoder();
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

/** A three-chapter book, scripted and narrated, ready to build. */
async function narrated(api = testApi()) {
  const { body } = await api.import<ImportResult>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: ["One", "Two", "Three"].map((title) => ({
        title,
        paragraphs: ["\u201cWe are short again,\u201d said Mara.", ...story()],
      })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1, 2, 3] }));
  await api.runner.idle();
  await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [1, 2, 3] }));
  await api.runner.idle();
  return { api, id };
}

/** Where one output file of an export landed on disk. */
const filePath = (api: TestApi, bookId: string, exportId: number, position = 0): string => {
  const token = exportFileToken(api.db, exportId, position);
  return token ? (api.exports.files.path(bookId, token) ?? "") : "";
};

const fileBytes = (api: TestApi, bookId: string, exportId: number, position = 0): Uint8Array =>
  new Uint8Array(readFileSync(filePath(api, bookId, exportId, position)));

/** How long a stitched file plays, read out of the file rather than off the row. */
function playsFor(bytes: Uint8Array): number {
  const head = readWavHeader(bytes);
  return head.length / byteRate(head);
}

/** A removal nothing waits for — a settle's, or a route's — so the test waits a little. */
async function untilGone(path: string): Promise<boolean> {
  for (let i = 0; i < 50 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 2));
  return !existsSync(path);
}

describe("building an audiobook", () => {
  test("writes one real file, and the row describes what is in it", async () => {
    const { api, id } = await narrated();
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

    const bytes = fileBytes(api, id, done.id);
    expect(bytes.byteLength).toBeGreaterThan(44);
    // The running time on the row is the file's, not the plan's estimate of it.
    expect(playsFor(bytes)).toBeCloseTo(done.duration, 1);
    // and what is in the file is every chapter, with one gap between each pair and none after
    const chapters = await chaptersOf(api, id);
    const expected = chapters.reduce((a, c) => a + c.duration, 0) + 2 * settings.chapterGap;
    expect(done.duration).toBeCloseTo(expected, 0);
  });

  test("the layout the page drew is the set of files that was written", async () => {
    const { api, id } = await narrated();
    await build(api, id, { ids: [1, 2, 3], settings: settingsFor({ grouping: "chapter" }) });
    await api.runner.idle();

    const [done] = await exportsOf(api, id);
    expect(done.files).toHaveLength(3);
    expect(done.files.map((f) => f.chapterIds)).toEqual([[1], [2], [3]]);
    // the stitcher writes a WAV, so that is what the files are called, rather than `.m4b`
    expect(done.files.every((f) => f.name.endsWith(".wav"))).toBe(true);
    // and it writes no chapter marks, so the export claims none
    expect(done.markers).toBe(0);
    for (const [position, file] of done.files.entries())
      expect(playsFor(fileBytes(api, id, done.id, position))).toBeCloseTo(file.duration, 1);
    // the job says both, rather than leaving a `.wav` to be discovered
    const job = await jobById(api, done.jobId!);
    expect(job.activity?.some((e) => e.message.includes("rather than .m4b"))).toBe(true);
  });

  test("a finished file can be downloaded, under the name it was given", async () => {
    const { api, id } = await narrated();
    await build(api, id, { ids: [1, 2], settings: settingsFor() });
    await api.runner.idle();
    const [done] = await exportsOf(api, id);

    const res = await api.fetch(`/api/books/${id}/exports/${done.id}/files/0`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("content-disposition")).toContain(done.files[0].name);
    expect((await res.arrayBuffer()).byteLength).toBe(fileBytes(api, id, done.id).byteLength);
  });

  test("a name no header can carry as it stands still downloads, under that name", async () => {
    // A header is Latin-1. An em dash, a curly apostrophe or a Chinese title in it used to make
    // `Headers` throw, and the download a 500.
    const { api, id } = await narrated();
    const name = "The Philosopher’s Stone — 三体";
    await build(api, id, { ids: [1, 2], settings: settingsFor({ filename: name }) });
    await api.runner.idle();
    const [done] = await exportsOf(api, id);
    expect(done.files[0].name).toContain("三体");

    const res = await api.fetch(`/api/books/${id}/exports/${done.id}/files/0`);
    expect(res.status).toBe(200);
    const header = res.headers.get("content-disposition")!;
    // The name a browser reads, in UTF-8, and an ASCII stand-in beside it for one that cannot.
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent(done.files[0].name)}`);
    expect(header).toMatch(/^attachment; filename="[\x20-\x7e]+"/);
  });

  test("a chapter with no audio refuses the build in the page's own words", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({ chapters: ["One", "Two"].map((title) => ({ title, paragraphs: story() })) }),
    );
    const id = body.book.id;
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });
    await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1, 2] }));
    await api.runner.idle();
    await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [1] }));
    await api.runner.idle();

    const refused = await api.request<Failure>(
      `/api/books/${id}/exports`,
      jsonBody({ ids: [1, 2], settings: settingsFor() }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("no audio");
    // and no version went up for an audiobook that was never going to be built
    expect(await exportsOf(api, id)).toEqual([]);
  });

  test("an update carries over what has not moved and reads again what has", async () => {
    const api = testApi({ speech: slowerOnRetake() });
    const { id } = await narrated(api);
    const settings = settingsFor();
    await build(api, id, { ids: [1, 2, 3], settings });
    await api.runner.idle();
    const [v1] = await exportsOf(api, id);
    const before = fileBytes(api, id, v1.id);
    const was = chapterSpans(api.db, v1.id).get(1)!;
    const lengths = (await chaptersOf(api, id)).map((c) => c.duration);

    // chapter 3 is read again, and comes back longer; 1 and 2 are untouched
    await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [3], scope: "all" }));
    await api.runner.idle();
    const grew = (await chaptersOf(api, id))[2].duration - lengths[2];
    expect(grew).toBeGreaterThan(0);

    const second = await build(api, id, { ids: [1, 2, 3], settings, updates: v1.id });
    expect(second.body.export.reused).toBe(2);
    expect(second.body.export.rebuilt).toBe(1);
    await api.runner.idle();

    const versions = await exportsOf(api, id);
    const v2 = versions.find((e) => e.version === 2)!;
    expect(v2.status).toBe("done");
    expect(v2.replaces).toBe(v1.id);
    // the version it supersedes is only replaced once the new one has landed
    expect(versions.find((e) => e.version === 1)!.status).toBe("replaced");

    // The carried chapter is the same *bytes*, not merely the same length: this is the whole
    // claim "carried over rather than encoded again" makes.
    const after = fileBytes(api, id, v2.id);
    const now = chapterSpans(api.db, v2.id).get(1)!;
    expect(now.length).toBe(was.length);
    expect(after.slice(44 + now.start, 44 + now.start + now.length)).toEqual(
      before.slice(44 + was.start, 44 + was.start + was.length),
    );
    // and the audiobook grew by exactly what the chapter that was read again grew by
    expect(playsFor(after)).toBeCloseTo(playsFor(before) + grew, 0);
    expect(
      (await jobById(api, v2.jobId!)).activity?.some(
        (e) => e.message === "Reusing 2 chapters that have not changed",
      ),
    ).toBe(true);
    // and the version it superseded is still on disk, so it can still be saved
    const old = await api.fetch(`/api/books/${id}/exports/${v1.id}/files/0`);
    expect(old.status).toBe(200);
  });

  test("a cancelled build leaves nothing behind, and the version on disk still plays", async () => {
    const encoder = controlledEncoder();
    const { api, id } = await narrated(testApi({ encoder }));
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
    const { api, id } = await narrated(testApi({ encoder }));
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
    const { api, id } = await narrated(testApi({ encoder }));
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
    const { api, id } = await narrated();
    await build(api, id, { ids: [1, 2], settings: settingsFor() });
    await api.runner.idle();
    const [done] = await exportsOf(api, id);
    const path = filePath(api, id, done.id);
    expect(existsSync(path)).toBe(true);

    await api.request(`/api/books/${id}`, { method: "DELETE" });
    expect(await untilGone(path)).toBe(true);
  });

  test("forgetting an audiobook takes its files with it", async () => {
    const { api, id } = await narrated();
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
// `EXPORT_ENCODER=ffmpeg` is the one configuration that depends on something outside this
// process, so these run only where that something is installed and are skipped, loudly, where it
// is not. What they are for is the three things the stitcher cannot do and therefore cannot be
// checked on: the format the settings actually asked for, chapter marks a player reads, and a
// carried-over span addressed in time rather than in bytes.

const ffmpeg = await ffmpegAvailable();

/** What ffprobe says is in a file: how long it plays, and the marks inside it. */
async function probe(path: string): Promise<{ seconds: number; chapters: { title: string }[] }> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_chapters", path],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = JSON.parse(await new Response(proc.stdout).text()) as {
    format: { duration: string };
    chapters: { tags?: { title?: string } }[];
  };
  return {
    seconds: Number(out.format.duration),
    chapters: (out.chapters ?? []).map((c) => ({ title: c.tags?.title ?? "" })),
  };
}

describe.skipIf(!ffmpeg)("building with ffmpeg", () => {
  test("writes the format that was asked for, with the chapter marks in it", async () => {
    const { api, id } = await narrated(testApi({ encoder: ffmpegEncoders() }));
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
    // nothing said the format was not the one asked for, because this time it was
    const job = await jobById(api, done.jobId!);
    expect(job.activity?.some((e) => e.message.includes("rather than"))).toBe(false);
    // and the loudness the panel offered was measured rather than waved away
    expect(job.activity?.some((e) => e.detail?.measured != null)).toBe(true);
  }, 120_000);

  test("an update re-encodes the whole audiobook, and says why", async () => {
    const api = testApi({ encoder: ffmpegEncoders(), speech: slowerOnRetake() });
    const { id } = await narrated(api);
    // the levels are left alone here: this is about what was copied, and a two-pass loudnorm
    // over a whole audiobook twice over is minutes of a test suite for nothing
    const settings = settingsFor({ normalize: false });
    await build(api, id, { ids: [1, 2, 3], settings });
    await api.runner.idle();
    const [v1] = await exportsOf(api, id);
    const was = await probe(filePath(api, id, v1.id));

    await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [3], scope: "all" }));
    await api.runner.idle();
    const second = await build(api, id, { ids: [1, 2, 3], settings, updates: v1.id });
    // Nothing is carried over: this encoder cannot splice a span of AAC beside audio it is
    // encoding now, and the row promises what the build will actually do.
    expect(second.body.export.reused).toBe(0);
    expect(second.body.export.rebuilt).toBe(3);
    await api.runner.idle();

    const v2 = (await exportsOf(api, id)).find((e) => e.version === 2)!;
    expect(v2.status).toBe("done");
    const now = await probe(filePath(api, id, v2.id));
    // the marks still land on all three, and the chapter that was read again made it longer
    expect(now.chapters).toHaveLength(3);
    expect(now.seconds).toBeGreaterThan(was.seconds);
    expect(now.seconds).toBeCloseTo(v2.duration, 0);
    expect(
      (await jobById(api, v2.jobId!)).activity?.some(
        (e) => e.message === "Every chapter is being encoded again",
      ),
    ).toBe(true);
  }, 120_000);
});
