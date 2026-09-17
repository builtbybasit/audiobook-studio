import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useEndpointsStore } from "@/stores/endpoints";
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
// Bulk re-scripting and bulk re-narration over chapters that are already finished.
//
// Four properties hold this feature together, and they are what is tested here.
//
// **The selection is legible.** What a selection contains and what pressing the button would do to
// it are one calculation, so the summary, the label, the estimate and the work that is queued
// cannot disagree.
//
// **Nothing usable is lost to make room.** A re-script that failed, was cancelled or was overtaken
// leaves the script it was replacing as the chapter's script; a clip being replaced keeps playing
// until its replacement actually lands, and the clip it displaces joins the take list rather than
// disappearing.
//
// **A scope means something.** "Retry failed clips" sends the failed clips and nothing else, and
// the estimate counts that rather than every line in the chapter.
//
// **A run can be stopped and picked up again.** Cancelling keeps what finished and stops what has
// not started; retrying a run's failures does not redo its successes.
import { test, expect, beforeEach, afterEach, spyOn, describe } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { keyring } from "@/lib/keyring";
import {
  chapterNarration,
  narrationTargets,
  runActionLabel,
  selectionSummary,
  skipSummary,
} from "@/lib/runPlan";
import { newProfile } from "@/lib/scripting";
import { reapplyCorrections, SEEDED_KEYS } from "@/mock";
import type { Segment } from "@/types";

let timers = new Map<number, { fn: () => void; repeat: boolean }>();
let clock = 1_000_000;
let restore: (() => void)[] = [];
let castStore: ReturnType<typeof useCastStore>;
let demoStore: ReturnType<typeof useDemoStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let historyStore: ReturnType<typeof useHistoryStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;

function tick() {
  for (const [id, t] of Array.from(timers)) {
    if (!timers.has(id)) continue;
    if (!t.repeat) timers.delete(id);
    t.fn();
  }
}
function drain(max = 400) {
  for (let i = 0; i < max && timers.size; i++) {
    clock += 1000;
    tick();
  }
}

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  castStore = useCastStore();
  demoStore = useDemoStore();
  endpointsStore = useEndpointsStore();
  historyStore = useHistoryStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  uiStore.toast = () => "test";
  jobsStore.jobs = [];
  for (const [id, value] of SEEDED_KEYS) keyring.set(id, value);
  timers = new Map();
  clock = 1_000_000;
  let seq = 0;
  const add = (fn: () => void, repeat: boolean) => {
    timers.set(++seq, { fn, repeat });
    return seq;
  };
  restore = [
    spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) =>
      add(fn, true)) as typeof setInterval),
    spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) =>
      add(fn, false)) as typeof setTimeout),
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
      timers.delete(id);
    }) as typeof clearInterval),
    spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout),
    spyOn(Date, "now").mockImplementation(() => clock),
    // the middle of every simulated coin toss: no rate limits, no failures, no fallback chunks
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());
});
afterEach(() => restore.forEach((f) => f()));

const BOOK = "cliche";
const chapters = () => libraryStore.chaptersOf(BOOK);
const chapter = (id: number) => libraryStore.chapter(BOOK, id)!;
const segments = (id: number) => scriptsStore.segmentsOf(BOOK, id);
/** A scripting endpoint with no key, no price and no chunking surprises. */
function profile(id = "test") {
  const p = newProfile({
    id,
    name: "Test endpoint",
    model: "test-model",
    needsKey: false,
    concurrency: 4,
    maxChars: 4000,
    inPrice: 0,
    outPrice: 0,
    maxOutputTokens: 4000,
  });
  endpointsStore.profiles = [p];
  scriptingStore.scriptSettings.profile = p.id;
  return p;
}
/** Route every speaker at one enabled endpoint, so narration is about the run and not the routing. */
function route() {
  const ep = endpointsStore.endpoints.find((e) => e.id === "local")!;
  ep.enabled = true;
  ep.backoffUntil = 0;
  ep.failRate = 0;
  for (const c of castStore.characters[BOOK]) c.voice = `local/${ep.voices[0].id}`;
  return ep;
}
const narratedChapter = () => chapters().find((c) => c.narration === "done")!;

// ---------- what the selection contains ----------

describe("the selection says what it contains", () => {
  test("a mixed selection is counted by what each chapter is, not by how many there are", () => {
    const scripted = chapters().filter((c) => c.scripting === "done");
    const fresh = chapters().filter((c) => c.scripting === "none");
    const summary = selectionSummary([...fresh.slice(0, 3), ...scripted.slice(0, 5)], "scripting");
    expect(summary.selected).toBe(8);
    expect(summary.counts.new).toBe(3);
    expect(summary.counts.done).toBe(5);
    expect(summary.text).toBe("8 chapters selected: 3 new, 5 already scripted.");
  });

  test("the plan separates new work from replacement, and says why a chapter is left out", () => {
    profile();
    const fresh = chapters()
      .filter((c) => c.scripting === "none")
      .slice(0, 2);
    const done = chapters()
      .filter((c) => c.scripting === "done")
      .slice(0, 3);
    const running = chapters().find((c) => c.scripting === "done" && !done.includes(c))!;
    running.scripting = "running";
    const skipped = chapters().find((c) => c.scripting === "none" && !fresh.includes(c))!;
    skipped.excluded = true;
    const ids = [...fresh, ...done, running, skipped].map((c) => c.id);

    const plan = scriptingStore.scriptPlan(BOOK, ids);
    expect(plan.fresh).toBe(2);
    expect(plan.replace).toBe(3);
    expect(plan.chapters).toHaveLength(5);
    expect(runActionLabel(plan)).toBe("Script 2 · re-script 3");
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(["excluded", "running"]);
    expect(skipSummary(plan)).toBe(
      "2 chapters left out: 1 already running or queued, 1 skipped from the audiobook.",
    );
  });

  test("a whole-book selection and a filtered one are the same calculation", () => {
    profile();
    const all = chapters().map((c) => c.id);
    const half = all.slice(0, Math.ceil(all.length / 2));
    const whole = scriptingStore.scriptPlan(BOOK, all);
    const part = scriptingStore.scriptPlan(BOOK, half);
    expect(whole.chapters.length).toBeGreaterThan(part.chapters.length);
    expect(part.chapters.every((row) => half.includes(row.id))).toBe(true);
  });
});

// ---------- re-scripting ----------

describe("bulk re-scripting", () => {
  test("manual corrections are preserved by default, and the ones that could not be are named", () => {
    profile();
    const ch = chapters().find((c) => c.scripting === "done")!;
    for (const s of segments(ch.id).slice(0, 4)) {
      s.direction = "by hand";
      s.edited = true;
    }
    scriptingStore.runScripting(BOOK, [ch.id]);
    drain();
    const report = scriptsStore.correctionsOf(BOOK, ch.id)!;
    expect(report.asked).toBe(true);
    expect(report.kept + report.unmatched.length).toBe(4);
    // whatever it says it kept, it really did: every re-applied correction is on the new script
    const carried = segments(ch.id).filter((s) => s.edited && s.direction === "by hand");
    expect(carried).toHaveLength(report.kept);
    // and nothing it could not carry is quietly claimed as carried
    for (const u of report.unmatched)
      expect(segments(ch.id).some((s) => s.text === u.text && s.edited)).toBe(false);
  });

  test("turning preservation off says so rather than pretending the corrections survived", () => {
    profile();
    const ch = chapters().find((c) => c.scripting === "done")!;
    for (const s of segments(ch.id).slice(0, 3)) {
      s.direction = "by hand";
      s.edited = true;
    }
    scriptingStore.runScripting(BOOK, [ch.id], { keepEdits: false });
    drain();
    const report = scriptsStore.correctionsOf(BOOK, ch.id)!;
    expect(report.asked).toBe(false);
    expect(report.kept).toBe(0);
    expect(report.unmatched).toHaveLength(3);
  });

  test("a correction is carried by the line it was made on, once", () => {
    const prev: Segment[] = [
      {
        id: 1,
        type: "dialogue",
        speaker: "Ji Ning",
        text: "Say it again.",
        direction: "flat",
        edited: true,
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      },
      {
        id: 2,
        type: "narration",
        speaker: "Narrator",
        text: "The hall went quiet.",
        direction: "",
        edited: true,
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      },
    ];
    const next: Segment[] = [
      {
        id: 1,
        type: "narration",
        speaker: "Narrator",
        text: "Say it again.",
        direction: "",
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      },
      {
        id: 2,
        type: "narration",
        speaker: "Narrator",
        text: "The hall went quiet, and stayed quiet.",
        direction: "",
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      },
    ];
    const report = reapplyCorrections(prev, next, true);
    expect(report.kept).toBe(1);
    expect(next[0].speaker).toBe("Ji Ning");
    expect(next[0].direction).toBe("flat");
    expect(report.unmatched).toHaveLength(1);
    expect(report.unmatched[0].text).toBe("The hall went quiet.");
  });

  test("a replacement that fails leaves the chapter with the script it had", () => {
    profile();
    const ch = chapters().find((c) => c.scripting === "done")!;
    const before = segments(ch.id)
      .map((s) => s.text)
      .join("|");
    spyOn(Math, "random").mockReturnValue(0.01); // the verifier rejects this run
    scriptingStore.runScripting(BOOK, [ch.id]);
    drain();
    expect(jobsStore.jobs.at(-1)!.status).toBe("failed");
    expect(
      segments(ch.id)
        .map((s) => s.text)
        .join("|"),
    ).toBe(before);
    // and the chapter still reads as scripted, so it is still narratable and still exportable
    expect(ch.scripting).toBe("done");
    expect(historyStore.versionsOf(BOOK, ch.id)).toHaveLength(0);
  });

  test("a cancelled run keeps the chapters it finished and never starts the rest", () => {
    profile();
    const done = chapters()
      .filter((c) => c.scripting === "done")
      .slice(0, 3);
    const ids = done.map((c) => c.id);
    const before = ids.map((id) =>
      segments(id)
        .map((s) => s.text)
        .join("|"),
    );
    scriptingStore.runScripting(BOOK, ids);
    // let the first chapter finish, then stop the run
    for (let i = 0; i < 60 && chapter(ids[1]).scripting === "queued"; i++) {
      clock += 1000;
      tick();
    }
    const runId = jobsStore.jobs.find((j) => j.bulk)!.bulk!.id;
    expect(jobsStore.cancelRun(runId)).toBeGreaterThan(0);
    drain();

    const rows = jobsStore.runJobs(runId);
    expect(rows).toHaveLength(3);
    expect(rows[0].status).toBe("done");
    expect(rows.slice(1).every((j) => j.status === "cancelled")).toBe(true);
    // the replacement that landed is kept; the chapters that never ran are untouched
    expect(
      segments(ids[0])
        .map((s) => s.text)
        .join("|"),
    ).not.toBe(before[0]);
    expect(
      segments(ids[1])
        .map((s) => s.text)
        .join("|"),
    ).toBe(before[1]);
    expect(
      segments(ids[2])
        .map((s) => s.text)
        .join("|"),
    ).toBe(before[2]);
    for (const c of done) expect(c.scripting).toBe("done");
  });

  test("a chapter already running is not queued twice", () => {
    profile();
    const ch = chapters().find((c) => c.scripting === "done")!;
    scriptingStore.runScripting(BOOK, [ch.id]);
    const first = jobsStore.jobs.filter((j) => j.kind === "scripting").length;
    scriptingStore.runScripting(BOOK, [ch.id]);
    expect(jobsStore.jobs.filter((j) => j.kind === "scripting")).toHaveLength(first);
    drain();
  });

  test("a result from a run the chapter has moved on from is discarded", () => {
    profile();
    const ch = chapters().find((c) => c.scripting === "done")!;
    scriptingStore.runScripting(BOOK, [ch.id]);
    tick();
    // something else claims the chapter while the requests are in flight — a newer run, a restore
    const before = segments(ch.id)
      .map((s) => s.text)
      .join("|");
    ch.rescript = { keepEdits: true, was: "done", token: -1 };
    drain();
    const job = jobsStore.jobs.at(-1)!;
    expect(job.status).toBe("cancelled");
    expect(job.activity!.some((e) => e.message.startsWith("Result discarded"))).toBe(true);
    expect(
      segments(ch.id)
        .map((s) => s.text)
        .join("|"),
    ).toBe(before);
    expect(ch.scripting).toBe("done");
  });
});

// ---------- re-narrating ----------

describe("bulk re-narration", () => {
  test("a scope decides which lines run, and the estimate counts that scope", () => {
    route();
    const ch = narratedChapter();
    const segs = segments(ch.id);
    segs[0].audio.status = "failed";
    segs[0].audio.duration = 0;
    segs[1].audio.status = "stale";
    const ids = [ch.id];

    expect(narrationTargets(segs, "failed", true).run).toHaveLength(1);
    expect(narrationTargets(segs, "fill", true).run).toHaveLength(2);
    expect(narrationTargets(segs, "all", true).run).toHaveLength(segs.length);

    const failed = narrationStore.estimate(BOOK, ids, "failed");
    const fill = narrationStore.estimate(BOOK, ids, "fill");
    const all = narrationStore.estimate(BOOK, ids, "all");
    expect(failed.segments).toBe(1);
    expect(fill.segments).toBe(2);
    expect(all.segments).toBe(segs.length);
    expect(failed.chars).toBeLessThan(all.chars);
    expect(failed.requests).toBeLessThan(all.requests);
    expect(all.replacing).toBe(segs.filter((s) => s.audio.duration > 0).length);
  });

  test("a chapter with nothing to do at this scope is left out, with the reason", () => {
    route();
    const ch = narratedChapter();
    const plan = narrationStore.narrationRunPlan(BOOK, [ch.id], "failed", true);
    expect(plan.chapters).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("nothing");
    narrationStore.runNarration(BOOK, [ch.id], { scope: "failed" });
    expect(jobsStore.jobs.filter((j) => j.kind === "narration")).toHaveLength(0);
  });

  test("a clip keeps playing until its replacement lands, then joins the take list", () => {
    route();
    const ch = narratedChapter();
    const line = segments(ch.id).find((s) => s.audio.duration > 0)!;
    const wasDuration = line.audio.duration;
    const wasAt = line.audio.at;

    narrationStore.runNarration(BOOK, [ch.id], { scope: "all" });
    // the replacement renders beside the clip; the book's own clip is untouched and still playable
    expect(line.candidate).toBeDefined();
    expect(line.candidate!.auto).toBe(true);
    expect(line.audio.duration).toBe(wasDuration);
    expect(line.audio.at).toBe(wasAt);

    drain();
    expect(line.candidate).toBeUndefined();
    expect(line.audio.duration).toBeGreaterThan(0);
    expect(line.audio.n).toBe(2);
    // the clip it displaced is kept rather than thrown away
    expect(line.audio.takes).toHaveLength(1);
    expect(line.audio.takes![0].duration).toBe(wasDuration);
    expect(ch.narration).toBe("done");
  });

  test("a replacement that fails changes nothing, and only it is retried", () => {
    const ep = route();
    const ch = narratedChapter();
    const segs = segments(ch.id);
    const before = segs.map((s) => s.audio.duration);
    ep.failRate = 1; // every request this run sends comes back an error
    narrationStore.runNarration(BOOK, [ch.id], { scope: "all" });
    drain();

    expect(jobsStore.jobs.at(-1)!.status).toBe("failed");
    // every clip in the book is exactly as it was, and the chapter still reads as narrated
    expect(segs.map((s) => s.audio.duration)).toEqual(before);
    expect(ch.narration).toBe("done");
    const failed = segs.filter((s) => s.candidate?.status === "failed").length;
    expect(failed).toBe(segs.length);

    ep.failRate = 0;
    narrationStore.retryFailed(BOOK, ch.id);
    drain();
    expect(segs.every((s) => !s.candidate)).toBe(true);
    expect(segs.every((s) => s.audio.status === "done")).toBe(true);
  });

  test("a retake waiting for a verdict is left alone unless the run is told otherwise", () => {
    route();
    const ch = narratedChapter();
    const line = segments(ch.id).find((s) => s.audio.duration > 0)!;
    line.candidate = { ...line.audio, n: 2, at: clock };
    const takeToJudge = line.candidate.duration;

    const kept = narrationStore.narrationRunPlan(BOOK, [ch.id], "all", true);
    expect(kept.pending).toBe(1);
    expect(kept.clips).toBe(segments(ch.id).length - 1);
    narrationStore.runNarration(BOOK, [ch.id], { scope: "all", keepPending: true });
    drain();
    // the comparison the listener started is still theirs to judge
    expect(line.candidate).toBeDefined();
    expect(line.candidate!.duration).toBe(takeToJudge);

    // told otherwise, the line joins the run — and the plan still reports the retake, because the
    // count is what the choice is about, not what it happened to leave behind
    const replaced = narrationStore.narrationRunPlan(BOOK, [ch.id], "all", false);
    expect(replaced.pending).toBe(1);
    expect(replaced.clips).toBe(segments(ch.id).length);

    narrationStore.runNarration(BOOK, [ch.id], { scope: "all", keepPending: false });
    drain();
    // the retake was replaced, not deleted: it is in the take list, marked as not kept, and the
    // clip that was in the book is there too — both are still playable
    expect(line.candidate).toBeUndefined();
    expect(line.audio.duration).toBeGreaterThan(0);
    const takes = line.audio.takes ?? [];
    expect(takes.some((t) => t.duration === takeToJudge && t.rejected)).toBe(true);
    // and the new clip did not reuse a take number the line had already handed out
    expect(takes.every((t) => t.n !== line.audio.n)).toBe(true);
  });

  test("the retake choice only counts lines this scope would have rendered", () => {
    route();
    const ch = narratedChapter();
    const line = segments(ch.id).find((s) => s.audio.duration > 0)!;
    line.candidate = { ...line.audio, n: 2, at: clock };

    // "missing & changed" has no reason to touch a line whose clip is current, so there is nothing
    // for the choice to decide there — and the plan does not claim it left anything alone
    for (const keep of [true, false]) {
      const fill = narrationStore.narrationRunPlan(BOOK, [ch.id], "fill", keep);
      expect(fill.pending).toBe(0);
      expect(fill.clips).toBe(0);
      expect(narrationStore.estimate(BOOK, [ch.id], "fill", keep).pending).toBe(0);
    }
    // the scope that would render it is the one that asks
    expect(narrationStore.narrationRunPlan(BOOK, [ch.id], "all", true).pending).toBe(1);
  });

  test("cancelling keeps the replacements that landed and starts nothing else", () => {
    route();
    const ch = narratedChapter();
    const segs = segments(ch.id);
    narrationStore.runNarration(BOOK, [ch.id], { scope: "all" });
    tick();
    tick();
    const landed = segs.filter((s) => s.audio.n === 2).length;
    jobsStore.cancelJob(jobsStore.jobs.at(-1)!.id);
    drain();

    expect(jobsStore.jobs.at(-1)!.status).toBe("cancelled");
    // nothing is left queued, every clip is still playable, and what did land was kept
    expect(segs.every((s) => s.audio.duration > 0)).toBe(true);
    expect(segs.filter((s) => s.audio.n === 2).length).toBeGreaterThanOrEqual(landed);
    expect(segs.every((s) => !s.candidate || s.candidate.status !== "queued")).toBe(true);
    expect(ch.narration).toBe(chapterNarration(segs));
  });

  test("a bulk run is one run in the queue, and its failures retry without its successes", () => {
    route();
    const narrated = chapters()
      .filter((c) => c.narration === "done")
      .slice(0, 2);
    for (const s of segments(narrated[1].id).slice(0, 2)) {
      s.audio.status = "failed";
      s.audio.duration = 0;
    }
    narrated[1].narration = "failed";
    narrationStore.runNarration(
      BOOK,
      narrated.map((c) => c.id),
      { scope: "failed" },
    );
    // only the chapter with failed clips is in the run
    const rows = jobsStore.jobs.filter((j) => j.kind === "narration" && j.bulk);
    expect(rows).toHaveLength(1);
    expect(rows[0].bulk!.scope).toBe("Failed only");
    expect(rows[0].chapterId).toBe(narrated[1].id);
    drain();
    expect(segments(narrated[1].id).every((s) => s.audio.status === "done")).toBe(true);
  });

  test("a run whose replacements failed is picked up by Retry, which the chapter's status cannot ask for", () => {
    const ep = route();
    const ch = narratedChapter();
    ep.failRate = 1;
    narrationStore.runNarration(BOOK, [ch.id], { scope: "all" });
    drain();
    const job = jobsStore.jobs.at(-1)!;
    expect(job.status).toBe("failed");
    // the chapter still reads as narrated — its own clips were never touched — so the retry has to
    // find the failures on the clips
    expect(ch.narration).toBe("done");

    ep.failRate = 0;
    jobsStore.retryJob(job.id);
    const retry = jobsStore.jobs.at(-1)!;
    expect(retry.id).not.toBe(job.id);
    expect(retry.bulk!.scope).toBe("Failed only");
    drain();
    expect(segments(ch.id).every((s) => !s.candidate)).toBe(true);
    expect(segments(ch.id).every((s) => s.audio.n === 2)).toBe(true);
  });

  test("a re-script that failed is retried by Retry all failed, though the chapter reads as scripted", () => {
    profile();
    const ch = chapters().find((c) => c.scripting === "done")!;
    const rnd = spyOn(Math, "random").mockReturnValue(0.01); // the verifier rejects this run
    scriptingStore.runScripting(BOOK, [ch.id]);
    drain();
    const failed = jobsStore.jobs.at(-1)!;
    expect(failed.status).toBe("failed");
    expect(ch.scripting).toBe("done"); // the script it was replacing is still the chapter's script

    rnd.mockReturnValue(0.5);
    jobsStore.retryAllFailed();
    expect(jobsStore.jobs.at(-1)!.id).not.toBe(failed.id);
    drain();
    expect(jobsStore.jobs.at(-1)!.status).toBe("done");
    expect(segments(ch.id).length).toBeGreaterThan(0);
    // and a failure a later run already made good is not run a third time
    const settled = jobsStore.jobs.length;
    jobsStore.retryAllFailed();
    expect(jobsStore.jobs.length).toBe(settled);
  });

  test("retrying a run's failures is one run again, not one run per chapter", () => {
    const ep = route();
    const narrated = chapters()
      .filter((c) => c.narration === "done")
      .slice(0, 3);
    expect(narrated.length).toBeGreaterThan(1); // a run worth grouping
    ep.failRate = 1;
    narrationStore.runNarration(
      BOOK,
      narrated.map((c) => c.id),
      { scope: "all" },
    );
    drain();
    const runId = jobsStore.jobs.at(-1)!.bulk!.id;
    const failed = jobsStore.runJobs(runId).filter((j) => j.status === "failed");
    expect(failed.length).toBe(narrated.length);

    ep.failRate = 0;
    expect(jobsStore.retryRunFailures(runId)).toBe(failed.length);
    const retried = jobsStore.jobs.filter((j) => j.bulk && j.bulk.id !== runId && !j.finishedAt);
    expect(retried).toHaveLength(failed.length);
    expect(new Set(retried.map((j) => j.bulk!.id)).size).toBe(1);
    expect(retried.every((j) => j.bulk!.total === failed.length)).toBe(true);
    expect(retried.every((j) => j.bulk!.scope === "Failed only")).toBe(true);
  });

  test("a replacement-only run does not claim to be finished before it starts", () => {
    route();
    const ch = narratedChapter();
    narrationStore.runNarration(BOOK, [ch.id], { scope: "all" });
    const job = jobsStore.jobs.at(-1)!;
    // dispatch is synchronous: every playable clip is now rendering a replacement beside itself
    const replacing = segments(ch.id).filter((s) => s.candidate?.auto).length;
    expect(replacing).toBe(segments(ch.id).filter((s) => s.audio.duration > 0).length);
    tick();
    expect(job.progress).toBeLessThan(100);
    drain();
    expect(job.progress).toBe(100);
  });
});

// ---------- the demo world ----------

describe("the seeded situations", () => {
  test("the mixed row really does contain every state a run has to tell apart", () => {
    expect(demoStore.applyScenario("bulk-rework")).toBeTruthy();
    const list = chapters().filter((c) => !c.excluded);
    expect(list.some((c) => c.scripting === "none")).toBe(true);
    expect(list.some((c) => c.scripting === "done")).toBe(true);
    expect(list.some((c) => c.scripting === "failed")).toBe(true);
    expect(list.some((c) => c.narration === "stale")).toBe(true);
    expect(list.some((c) => c.narration === "failed")).toBe(true);
    const all = list.flatMap((c) => segments(c.id));
    expect(all.some((s) => s.edited)).toBe(true);
    expect(all.some((s) => s.candidate && s.candidate.duration > 0)).toBe(true);
  });

  test("the recovery row leaves every earlier script and recording usable", () => {
    expect(demoStore.applyScenario("bulk-recovery")).toBeTruthy();
    const run = jobsStore.jobs.filter((j) => j.bulk?.id === 1);
    expect(run).toHaveLength(4);
    expect(run.map((j) => j.status)).toEqual(["done", "done", "failed", "cancelled"]);
    // the chapters whose replacement produced nothing still have a script
    for (const j of run) {
      const c = chapter(j.chapterId!);
      expect(c.scripting).toBe("done");
      expect(segments(c.id).length).toBeGreaterThan(0);
    }
    // and every clip whose replacement failed is still the clip in the book
    const failedReplacements = chapters().flatMap((c) =>
      segments(c.id).filter((s) => s.candidate?.status === "failed"),
    );
    expect(failedReplacements.length).toBeGreaterThan(0);
    expect(failedReplacements.every((s) => s.audio.status === "done" && s.audio.duration > 0)).toBe(
      true,
    );
  });

  test("a run started by hand is never filed under a seeded run", () => {
    profile();
    route();
    expect(demoStore.applyScenario("bulk-recovery")).toBeTruthy();
    const seeded = new Set(jobsStore.jobs.map((j) => j.bulk?.id).filter((id) => id !== undefined));
    expect(seeded.size).toBeGreaterThan(0);

    const ch = chapters().find((c) => c.scripting === "done" && !c.excluded)!;
    scriptingStore.runScripting(BOOK, [ch.id]);
    const started = jobsStore.jobs.at(-1)!.bulk!.id;
    expect(seeded.has(started)).toBe(false);
    // and the run's own controls act on this run alone
    expect(jobsStore.runJobs(started)).toHaveLength(1);
    for (const id of seeded)
      expect(jobsStore.runJobs(id).every((j) => j.bulk!.id === id)).toBe(true);
  });

  test("switching scenario and resetting both clear bulk work in flight", () => {
    profile();
    route();
    const ch = chapters().find((c) => c.scripting === "done")!;
    scriptingStore.runScripting(BOOK, [ch.id, ch.id + 1]);
    narrationStore.runNarration(BOOK, [narratedChapter().id], { scope: "all" });
    tick();
    expect(jobsStore.activeJobs.length).toBeGreaterThan(0);

    demoStore.resetDemo();
    expect(jobsStore.jobs.every((j) => !!j.finishedAt)).toBe(true);
    // nothing half-replaced survives the reset: no chapter is left queued and no replacement pending
    expect(chapters().every((c) => !["queued", "running"].includes(c.scripting))).toBe(true);
    expect(chapters().every((c) => !["queued", "running"].includes(c.narration))).toBe(true);
    expect(
      chapters().every((c) => segments(c.id).every((s) => !s.candidate || !s.candidate.auto)),
    ).toBe(true);
    // and the abandoned run's timers write nothing into the world that replaced it
    const signature = chapters()
      .map((c) => `${c.scripting}:${c.narration}`)
      .join("|");
    drain();
    expect(
      chapters()
        .map((c) => `${c.scripting}:${c.narration}`)
        .join("|"),
    ).toBe(signature);
  });
});
