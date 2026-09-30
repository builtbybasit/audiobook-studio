// Bulk re-scripting and bulk re-narration over chapters that are already finished.
//
// Three properties hold this feature together in the browser, and they are what is tested here.
// The runs themselves are the server's, and what a run does to a chapter is tested there
// (`tests/server/`).
//
// **The selection is legible.** What a selection contains and what pressing the button would do to
// it are one calculation, so the summary, the label and the estimate cannot disagree.
//
// **A scope means something.** "Retry failed clips" counts the failed clips and nothing else, and
// the estimate counts that rather than every line in the chapter.
//
// **A run can be stopped and picked up again.** Cancelling asks for what has not finished and
// nothing else; retrying a run's failures asks again for exactly those chapters, as one run, at the
// narrowest scope that covers them.
//
// The book is the demo's `cliche`, read from a seeded demo library the way its pages read it.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useQueryCache } from "@pinia/colada";
import { keys } from "@/queries/keys";

import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

import { narrationTargets, runActionLabel, selectionSummary, skipSummary } from "@/lib/runPlan";
import { newProfile } from "@/lib/scripting";
import { jobsService, setJobsService, type JobsService } from "@/services/jobs";
import type { Job, NarrationScope, PricingConfig } from "@/types";
import { demoServer } from "./support/demoServer";
import { openDemoBook } from "./support/demoBook";
import { flush, testPinia } from "./support/pinia";

let real: JobsService;
let castStore: ReturnType<typeof useCastStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let toasts: string[];

beforeAll(async () => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  await demoServer();
  real = jobsService();
});
beforeEach(async () => {
  setJobsService(real);
  const pinia = testPinia();
  castStore = useCastStore();
  endpointsStore = useEndpointsStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
  toasts = [];
  useUiStore().toast = (msg: string) => (toasts.push(msg), "test");
  await openDemoBook(pinia, BOOK);
});

const BOOK = "cliche";
const chapters = () => libraryStore.chaptersOf(BOOK);
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
});

// ---------- re-narrating ----------

describe("a narration scope", () => {
  test("decides which lines run, and the estimate counts that scope", () => {
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

  test("a chapter with nothing to do at it is left out, with the reason, and the server agrees", async () => {
    route();
    const ch = narratedChapter();
    const plan = narrationStore.narrationRunPlan(BOOK, [ch.id], "failed", true);
    expect(plan.chapters).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("nothing");
    await narrationStore.runNarration(BOOK, [ch.id], { scope: "failed" });
    expect(toasts).toEqual(["Nothing to narrate in this selection"]);
    expect(libraryStore.chapter(BOOK, ch.id)!.narration).toBe("done");
  });

  test("a retake waiting for a verdict is counted whichever way the choice goes", () => {
    route();
    const ch = narratedChapter();
    const line = segments(ch.id).find((s) => s.audio.duration > 0)!;
    line.candidate = { ...line.audio, n: 2, at: Date.now() };

    const kept = narrationStore.narrationRunPlan(BOOK, [ch.id], "all", true);
    expect(kept.pending).toBe(1);
    expect(kept.clips).toBe(segments(ch.id).length - 1);
    // told otherwise, the line joins the run — and the plan still reports the retake, because the
    // count is what the choice is about, not what it happened to leave behind
    const replaced = narrationStore.narrationRunPlan(BOOK, [ch.id], "all", false);
    expect(replaced.pending).toBe(1);
    expect(replaced.clips).toBe(segments(ch.id).length);
  });

  test("the retake choice only counts lines this scope would have rendered", () => {
    route();
    const ch = narratedChapter();
    const line = segments(ch.id).find((s) => s.audio.duration > 0)!;
    line.candidate = { ...line.audio, n: 2, at: Date.now() };

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
});

// ---------- stopping and picking up ----------
//
// What the queue holds is installed as the poll would install it, and the service records what it
// is asked for rather than queueing it: these are about which request the store sends, and the
// server's own tests cover what it does with one.

describe("a run can be stopped and picked up again", () => {
  type Ask =
    | { kind: "narrate"; ids: number[]; scope: NarrationScope }
    | { kind: "script"; ids: number[] }
    | { kind: "cancel"; id: number };
  let asked: Ask[];
  beforeEach(() => {
    asked = [];
    const none = { jobs: [], skipped: [], chapters: libraryStore.chaptersOf(BOOK) };
    setJobsService(
      Object.assign(Object.create(real) as JobsService, {
        narrateChapters: async (_book: string, ids: number[], scope: NarrationScope) => {
          asked.push({ kind: "narrate", ids, scope });
          return none;
        },
        scriptChapters: async (_book: string, ids: number[]) => {
          asked.push({ kind: "script", ids });
          return none;
        },
        cancel: async (id: number) => {
          asked.push({ kind: "cancel", id });
          return jobsStore.jobs.find((j) => j.id === id)!;
        },
      }),
    );
  });

  let nextId = 1000;
  /** A job as the server lists one. Later jobs finish later, the way the queue appends them. */
  function job(over: Partial<Job> & Pick<Job, "kind" | "chapterId" | "status">): Job {
    const id = nextId++;
    const settled = !["queued", "running"].includes(over.status);
    return {
      id,
      bookId: BOOK,
      label: `${over.kind} · ch ${over.chapterId}`,
      progress: settled ? 100 : 0,
      queuedAt: id,
      startedAt: id,
      finishedAt: settled ? id : null,
      cancelled: false,
      ...over,
    };
  }
  const bulk = (id: number, index: number, total: number) => ({ id, op: "Narrate", index, total });
  /**
   * Let a retry read what its blockers are worked out from, and then ask or refuse: a refusal is
   * a toast even for a quiet run.
   */
  const retried = async () => {
    for (let i = 0; i < 100 && !asked.length && !toasts.length; i++) await flush();
  };

  test("cancelling a run asks for what has not finished, and only that", () => {
    const run = [
      job({ kind: "narration", chapterId: 1, status: "done", bulk: bulk(7, 1, 3) }),
      job({ kind: "narration", chapterId: 2, status: "running", bulk: bulk(7, 2, 3) }),
      job({ kind: "narration", chapterId: 3, status: "queued", bulk: bulk(7, 3, 3) }),
    ];
    useQueryCache().setQueryData(keys.jobs, run);
    expect(jobsStore.cancelRun(7)).toBe(2);
    expect(asked).toEqual([
      { kind: "cancel", id: run[1].id },
      { kind: "cancel", id: run[2].id },
    ]);
  });

  test("a run whose replacements failed is retried at the failed scope, which the chapter's status cannot ask for", async () => {
    const ch = narratedChapter();
    const line = segments(ch.id).find((s) => s.audio.duration > 0)!;
    // the replacement failed beside a clip that is still fine, so the chapter still reads as
    // narrated and the failure is only on the clips
    line.candidate = { ...line.audio, status: "failed", duration: 0, n: 2 };
    const failed = job({ kind: "narration", chapterId: ch.id, status: "failed" });
    useQueryCache().setQueryData(keys.jobs, [failed]);
    expect(ch.narration).toBe("done");

    jobsStore.retryJob(failed.id);
    await retried();
    expect(asked).toEqual([{ kind: "narrate", ids: [ch.id], scope: "failed" }]);
  });

  test("a narration job with nothing failed left is retried as missing & changed", async () => {
    const ch = narratedChapter();
    const cancelled = job({ kind: "narration", chapterId: ch.id, status: "cancelled" });
    useQueryCache().setQueryData(keys.jobs, [cancelled]);
    jobsStore.retryJob(cancelled.id);
    await retried();
    expect(asked).toEqual([{ kind: "narrate", ids: [ch.id], scope: "fill" }]);
  });

  test("a re-script that failed is picked up by Retry all failed, and not again once a later run made it good", async () => {
    const ch = chapters().find((c) => c.scripting === "done")!;
    const failed = job({ kind: "scripting", chapterId: ch.id, status: "failed" });
    useQueryCache().setQueryData(keys.jobs, [failed]);
    // the script it was replacing is still the chapter's, so the chapter still reads as scripted
    expect(jobsStore.retryableFailures().map((j) => j.id)).toEqual([failed.id]);
    jobsStore.retryAllFailed();
    // a run first reads what its blockers need and sends any endpoint edit still waiting, then asks
    await retried();
    expect(asked).toEqual([{ kind: "script", ids: [ch.id] }]);

    asked = [];
    useQueryCache().setQueryData(keys.jobs, [
      failed,
      job({ kind: "scripting", chapterId: ch.id, status: "done" }),
    ]);
    expect(jobsStore._supersededBy(failed)).toBe(true);
    jobsStore.retryAllFailed();
    await retried();
    expect(asked).toEqual([]);
  });

  test.each(["scripting", "narration"] as const)(
    "a %s retry is held to the run button's blockers, and says why",
    async (kind) => {
      const ch =
        kind === "scripting" ? chapters().find((c) => c.scripting === "done")! : narratedChapter();
      if (kind === "narration")
        segments(ch.id)[0].candidate = { ...segments(ch.id)[0].audio, status: "failed", n: 2 };
      const failed = job({ kind, chapterId: ch.id, status: "failed" });
      useQueryCache().setQueryData(keys.jobs, [failed]);
      // what the run button would refuse on: a paused endpoint, a paused book
      if (kind === "scripting") profile().enabled = false;
      else libraryStore.bookById(BOOK)!.budget = { cap: null, paused: true };
      jobsStore.retryJob(failed.id);
      await retried();
      expect(asked).toEqual([]);
      expect(toasts).toEqual([
        kind === "scripting" ? "Scripting can’t start yet" : "Narration can’t start yet",
      ]);
    },
  );

  test("a chapter's newest failure is the one Retry all failed picks, not the one a later run fixed", async () => {
    const ch = narratedChapter();
    segments(ch.id)[0].candidate = { ...segments(ch.id)[0].audio, status: "failed", n: 2 };
    const old = job({ kind: "narration", chapterId: ch.id, status: "failed" });
    const fixed = job({ kind: "narration", chapterId: ch.id, status: "done" });
    const current = job({ kind: "narration", chapterId: ch.id, status: "failed" });
    useQueryCache().setQueryData(keys.jobs, [old, fixed, current]);

    expect(jobsStore._supersededBy(old)).toBe(true);
    const retryable = jobsStore.retryableFailures().map((j) => j.id);
    expect(retryable).toEqual([current.id]);
    jobsStore.retryAllFailed();
    await retried();
    expect(asked).toEqual([{ kind: "narrate", ids: [ch.id], scope: "failed" }]);
  });

  test("retrying a run's failures is one run again, not one run per chapter", async () => {
    const run = [
      job({ kind: "narration", chapterId: 1, status: "failed", bulk: bulk(9, 1, 3) }),
      job({ kind: "narration", chapterId: 2, status: "done", bulk: bulk(9, 2, 3) }),
      job({ kind: "narration", chapterId: 3, status: "failed", bulk: bulk(9, 3, 3) }),
    ];
    useQueryCache().setQueryData(keys.jobs, run);
    expect(jobsStore.retryRunFailures(9)).toBe(2);
    await retried();
    expect(asked).toEqual([{ kind: "narrate", ids: [1, 3], scope: "failed" }]);
  });
});

// ---------- speech pricing ----------
//
// A speech rate goes on discount the same way a token rate does. What a clip is charged when it
// lands is the server's; what a run is estimated at before it starts is worked out here.

describe("what a run is estimated at", () => {
  /** The speech endpoint every seeded voice routes to, with a rate card we control. */
  function speechEndpoint(pricing: Partial<PricingConfig> = {}) {
    const ep = endpointsStore.endpoints.find((e) => e.id === "openai")!;
    ep.billing = { unit: "chars", rate: 12 };
    ep.price = 12;
    ep.pricing = {
      cachedInput: null,
      cacheWrite: null,
      timezone: "UTC",
      windows: [],
      promotions: [],
      ...pricing,
    };
    return ep;
  }

  test("each endpoint is priced on its own card, and the estimate says what moved it", () => {
    speechEndpoint({
      promotions: [
        { id: "p", label: "Half price", from: null, until: null, scope: ["model"], percent: 50 },
      ],
    });
    const est = narrationStore.estimate(BOOK, [1], "all");
    const row = est.per.find((e) => e.endpoint.id === "openai");
    expect(row).toBeDefined();
    expect(row!.cost).not.toBeNull();
    expect(row!.why.join(" ")).toContain("Half price");
    // the headline follows the discount; the budget figure does not
    expect(row!.withoutPromotions!).toBeCloseTo(row!.cost! * 2, 8);
    expect(est.withoutPromotions).toBeGreaterThan(est.cost);
    expect(est.cautions.join(" ")).toContain("Budget checks use");
  });

  test("requests routed to an endpoint with no rate make the estimate a floor, not a price", () => {
    const ep = speechEndpoint();
    ep.billing = { unit: "chars", rate: null };
    const est = narrationStore.estimate(BOOK, [1], "all");
    expect(est.unpriced).toBeGreaterThan(0);
    expect(est.per.find((e) => e.endpoint.id === "openai")?.cost).toBeNull();
    expect(est.cautions.join(" ")).toContain("floor");
  });
});
