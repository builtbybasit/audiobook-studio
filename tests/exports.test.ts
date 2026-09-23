import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
// Building an audiobook, and keeping it up to date afterwards.
//
// Three things are worth pinning down here, because the whole page rests on them: the plan is the
// single source of what a build produces; a chapter that cannot be exported is never quietly
// dropped; and a build that fails or is cancelled leaves the version already on disk exactly where
// it was. The simulated encoder runs on setInterval, so the clock and the timer API are faked.
import { test, expect, beforeEach, afterEach, spyOn, describe } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import {
  chapterSignature,
  DEFAULT_EXPORT_SETTINGS,
  durationOf,
  exportKey,
  loudnessReport,
  measuredLoudness,
  planOf,
  readinessOf,
  reviewOf,
  sameOutput,
  trackNo,
  usable,
} from "@/lib/exports";
import { DEFAULT_PACING } from "@/lib/speech";
import type { Chapter, ExportSettings, Volume } from "@/types";

let callbacks = new Map<number, () => void>();
let clock = 1000;
let restore: (() => void)[] = [];
let castStore: ReturnType<typeof useCastStore>;
let demoStore: ReturnType<typeof useDemoStore>;
let exportsStore: ReturnType<typeof useExportsStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;

function tick() {
  // snapshot first: a callback may clear its own interval, and a new one may start
  const pending = Array.from(callbacks);
  for (const [id, fn] of pending) if (callbacks.has(id)) fn();
}
function finish(max = 400) {
  for (let i = 0; i < max && callbacks.size; i++) tick();
}

/** A fresh seeded world. Only the store tests pay for one: the plan, the blockers and loudness
 *  are functions of what they are handed. */
function freshStores() {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  castStore = useCastStore();
  demoStore = useDemoStore();
  exportsStore = useExportsStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  jobsStore.jobs = [];
  uiStore.toast = () => "test";
}

beforeEach(() => {
  callbacks = new Map();
  clock = 1000;
  let seq = 0;
  restore = [
    spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
      const id = ++seq;
      callbacks.set(id, fn);
      return id;
    }) as typeof setInterval),
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
      callbacks.delete(id);
    }) as typeof clearInterval),
    spyOn(Date, "now").mockImplementation(() => (clock += 1)),
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());
});
afterEach(() => restore.forEach((fn) => fn()));

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

describe("loudness", () => {
  test("a voice always measures the same, and the gain closes the gap to the target", () => {
    const ref = "openai/nova";
    expect(measuredLoudness(ref)).toBe(measuredLoudness(ref));
    const report = loudnessReport(
      [{ ref, label: "Nova", endpoint: "OpenAI", segments: 10 }],
      settings({ loudness: -18 }),
    );
    const row = report.voices[0];
    expect(Math.round((row.lufs + row.gain) * 10) / 10).toBe(-18);
  });

  test("the spread is what different providers cost you, and is 0 for a single voice", () => {
    const one = loudnessReport(
      [{ ref: "openai/nova", label: "Nova", endpoint: "OpenAI", segments: 1 }],
      settings(),
    );
    expect(one.spread).toBe(0);
    const many = loudnessReport(
      [
        { ref: "openai/nova", label: "Nova", endpoint: "OpenAI", segments: 1 },
        { ref: "local/af_heart", label: "Heart", endpoint: "Kokoro", segments: 1 },
      ],
      settings(),
    );
    expect(many.spread).toBeGreaterThan(0);
    expect(many.voices[0].lufs).toBeLessThanOrEqual(many.voices[1].lufs); // quietest first
  });
});

describe("a build", () => {
  beforeEach(freshStores);

  const ready = (bookId: string) =>
    libraryStore
      .chaptersOf(bookId)
      .filter((c) => c.narration === "done" && !c.excluded)
      .map((c) => c.id);

  test("refuses chapters it cannot use instead of dropping them", async () => {
    const ids = [...ready("starforge"), 1]; // ch 1 of Starforge is stale
    expect(await exportsStore.buildExport("starforge", ids, settings())).toBeNull();
    expect(exportsStore.exports.some((e) => e.status === "building")).toBe(false);
    // and goes ahead once the stale audio is accepted on purpose
    expect(
      await exportsStore.buildExport("starforge", ids, settings({ useStale: true })),
    ).not.toBeNull();
  });

  test("runs to a finished export and replaces the version it supersedes", async () => {
    const ids = ready("starforge").slice(0, 5);
    const first = (await exportsStore.buildExport("starforge", ids, settings()))!;
    finish();
    expect(first.status).toBe("done");
    expect(first.size).toBeGreaterThan(0);
    expect(first.version).toBe(1);

    const second = (await exportsStore.buildExport("starforge", ids, settings()))!;
    finish();
    expect(second.version).toBe(2);
    expect(second.replaces).toBe(first.id);
    expect(first.status).toBe("replaced");
    // nothing changed in between, so every chapter was carried over rather than encoded again
    expect(second.reused).toBe(ids.length);
    expect(second.rebuilt).toBe(0);
    expect(exportsStore.exportsOf("starforge").some((e) => e.id === first.id)).toBe(false);
    expect(exportsStore.exportVersionsOf(second).map((e) => e.id)).toContain(first.id);
  });

  test("keeps the finished version when the next build fails, and retry starts over", async () => {
    const ids = ready("starforge").slice(0, 6);
    const good = (await exportsStore.buildExport("starforge", ids, settings()))!;
    finish();
    expect(good.status).toBe("done");

    demoStore._exportFails = true;
    const bad = (await exportsStore.buildExport("starforge", ids, settings()))!;
    finish();
    expect(bad.status).toBe("failed");
    expect(bad.error).toBeTruthy();
    // the audiobook on disk is untouched: still done, still the current version
    expect(good.status).toBe("done");
    expect(exportsStore.exportsOf("starforge").filter((e) => e.status === "done")).toContain(good);
    expect(demoStore._exportFails).toBe(false);

    exportsStore.retryExport(bad.id);
    finish();
    expect(exportsStore.exports.some((e) => e.id === bad.id)).toBe(false);
    const now = exportsStore.exportsOf("starforge").find((e) => e.key === exportKey(settings()))!;
    expect(now.status).toBe("done");
    expect(now.version).toBe(2);
  });

  test("cancelling writes nothing and leaves the previous version alone", async () => {
    const ids = ready("starforge").slice(0, 8);
    const good = (await exportsStore.buildExport("starforge", ids, settings()))!;
    finish();
    const next = (await exportsStore.buildExport("starforge", [...ids, 9], settings()))!;
    tick();
    const job = jobsStore.jobs.find((j) => j.id === next.jobId)!;
    jobsStore.cancelJob(job.id);
    finish();
    expect(exportsStore.exports.some((e) => e.id === next.id)).toBe(false);
    expect(job.status).toBe("cancelled");
    expect(good.status).toBe("done");
  });

  test("the job carries the build so the queue can describe it and retry it", async () => {
    const ids = ready("starforge").slice(0, 4);
    const item = (await exportsStore.buildExport(
      "starforge",
      ids,
      settings({ grouping: "single" }),
    ))!;
    const job = jobsStore.jobs.find((j) => j.id === item.jobId)!;
    expect(job.kind).toBe("export");
    expect(job.exportRun?.chapterIds).toEqual(ids);
    expect(job.exportRun?.files).toBe(1);
    finish();
    expect(job.status).toBe("done");
    expect(job.activity?.some((e) => e.message === "Export ready")).toBe(true);
  });
});

describe("staying up to date", () => {
  beforeEach(freshStores);

  /** every chapter of Starforge a build could use, stale included */
  const usableIds = () =>
    libraryStore
      .chaptersOf("starforge")
      .filter((c) => ["done", "stale"].includes(c.narration) && !c.excluded)
      .map((c) => c.id);

  test("a chapter that has not been touched is carried over; one that changed is not", async () => {
    const ids = usableIds();
    const item = (await exportsStore.buildExport("starforge", ids, settings({ useStale: true })))!;
    finish();
    // the whole book is in it and nothing has moved since
    expect(exportsStore.exportUpdateFor(item).needed).toBe(false);

    // re-rendering one chapter's clip changes that chapter's fingerprint and nothing else
    const seg = scriptsStore.segmentsOf("starforge", ids[1])[0];
    seg.audio.duration += 3;
    castStore._retime("starforge", ids[1]);
    const update = exportsStore.exportUpdateFor(item);
    expect(update.changed).toEqual([ids[1]]);
    expect(update.reusable).toBe(ids.length - 1);
    expect(update.needed).toBe(true);
  });

  test("a pause costs nothing and renders nothing, but it does change the file", async () => {
    const ids = usableIds().slice(0, 4);
    const item = (await exportsStore.buildExport("starforge", ids, settings({ useStale: true })))!;
    finish();
    expect(exportsStore.exportUpdateFor(item).changed).toHaveLength(0);
    castStore.setPacing("starforge", { turn: 1.4 });
    expect(exportsStore.exportUpdateFor(item).changed.length).toBeGreaterThan(0);
  });

  test("an export of everything the book can give follows the book", async () => {
    // Cliché can export 1–3 today; the rest of it has never been narrated
    const item = (await exportsStore.buildExport(
      "cliche",
      [1, 2, 3],
      settings({ useStale: true }),
    ))!;
    finish();
    expect(item.scope).toBe("book");
    expect(exportsStore.exportUpdateFor(item).needed).toBe(false);

    const later = libraryStore.chapter("cliche", 5)!;
    later.narration = "done";
    later.duration = 120;
    const update = exportsStore.exportUpdateFor(item);
    expect(update.added).toEqual([5]);
    expect(update.outside).toHaveLength(0);
    expect(update.changed).toHaveLength(0);
    expect(update.needed).toBe(true);
  });

  test("a per-volume export claims its own volumes and nothing beyond them", async () => {
    const item = (await exportsStore.buildExport(
      "cliche",
      [1, 2, 3],
      settings({ grouping: "volume", useStale: true }),
    ))!;
    finish();
    expect(item.scope).toBe("volumes");

    const inside = libraryStore.chapter("cliche", 5)!; // vol 1, like the rest of it
    const beyond = libraryStore.chapter("cliche", 9)!; // vol 2, which it never claimed
    for (const c of [inside, beyond]) {
      c.narration = "done";
      c.duration = 120;
    }
    const update = exportsStore.exportUpdateFor(item);
    expect(update.added).toEqual([5]);
    expect(update.outside).toEqual([9]);
  });

  test("chapters chosen on purpose stay the chapters chosen: the rest is not missing", async () => {
    const item = (await exportsStore.buildExport("starforge", [2, 3], settings()))!;
    finish();
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

  test("an update rebuilds what moved and reuses the rest", async () => {
    // every chapter ready, nothing to ask about: the update simply runs
    const ids = libraryStore
      .chaptersOf("starforge")
      .filter((c) => c.narration === "done")
      .map((c) => c.id);
    const first = (await exportsStore.buildExport("starforge", ids, settings()))!;
    finish();
    const seg = scriptsStore.segmentsOf("starforge", ids[3])[0];
    seg.audio.duration += 5;
    castStore._retime("starforge", ids[3]);

    const next = (await exportsStore.updateExport(first.id))!;
    finish();
    expect(next.version).toBe(2);
    expect(next.rebuilt).toBe(1);
    expect(next.reused).toBe(ids.length - 1);
    expect(next.status).toBe("done");
    expect(first.status).toBe("replaced");
  });

  test("the reuse the plan promises is the reuse the build performs", async () => {
    const ids = [2, 3, 4];
    const first = (await exportsStore.buildExport("starforge", ids, settings({ bitrate: 64 })))!;
    finish();
    // the plan panel and the build ask the same question of the same answer
    expect(exportsStore.exportReuse(first, ids, settings({ bitrate: 64 }))).toEqual(ids);
    expect(exportsStore.exportReuse(first, ids, settings({ bitrate: 128 }))).toEqual([]);
    expect(exportsStore.exportReuse(first, ids, settings({ markerPattern: "{title}" }))).toEqual(
      [],
    );
    expect(sameOutput(first, settings({ cover: "art.jpg" }))).toBe(false);

    // a different bitrate is the same audiobook, built again — as a new version with nothing carried
    const louder = (await exportsStore.buildExport("starforge", ids, settings({ bitrate: 128 })))!;
    finish();
    expect(louder.version).toBe(2);
    expect(louder.reused).toBe(0);
    expect(louder.rebuilt).toBe(ids.length);
  });

  test("a finished export keeps the timeline it played, so a later correction is a difference", async () => {
    const item = (await exportsStore.buildExport(
      "starforge",
      [2, 3],
      settings({ chapterGap: 2 }),
    ))!;
    finish();
    expect(item.timeline!.map((t) => t.id)).toEqual([2, 3]);
    expect(item.timeline!.reduce((a, t) => a + t.duration, 0) + item.chapterGap).toBe(
      item.duration,
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
    const before = chapterSignature(c, segs, DEFAULT_PACING);
    heard[0].pause = 2;
    heard[1].pause = 1;
    expect(chapterSignature(c, segs, DEFAULT_PACING)).not.toBe(before);
  });

  test("the fingerprint covers the clips, the stitched silence and the chapter's state", () => {
    const c = chapter(1, 1, 100);
    const segs = scriptsStore.segmentsOf("starforge", 2);
    const a = chapterSignature(c, segs, DEFAULT_PACING);
    expect(chapterSignature(c, segs, DEFAULT_PACING)).toBe(a);
    expect(chapterSignature(c, segs, { line: 1, turn: 2 })).not.toBe(a);
    expect(chapterSignature({ ...c, narration: "stale" }, segs, DEFAULT_PACING)).not.toBe(a);
  });
});

describe("update and retry ask before they decide", () => {
  beforeEach(freshStores);

  // Both are "this audiobook again". Neither may shrink the selection or accept clips the script has
  // moved under on your behalf — when either would have to, the build goes to the Build tab and the
  // same readiness review that guards a first build guards this one.

  test("a chapter that lost its audio sends the update to the review, not out of the file", async () => {
    const item = (await exportsStore.buildExport("starforge", [2, 3], settings()))!;
    finish();
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
    const item = (await exportsStore.buildExport("starforge", [2, 3], settings()))!;
    finish();
    libraryStore.chapter("starforge", 3)!.narration = "stale";

    expect(await exportsStore.updateExport(item.id)).toBeNull();
    expect(exportsStore._exportDraft!.settings.useStale).toBe(false);
    expect(exportsStore.exports.filter((e) => e.key === item.key)).toHaveLength(1);
  });

  test("an update starts from the settings its export was built with", async () => {
    const item = (await exportsStore.buildExport(
      "starforge",
      [2, 3],
      settings({ markerPattern: "{title}", cover: "art.jpg", volPrefix: false, bitrate: 96 }),
    ))!;
    finish();
    const from = exportsStore.settingsFromExport(item);
    expect(from.markerPattern).toBe("{title}");
    expect(from.cover).toBe("art.jpg");
    expect(from.volPrefix).toBe(false);
    expect(from.bitrate).toBe(96);
    // everything except the one thing that is a decision each time
    expect(from.useStale).toBe(false);
  });

  test("a retry keeps the consent the failed build was started with", async () => {
    demoStore._exportFails = true;
    // ch 1 is stale, and this build accepted it on purpose
    const bad = (await exportsStore.buildExport(
      "starforge",
      [1, 2],
      settings({ useStale: true }),
    ))!;
    finish();
    expect(bad.status).toBe("failed");

    exportsStore.retryExport(bad.id);
    finish();
    expect(exportsStore._exportDraft).toBeNull();
    expect(exportsStore.exportsOf("starforge").find((e) => e.key === bad.key)!.status).toBe("done");
  });

  test("a retry whose chapters moved since it failed goes to the review", async () => {
    demoStore._exportFails = true;
    const bad = (await exportsStore.buildExport("starforge", [2, 3], settings()))!;
    finish();
    libraryStore.chapter("starforge", 2)!.narration = "stale";

    exportsStore.retryExport(bad.id);
    finish();
    expect(exportsStore._exportDraft!.ids).toEqual([2, 3]);
    expect(exportsStore._exportDraft!.settings.useStale).toBe(false);
    // nothing was retried, so the failed attempt is still there to retry
    expect(exportsStore.exports.some((e) => e.id === bad.id)).toBe(true);
  });

  test("one audiobook builds once at a time", async () => {
    const ids = [2, 3, 4];
    const first = (await exportsStore.buildExport("starforge", ids, settings()))!;
    tick();
    expect(first.status).toBe("building");
    expect(await exportsStore.buildExport("starforge", ids, settings())).toBeNull();
    finish();
    expect(exportsStore.exportsOf("starforge").filter((e) => e.key === first.key)).toHaveLength(1);
    expect(exportsStore.exports.filter((e) => e.key === first.key && e.version === 2)).toHaveLength(
      0,
    );
  });

  test("an update only updates an export it would actually replace", async () => {
    const first = (await exportsStore.buildExport("starforge", [2, 3], settings()))!;
    finish();
    // renamed on the way through: a different audiobook, built for the first time
    const other = (await exportsStore.buildExport(
      "starforge",
      [2, 3],
      settings({ filename: "Something Else" }),
      {
        updates: first.id,
      },
    ))!;
    finish();
    expect(other.version).toBe(1);
    expect(other.replaces).toBeNull();
    expect(first.status).toBe("done");
  });
});

describe("the demo scenarios", () => {
  beforeEach(freshStores);

  test("the long book is there to be exported", () => {
    const chapters = libraryStore.chaptersOf("gates");
    expect(chapters.length).toBeGreaterThan(100);
    expect(libraryStore.volumesOf("gates").length).toBeGreaterThan(1);
    expect(chapters.filter((c) => c.narration === "stale").length).toBeGreaterThan(0);
    expect(chapters.filter((c) => c.narration === "none").length).toBeGreaterThan(0);
    const behind = exportsStore.exportsOf("gates").find((e) => e.status === "done")!;
    const update = exportsStore.exportUpdateFor(behind);
    expect(update.added.length).toBeGreaterThan(0);
    expect(update.changed.length).toBeGreaterThan(0);
    expect(update.reusable).toBeGreaterThan(100);
  });
});
