// Building an audiobook, and keeping it up to date afterwards.
//
// Three things are worth pinning down here, because the whole page rests on them: the plan is the
// single source of what a build produces; a chapter that cannot be exported is never quietly
// dropped; and an update or a retry that would have to decide something on your behalf asks
// instead. The build itself is the server's (`tests/server/exports.test.ts`); the store tests here
// build on a seeded demo library and read back what it made, the way the Audiobooks tab does.
import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import { useQueryCache } from "@pinia/colada";
import { keys } from "@/queries/keys";

import { useCastStore } from "@/stores/cast";
import { useExportsStore } from "@/stores/exports";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import {
  chapterSignature,
  DEFAULT_EXPORT_SETTINGS,
  durationOf,
  exportKey,
  planOf,
  readinessOf,
  reviewOf,
  trackNo,
  usable,
} from "@/lib/exports";
import { DEFAULT_PACING } from "@/lib/speech";
import { jobsService } from "@/services/jobs";
import { libraryService } from "@/services/library";
import type { Chapter, ExportItem, ExportSettings, Job, Volume } from "@/types";
import { demoServer, type DemoServer } from "./support/demoServer";
import { openDemoBook } from "./support/demoBook";
import { testPinia } from "./support/pinia";

let castStore: ReturnType<typeof useCastStore>;
let exportsStore: ReturnType<typeof useExportsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;

const settings = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  ...DEFAULT_EXPORT_SETTINGS,
  title: "Test Book",
  series: "Test Book",
  author: "A. Author",
  filename: "Test Book",
  ...over,
});
const chapter = (id: number, volumeId: number, duration: number, over: Partial<Chapter> = {}) =>
  ({
    id,
    index: id,
    volumeId,
    volumeIndex: id,
    title: `Chapter ${id}`,
    words: 1000,
    scripting: "done",
    scriptingProgress: 100,
    narration: "done",
    narrationProgress: 100,
    duration,
    ...over,
  }) as Chapter;
const volumes: Volume[] = [
  { id: 1, name: "Vol. 1 · One", file: "a.epub", from: 1, to: 2 },
  { id: 2, name: "Vol. 2 · Two", file: "b.epub", from: 3, to: 4 },
];

describe("the plan", () => {
  const chapters = [chapter(1, 1, 100), chapter(2, 1, 200), chapter(3, 2, 300), chapter(4, 2, 400)];

  test("one file holds every chapter, and the chapter gaps between them", () => {
    const plan = planOf({ chapters, volumes, settings: settings({ chapterGap: 2 }) });
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].name).toBe("Test Book.m4b");
    // 1000 seconds of audio plus three joins of 2s — and no gap after the last chapter
    expect(plan.duration).toBe(1006);
    expect(plan.gaps).toBe(6);
    expect(plan.label).toBe("Test Book.m4b");
  });

  test("per volume splits on volume boundaries and names each file after its volume", () => {
    const plan = planOf({ chapters, volumes, settings: settings({ grouping: "volume" }) });
    expect(plan.files.map((f) => f.name)).toEqual([
      "Test Book - Vol. 1.m4b",
      "Test Book - Vol. 2.m4b",
    ]);
    expect(plan.files[0].chapterIds).toEqual([1, 2]);
    expect(plan.files[0].volume).toEqual({ number: 1, name: "Vol. 1 · One", of: 2 });
    // each file joins its own chapters only: 300 + 2, 700 + 2
    expect(plan.duration).toBe(1004);
    expect(plan.label).toBe("Test Book/");
  });

  test("per chapter numbers the tracks and writes no marks inside a one-chapter file", () => {
    const plan = planOf({ chapters, volumes, settings: settings({ grouping: "chapter" }) });
    expect(plan.files).toHaveLength(4);
    expect(plan.files[0].name).toBe("Test Book/01 - Chapter 1.m4b");
    expect(plan.files.every((f) => f.markers === 0)).toBe(true);
    // there is no join between two chapters when each is its own file
    expect(plan.duration).toBe(1000);
    expect(plan.gaps).toBe(0);
  });

  test("track numbers are wide enough for the whole set", () => {
    expect(trackNo(1, 9)).toBe("01");
    expect(trackNo(7, 214)).toBe("007");
  });

  test("MP3 carries no chapter marks, whatever the marker switch says", () => {
    const plan = planOf({
      chapters,
      volumes,
      settings: settings({ format: "mp3", markers: true }),
    });
    expect(plan.files[0].name.endsWith(".mp3")).toBe(true);
    expect(plan.markers).toBe(0);
  });

  test("the file count, the running time and the size are all read off the same files", () => {
    const plan = planOf({ chapters, volumes, settings: settings({ grouping: "volume" }) });
    expect(plan.files.reduce((a, f) => a + f.duration, 0)).toBe(plan.duration);
    expect(plan.files.reduce((a, f) => a + f.size, 0)).toBe(plan.size);
    expect(plan.files.reduce((a, f) => a + f.chapterIds.length, 0)).toBe(plan.chapters);
  });

  test("a chapter gap is the only silence Export owns", () => {
    expect(durationOf(chapters, 0)).toBe(1000);
    expect(durationOf(chapters, 5)).toBe(1015);
    expect(durationOf([chapters[0]], 5)).toBe(100); // nothing to join
    expect(durationOf([], 5)).toBe(0);
  });
});

describe("what stands in the way", () => {
  test("a chapter with no audio blocks the build and offers a way out", () => {
    const list = [chapter(1, 1, 100), chapter(2, 1, 0, { narration: "none" })];
    const review = reviewOf(list, settings());
    expect(review.missing).toEqual([2]);
    const blocker = review.blockers.find((b) => b.kind === "missing")!;
    expect(blocker.ids).toEqual([2]);
    // never "we left it out for you": narrate it, or take it out on purpose
    expect(blocker.actions).toEqual(["narrate", "drop"]);
  });

  test("stale audio blocks until it is accepted, and then says it is being used", () => {
    const list = [chapter(1, 1, 100), chapter(2, 1, 200, { narration: "stale" })];
    expect(reviewOf(list, settings()).blockers.some((b) => b.kind === "stale")).toBe(true);
    const accepted = reviewOf(list, settings({ useStale: true }));
    expect(accepted.blockers).toHaveLength(0);
    expect(accepted.usingStale).toBe(1);
  });

  test("a half-narrated chapter is not the same as one that failed outright", () => {
    expect(readinessOf(chapter(1, 1, 0, { narration: "failed" }))).toBe("failed");
    expect(readinessOf(chapter(1, 1, 120, { narration: "failed" }))).toBe("partial");
    expect(readinessOf(chapter(1, 1, 120, { narration: "running" }))).toBe("running");
    expect(readinessOf(chapter(1, 1, 120, { excluded: true }))).toBe("skipped");
  });

  test("an empty selection is a blocker of its own, with nothing to press", () => {
    const review = reviewOf([], settings());
    expect(review.blockers[0].kind).toBe("empty");
    expect(review.blockers[0].actions).toEqual([]);
  });
});

// ---------- against the demo library ----------
//
// One demo library for the rest of the file, with the runs it starts with cancelled so that a
// build finishing is the only thing a test waits for. Each build is named for its own test, so no
// test's audiobook is the next version of another's.

let named = 0;
/** Settings for an audiobook no other test has built. */
const own = (over: Partial<ExportSettings> = {}) =>
  settings({ filename: `Test Book ${++named}`, ...over });

let demo: DemoServer;
beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  demo = await demoServer();
  const jobs = jobsService();
  for (const j of await jobs.list())
    if (j.status === "queued" || j.status === "running") await jobs.cancel(j.id);
  await demo.idle();
});

/** A fresh page on `bookId`, read from the demo library. */
async function open(bookId = "starforge") {
  const pinia = testPinia();
  castStore = useCastStore();
  exportsStore = useExportsStore();
  libraryStore = useLibraryStore();
  scriptsStore = useScriptsStore();
  useUiStore().toast = () => "test";
  await openDemoBook(pinia, bookId);
  useQueryCache().setQueryData(keys.exports(bookId), await libraryService().exports(bookId));
}

/**
 * Wait for the server to finish a build, and read the book's audiobooks back. The runs the demo
 * started with were cancelled, so the queue falling idle is this build finishing.
 */
async function settled(entry: ExportItem | null): Promise<ExportItem> {
  expect(entry).not.toBeNull();
  await demo.idle();
  useQueryCache().setQueryData(
    keys.exports(entry!.bookId),
    await libraryService().exports(entry!.bookId),
  );
  return exportsStore.exports.find((e) => e.id === entry!.id)!;
}
const build = async (
  bookId: string,
  ids: number[],
  s: ExportSettings,
  opts?: { updates?: number },
): Promise<ExportItem> => settled(await exportsStore.buildExport(bookId, ids, s, opts));

/** every chapter of a book a build could use, stale included */
const usableIds = (bookId = "starforge") =>
  libraryStore
    .chaptersOf(bookId)
    .filter((c) => ["done", "stale"].includes(c.narration) && !c.excluded)
    .map((c) => c.id);

describe("staying up to date", () => {
  beforeEach(() => open());

  test("a chapter that has not been touched is current; one that changed is not", async () => {
    const ids = usableIds().slice(0, 3);
    const item = await build("starforge", ids, own({ useStale: true }));
    expect(item.status).toBe("done");
    // nothing has moved since: the server's fingerprints are the ones this page works out
    expect(exportsStore.exportUpdateFor(item).changed).toEqual([]);

    // re-rendering one chapter's clip changes that chapter's fingerprint and nothing else
    const seg = scriptsStore.segmentsOf("starforge", ids[1])[0];
    seg.audio.duration += 3;
    castStore._retime("starforge", ids[1]);
    const update = exportsStore.exportUpdateFor(item);
    expect(update.changed).toEqual([ids[1]]);
    expect(update.needed).toBe(true);
  });

  test("a pause costs nothing and renders nothing, but it does change the file", async () => {
    const ids = usableIds().slice(0, 2);
    const item = await build("starforge", ids, own({ useStale: true }));
    expect(exportsStore.exportUpdateFor(item).changed).toHaveLength(0);
    await castStore.setPacing("starforge", { turn: 1.4 });
    expect(exportsStore.exportUpdateFor(item).changed.length).toBeGreaterThan(0);
    await castStore.resetPacing("starforge");
  });

  test("an export of everything the book can give follows the book", async () => {
    await open("cliche");
    const ids = libraryStore
      .chaptersOf("cliche")
      .filter((c) => !c.excluded && usable(c))
      .map((c) => c.id);
    const item = await build("cliche", ids, own({ useStale: true }));
    expect(item.scope).toBe("book");

    const later = libraryStore.chaptersOf("cliche").find((c) => !ids.includes(c.id))!;
    later.narration = "done";
    later.duration = 120;
    const update = exportsStore.exportUpdateFor(item);
    expect(update.added).toEqual([later.id]);
    expect(update.outside).toHaveLength(0);
    expect(update.changed).toHaveLength(0);
    expect(update.needed).toBe(true);
  });

  test("a per-volume export claims its own volumes and nothing beyond them", async () => {
    await open("cliche");
    const ids = libraryStore
      .chaptersOf("cliche")
      .filter((c) => !c.excluded && usable(c))
      .map((c) => c.id);
    const vol = libraryStore.chapter("cliche", ids[0])!.volumeId;
    const item = await build("cliche", ids, own({ grouping: "volume", useStale: true }));
    expect(item.scope).toBe("volumes");

    const unnarrated = libraryStore.chaptersOf("cliche").filter((c) => !ids.includes(c.id));
    const inside = unnarrated.find((c) => c.volumeId === vol)!;
    const beyond = unnarrated.find((c) => c.volumeId !== vol)!;
    for (const c of [inside, beyond]) {
      c.narration = "done";
      c.duration = 120;
    }
    const update = exportsStore.exportUpdateFor(item);
    expect(update.added).toEqual([inside.id]);
    expect(update.outside).toEqual([beyond.id]);
  });

  test("chapters chosen on purpose stay the chapters chosen: the rest is not missing", async () => {
    const item = await build("starforge", [2, 3], own());
    expect(item.scope).toBe("chosen");
    const update = exportsStore.exportUpdateFor(item);
    // nothing is behind — this audiobook is two chapters, and it still is
    expect(update.added).toHaveLength(0);
    expect(update.needed).toBe(false);
    // the other narrated chapters are offered as their own decision, never folded in
    const readyIds = libraryStore
      .chaptersOf("starforge")
      .filter((c) => !c.excluded && usable(c))
      .map((c) => c.id);
    expect(readyIds.length).toBeGreaterThan(2);
    expect(update.outside).toEqual(readyIds.filter((id) => id !== 2 && id !== 3));
  });

  test("a different bitrate is the same audiobook, built again as a new version", async () => {
    const ids = [2, 3];
    const s = own({ bitrate: 64 });
    await build("starforge", ids, s);
    const louder = await build("starforge", ids, { ...s, bitrate: 128 });
    expect(louder.version).toBe(2);
  });

  test("a finished export keeps the timeline it played, so a later correction is a difference", async () => {
    const item = await build("starforge", [2, 3], own({ chapterGap: 2 }));
    expect(item.timeline!.map((t) => t.id)).toEqual([2, 3]);
    expect(item.timeline!.reduce((a, t) => a + t.duration, 0) + item.chapterGap).toBeCloseTo(
      item.duration,
      6,
    );

    const was = item.timeline![0].duration;
    const seg = scriptsStore.segmentsOf("starforge", 2)[0];
    seg.audio.duration += 7;
    castStore._retime("starforge", 2);
    expect(libraryStore.chapter("starforge", 2)!.duration).not.toBe(was);
    expect(item.timeline![0].duration).toBe(was);
  });

  test("two pauses that swap places change the file, though the silence is the same", () => {
    const c = libraryStore.chapter("starforge", 2)!;
    const segs = scriptsStore.segmentsOf("starforge", 2);
    const heard = segs.filter((x) => x.audio.duration > 0);
    heard[0].pause = 1;
    heard[1].pause = 2;
    const before = chapterSignature(c, segs, DEFAULT_PACING, undefined);
    heard[0].pause = 2;
    heard[1].pause = 1;
    expect(chapterSignature(c, segs, DEFAULT_PACING, undefined)).not.toBe(before);
  });

  test("the fingerprint covers the clips, the stitched silence and the chapter's state", () => {
    const c = chapter(1, 1, 100);
    const segs = scriptsStore.segmentsOf("starforge", 2);
    expect(segs.length).toBeGreaterThan(0);
    const a = chapterSignature(c, segs, DEFAULT_PACING, undefined);
    expect(chapterSignature(c, segs, DEFAULT_PACING, undefined)).toBe(a);
    expect(chapterSignature(c, segs, { line: 1, turn: 2 }, undefined)).not.toBe(a);
    expect(
      chapterSignature({ ...c, narration: "stale" }, segs, DEFAULT_PACING, undefined),
    ).not.toBe(a);
  });
});

describe("update and retry ask before they decide", () => {
  beforeEach(() => open());

  // Both are "this audiobook again". Neither may shrink the selection or accept clips the script has
  // moved under on your behalf — when either would have to, the build goes to the Build tab and the
  // same readiness review that guards a first build guards this one.

  /**
   * A build of `ids` that fell over, as the queue lists it: the audiobook row and the job that
   * carried its settings. Nothing makes a demo build fail, so it is written here.
   */
  function failedBuild(ids: number[], s: ExportSettings): ExportItem {
    const failed = {
      id: 9_000 + named,
      bookId: "starforge",
      key: exportKey(s),
      filename: s.filename,
      chapterIds: ids,
      settings: s,
      version: 1,
      replaces: null,
      status: "failed",
      error: "The encoder stopped",
      jobId: 9_000 + named,
      state: {},
    } as unknown as ExportItem;
    const job: Job = {
      id: failed.jobId!,
      kind: "export",
      bookId: "starforge",
      chapterId: null,
      label: `Build ${s.filename}`,
      status: "failed",
      progress: 40,
      queuedAt: 1,
      startedAt: 1,
      finishedAt: 2,
      cancelled: false,
      exportRun: {
        exportId: failed.id,
        settings: s,
        chapterIds: ids,
        updates: null,
        files: 1,
        file: 1,
        fileName: s.filename,
        stage: "Encoding",
        done: 0,
      },
    };
    useQueryCache().setQueryData(keys.exports(failed.bookId), (l: ExportItem[] = []) => [
      ...l,
      failed,
    ]);
    useQueryCache().setQueryData(keys.jobs, [job]);
    return exportsStore.exports.find((e) => e.id === failed.id)!;
  }

  test("a chapter that lost its audio sends the update to the review, not out of the file", async () => {
    const item = await build("starforge", [2, 3], own());
    const gone = libraryStore.chapter("starforge", 3)!;
    gone.narration = "none";
    gone.duration = 0;

    expect(await exportsStore.updateExport(item.id)).toBeNull();
    // nothing was built, and the draft still asks for both chapters
    expect(exportsStore.exports.filter((e) => e.key === item.key)).toHaveLength(1);
    expect(exportsStore._exportDraft!.ids).toEqual([2, 3]);
    const review = reviewOf(
      libraryStore.chaptersOf("starforge").filter((c) => [2, 3].includes(c.id)),
      exportsStore._exportDraft!.settings,
    );
    expect(review.blockers.map((b) => b.kind)).toContain("missing");
  });

  test("an update never gives consent to stale clips that was never given", async () => {
    const item = await build("starforge", [2, 3], own());
    libraryStore.chapter("starforge", 3)!.narration = "stale";

    expect(await exportsStore.updateExport(item.id)).toBeNull();
    expect(exportsStore._exportDraft!.settings.useStale).toBe(false);
    expect(exportsStore.exports.filter((e) => e.key === item.key)).toHaveLength(1);
  });

  test("an update starts from the settings its export was built with", () => {
    const s = own({ markerPattern: "{title}", cover: "art.jpg", volPrefix: false, bitrate: 96 });
    const from = exportsStore.settingsFromExport({
      settings: { ...s, useStale: true },
    } as ExportItem);
    expect(from.markerPattern).toBe("{title}");
    expect(from.cover).toBe("art.jpg");
    expect(from.volPrefix).toBe(false);
    expect(from.bitrate).toBe(96);
    // everything except the one thing that is a decision each time
    expect(from.useStale).toBe(false);
  });

  test("a retry keeps the consent the failed build was started with", async () => {
    // ch 1 is stale, and this build accepted it on purpose
    expect(libraryStore.chapter("starforge", 1)!.narration).toBe("stale");
    const s = own({ useStale: true });
    const bad = failedBuild([1, 2], s);

    // the retry is a build of its own, and it goes through with the consent the first one had
    const retry = await settled(await exportsStore.retryExport(bad.id));
    expect(exportsStore._exportDraft).toBeNull();
    expect(retry.status).toBe("done");
    expect(retry.settings!.useStale).toBe(true);
  });

  test("a retry whose chapters moved since it failed goes to the review", async () => {
    const bad = failedBuild([2, 3], own());
    libraryStore.chapter("starforge", 2)!.narration = "stale";

    expect(await exportsStore.retryExport(bad.id)).toBeNull();
    expect(exportsStore._exportDraft!.ids).toEqual([2, 3]);
    expect(exportsStore._exportDraft!.settings.useStale).toBe(false);
    // nothing was retried, so the failed attempt is still there to retry
    expect(exportsStore.exports.some((e) => e.id === bad.id)).toBe(true);
  });

  test("an update only updates an export it would actually replace", async () => {
    const first = await build("starforge", [2, 3], own());
    // renamed on the way through: a different audiobook, built for the first time
    const other = await build("starforge", [2, 3], own(), { updates: first.id });
    expect(other.version).toBe(1);
    expect(other.replaces).toBeNull();
    expect(exportsStore.exports.find((e) => e.id === first.id)!.status).toBe("done");
  });
});

describe("the demo library", () => {
  test("the long book is there to be exported", async () => {
    await open("gates");
    const chapters = libraryStore.chaptersOf("gates");
    expect(chapters.length).toBeGreaterThan(100);
    expect(libraryStore.volumesOf("gates").length).toBeGreaterThan(1);
    expect(chapters.filter((c) => c.narration === "stale").length).toBeGreaterThan(0);
    expect(chapters.filter((c) => c.narration === "none").length).toBeGreaterThan(0);
    const behind = exportsStore.exportsOf("gates").find((e) => e.status === "done")!;
    const update = exportsStore.exportUpdateFor(behind);
    expect(update.added.length).toBeGreaterThan(0);
    expect(update.changed.length).toBeGreaterThan(0);
  });
});
