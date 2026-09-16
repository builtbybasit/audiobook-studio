import { useCastStore } from "@/stores/cast";
import { useDemoStore } from "@/stores/demo";
import { useEndpointsStore } from "@/stores/endpoints";
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
// The Demo tools: the scenarios behind the panel, and the two properties that make them worth
// having.
//
// A scenario is *repeatable*: it is applied to the seeded world rather than on top of whatever the
// last one left, so picking a row twice — or picking three others in between — gives the same
// situation. And a scenario switch is *safe while work is running*: the simulated runs of the world
// you just left are abandoned where they stand, so a clip, a chapter or a build that was in flight
// cannot land in the situation you are looking at now.
//
// The simulated runs are timer-driven, so the clock and both timer APIs are faked here.
import { test, expect, beforeEach, afterEach, spyOn, describe } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { clock as simClock, demoScenarios, DEMO_GROUPS, simMs } from "@/mock";
import { isScripted } from "@/lib/scriptReview";

let timers = new Map<number, { fn: () => void; repeat: boolean }>();
let clock = 1_000_000;
let restore: (() => void)[] = [];
let castStore: ReturnType<typeof useCastStore>;
let demoStore: ReturnType<typeof useDemoStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let exportsStore: ReturnType<typeof useExportsStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;

/** Fire every pending timer once; a one-shot is spent, an interval stays. */
function tick() {
  for (const [id, t] of Array.from(timers)) {
    if (!timers.has(id)) continue;
    if (!t.repeat) timers.delete(id);
    t.fn();
  }
}
function drain(max = 300) {
  for (let i = 0; i < max && timers.size; i++) tick();
}

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
  castStore = useCastStore();
  demoStore = useDemoStore();
  endpointsStore = useEndpointsStore();
  exportsStore = useExportsStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  uiStore.toast = () => "test";
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
    spyOn(Date, "now").mockImplementation(() => (clock += 1)),
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());
});
afterEach(() => restore.forEach((f) => f()));

const digest = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16) + ":" + s.length;
};

/**
 * Everything a scenario is allowed to touch, digested. Timestamps are left out on purpose: the
 * queue's sample history is re-dated from the clock every time it is seeded, and "the same
 * situation" means the same books, scripts, cast, jobs and exports — not the same afternoon.
 */
const worldState = (): string =>
  digest(
    JSON.stringify({
      books: libraryStore.books,
      chapters: libraryStore.chapters,
      characters: castStore.characters,
      lexicon: castStore.lexicon,
      segments: Object.entries(scriptsStore.segments).sort(([a], [b]) => a.localeCompare(b)),
      previous: Object.keys(scriptsStore._previous).sort(),
      exports: exportsStore.exports.map((e) => [e.bookId, e.key, e.version, e.status, e.chapters]),
      jobs: jobsStore.jobs.map((j) => [j.kind, j.bookId, j.chapterId, j.status, j.label]),
      usage: jobsStore.scriptUsage,
      endpoints: endpointsStore.endpoints.map((e) => [
        e.id,
        e.enabled,
        e.failures,
        e.rateLimits,
        e.voices.length,
      ]),
      profiles: endpointsStore.profiles.map((p) => [p.id, p.enabled, p.model]),
    }),
  );

describe("the scenario catalogue", () => {
  test("every row names a book that exists, a group that is listed, and its own id", () => {
    const rows = demoScenarios();
    const groups = new Set(DEMO_GROUPS.map((g) => g.id));
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      // an import row creates the book it opens on; every other row names a seeded one
      if (r.group !== "import") expect(libraryStore.bookById(r.bookId), r.id).toBeDefined();
      expect(groups.has(r.group), r.id).toBe(true);
      expect(r.name.length, r.id).toBeGreaterThan(0);
      expect(r.blurb.length, r.id).toBeGreaterThan(0);
      expect(r.path.startsWith("/"), r.id).toBe(true);
    }
  });

  test("fresh rows every call, so the panel cannot write back into the catalogue", () => {
    expect(demoScenarios()).not.toBe(demoScenarios());
    expect(demoScenarios()[0]).toEqual(demoScenarios()[0]);
  });
  test("every row says what to try once it is applied", () => {
    for (const s of demoScenarios()) {
      expect(s.steps?.length ?? 0).toBeGreaterThan(0);
      for (const step of s.steps ?? []) expect(step.trim().length).toBeGreaterThan(10);
    }
  });
});

describe("applying a scenario", () => {
  test("every scenario applies, opens a page and leaves the world it describes", () => {
    const seeded = worldState();
    for (const s of demoScenarios()) {
      const to = demoStore.applyScenario(s.id);
      expect(to, s.id).toBeTruthy();
      expect(to!.startsWith("/"), s.id).toBe(true);
      expect(demoStore.activeScenario?.id, s.id).toBe(s.id);
      // a scenario that changed nothing at all would be a row with nothing to test
      if (s.id !== "resume-book" && s.id !== "mixed" && s.id !== "update")
        expect(worldState(), `${s.id} changed nothing`).not.toBe(seeded);
      demoStore.resetDemo();
      drain();
      expect(worldState(), `${s.id} did not reset cleanly`).toBe(seeded);
      expect(demoStore.activeScenario).toBeNull();
    }
  });

  test("a scenario applied after others is the same as one applied first", () => {
    demoStore.applyScenario("no-voices");
    const first = worldState();

    demoStore.resetDemo();
    demoStore.applyScenario("stale-audio");
    demoStore.applyScenario("budget-spent");
    drain(); // let anything those started run to wherever it gets to
    demoStore.applyScenario("no-voices");
    expect(worldState()).toBe(first);
  });

  test("applying one does not carry the last one's leftovers into it", () => {
    demoStore.applyScenario("fresh-book");
    expect(scriptsStore.segmentsOf("drowned", 1)).toHaveLength(0);
    // straight into a scenario about another book: the first book is seeded again, not left empty
    demoStore.applyScenario("stale-audio");
    expect(scriptsStore.segmentsOf("drowned", 1).length).toBeGreaterThan(0);
    expect(castStore.charactersOf("drowned").length).toBeGreaterThan(1);
  });

  test("reset puts back the demo credentials a scenario took away", async () => {
    const { keyring } = await import("@/lib/keyring");
    keyring.set("profile:openai", "");
    expect(keyring.has("profile:openai")).toBe(false);
    demoStore.resetDemo();
    expect(keyring.has("profile:openai")).toBe(true);
  });
});

describe("switching scenarios while work is running", () => {
  test("a run in flight cannot write into the scenario that replaced it", () => {
    scriptingStore.runScripting("cliche", [13, 14]);
    narrationStore.runNarration("cliche", [5]);
    tick();
    tick();
    expect(jobsStore.activeJobs.length).toBeGreaterThan(0);

    demoStore.applyScenario("fresh-book");
    const after = worldState();
    expect(jobsStore.activeJobs).toHaveLength(0);

    drain(); // every abandoned timer fires — none of them may land
    expect(worldState()).toBe(after);
    expect(jobsStore.activeJobs).toHaveLength(0);
  });

  test("a build in flight cannot finish into the world that replaced it", () => {
    demoStore.applyScenario("builds");
    const building = exportsStore.exports.filter((e) => e.status === "building");
    expect(building.length).toBeGreaterThan(0);
    tick();

    demoStore.applyScenario("fresh-book");
    const after = worldState();
    drain();
    expect(worldState()).toBe(after);
    // the abandoned build did not come back as a finished audiobook in the new world
    expect(exportsStore.exports.some((e) => e.status === "building")).toBe(false);
  });

  test("reset stops running work rather than leaving the queue pretending", () => {
    scriptingStore.runScripting("cliche", [13]);
    tick();
    demoStore.resetDemo();
    expect(jobsStore.activeJobs).toHaveLength(0);
    const after = worldState();
    drain();
    expect(worldState()).toBe(after);
  });

  test("the startup runs do not fire into a scenario applied before they land", () => {
    demoStore.demoKick();
    demoStore.applyScenario("fresh-book");
    const after = worldState();
    drain();
    expect(worldState()).toBe(after);
  });
});

describe("the speed of simulated work", () => {
  test("shortens the waits, survives a reset, and leaves the recorded latency alone", () => {
    try {
      demoStore.setSpeed(4);
      expect(simClock.speed).toBe(4);
      expect(simMs(400)).toBe(100);
      demoStore.resetDemo();
      expect(demoStore._speed).toBe(4);
      // a narration run at 4×: the clip still records the provider's latency, not the shortened wait
      demoStore.applyScenario("fresh-book");
      scriptingStore.runScripting("drowned", [1]);
      drain();
      narrationStore.runNarration("drowned", [1]);
      drain();
      const rendered = scriptsStore.segmentsOf("drowned", 1).filter((s) => s.audio.duration > 0);
      expect(rendered.length).toBeGreaterThan(0);
      for (const s of rendered) expect(s.audio.ms).toBeGreaterThan(100);
    } finally {
      demoStore.setSpeed(1);
    }
  });
});

describe("what a reset has to reach", () => {
  test("it leaves no simulated timer behind", () => {
    demoStore.applyScenario("builds");
    tick();
    expect(timers.size).toBeGreaterThan(0);

    demoStore.resetDemo();
    drain();
    // an abandoned build settles its job from outside `step`, so the interval has to drop itself
    expect(timers.size).toBe(0);
  });

  test("it drops a book the seeded world does not have, and says so first", () => {
    const id = libraryStore.addNovel("brand-new.epub", "Brand New");
    uiStore.currentBookId = id;
    expect(demoStore.survivesReset(id)).toBe(false);
    expect(demoStore.survivesReset("cliche")).toBe(true);

    demoStore.resetDemo();
    expect(libraryStore.bookById(id)).toBeUndefined();
    // nothing may still be pointed at it — a page open on that book has to have been sent away
    expect(uiStore.currentBookId).toBeNull();
  });

  test("it clears page state that lives outside the store", async () => {
    const { ui, draftFor, draftDirty } = await import("@/views/endpoints/state");
    const { unifyEndpoint } = await import("@/lib/endpoints");
    const endpoint = unifyEndpoint(endpointsStore.endpoints[0]);
    const draft = draftFor(endpoint);
    draft.model = "half-typed-model";
    ui.selected = endpoint.key;
    expect(draftDirty(endpoint)).toBe(true);

    demoStore.resetDemo();
    expect(ui.drafts).toEqual({});
    expect(ui.selected).toBeNull();
    // and the form rebuilt from the restored endpoint claims no unsaved changes
    expect(draftDirty(unifyEndpoint(endpointsStore.endpoints[0]))).toBe(false);
  });

  test("seeding a second book's Search demo puts the first one back", () => {
    const before = worldState();
    demoStore.seedSearchDemo("cliche");
    demoStore.seedSearchDemo("starforge");
    demoStore.resetSearchDemo();
    // one Reset cannot undo two books, so the second seeding restores the first
    expect(worldState()).toBe(before);
  });
});

describe("what each situation puts on screen", () => {
  test("a new book has chapters to choose and nothing else", () => {
    demoStore.applyScenario("fresh-book");
    const chapters = libraryStore.chaptersOf("drowned");
    expect(chapters.length).toBeGreaterThan(0);
    expect(chapters.every((c) => c.scripting === "none" && c.narration === "none")).toBe(true);
    expect(chapters.some((c) => c.excluded)).toBe(true);
    expect(castStore.charactersOf("drowned").map((c) => c.name)).toEqual(["Narrator"]);
    expect(exportsStore.exportsOf("drowned")).toHaveLength(0);
    expect(jobsStore.jobs.some((j) => j.bookId === "drowned")).toBe(false);
  });

  test("a part-way book has work finished, work failed and work running", () => {
    demoStore.applyScenario("resume-book");
    const chapters = libraryStore.chaptersOf("cliche");
    expect(chapters.filter(isScripted).length).toBeGreaterThan(0);
    expect(chapters.some((c) => c.narration === "done")).toBe(true);
    expect(chapters.some((c) => c.narration === "failed" || c.scripting === "failed")).toBe(true);
    expect(jobsStore.activeJobs.some((j) => j.bookId === "cliche")).toBe(true);
  });

  test("failed scripting leaves retryable rows and an endpoint in cooldown", () => {
    demoStore.applyScenario("scripting-failed");
    const failed = libraryStore.chaptersOf("drowned").filter((c) => c.scripting === "failed");
    expect(failed.length).toBe(2);
    for (const c of failed) expect(scriptsStore.segmentsOf("drowned", c.id)).toHaveLength(0);
    const rows = jobsStore.jobs.filter(
      (j) => j.bookId === "drowned" && j.kind === "scripting" && j.status === "failed",
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const telemetry = jobsStore.scriptTelemetry[endpointsStore.profiles[0].id];
    expect(telemetry.rateLimits).toBeGreaterThan(0);
    expect(telemetry.backoffUntil).toBeGreaterThan(Date.now());
    expect(telemetry.lastError?.code).toBe(429);

    // the row can actually be diagnosed: its account runs in order, inside the run's own span,
    // and ends on the reason it failed
    const events = rows[0].activity!;
    expect(events.length).toBeGreaterThan(2);
    const at = events.map((e) => e.at);
    expect(at).toEqual(at.slice().sort((a, b) => a - b));
    expect(events[0].at).toBeGreaterThanOrEqual(rows[0].queuedAt);
    expect(events.at(-1)!.at).toBeLessThanOrEqual(rows[0].finishedAt!);
    expect(events.some((e) => e.level === "error")).toBe(true);
    expect(events.some((e) => /429|rate limited/i.test(e.message))).toBe(true);

    // and the retry the queue offers actually runs: the cooldown is a wait, not a dead end
    jobsStore.retryJob(rows[0].id);
    expect(jobsStore.activeJobs.length).toBeGreaterThan(0);
  });

  test("failed narration leaves failed clips beside finished ones, and a backed-off endpoint", () => {
    demoStore.applyScenario("narration-failed");
    const failedChapters = libraryStore
      .chaptersOf("cliche")
      .filter((c) => c.narration === "failed");
    expect(failedChapters.length).toBeGreaterThan(1);
    const partial = failedChapters.at(-1)!;
    const segs = scriptsStore.segmentsOf("cliche", partial.id);
    expect(segs.some((s) => s.audio.status === "failed")).toBe(true);
    expect(segs.some((s) => s.audio.status === "done")).toBe(true);
    expect(endpointsStore.endpoints.some((e) => e.backoffUntil > Date.now())).toBe(true);
    expect(endpointsStore.endpoints.some((e) => e.lastError?.code === 429)).toBe(true);

    const row = jobsStore.jobs.find(
      (j) => j.kind === "narration" && j.chapterId === partial.id && j.status === "failed",
    )!;
    expect(row.activity!.some((e) => e.level === "error")).toBe(true);
    expect(row.activity!.at(-1)!.at).toBeLessThanOrEqual(row.finishedAt!);
  });

  test("missing voices leave lines that cannot be routed, and issues to fix", () => {
    demoStore.applyScenario("no-voices");
    const narrator = castStore.charactersOf("cliche").find((c) => c.name === "Narrator")!;
    expect(narrator.voice).toBeNull();
    const issues = castStore.routingIssues("cliche");
    expect(issues.some((i) => i.kind === "missing")).toBe(true);
    expect(issues.some((i) => i.kind === "paused")).toBe(true);
    const ids = libraryStore
      .chaptersOf("cliche")
      .filter(isScripted)
      .map((c) => c.id);
    expect(narrationStore.estimate("cliche", ids).unrouted).toBeGreaterThan(0);
  });

  test("a spent budget blocks a run instead of starting one", () => {
    demoStore.applyScenario("budget-spent");
    const book = libraryStore.bookById("cliche")!;
    expect(book.budget?.cap).toBeGreaterThan(0);
    expect(jobsStore.spent("cliche")).toBeGreaterThanOrEqual(book.budget!.cap!);
    const estimate = scriptingStore.scriptEstimate("cliche", [13]);
    expect(estimate.blockers.length).toBeGreaterThan(0);
    const before = jobsStore.jobs.length;
    scriptingStore.runScripting("cliche", [13]);
    expect(jobsStore.jobs).toHaveLength(before);
  });

  test("stale audio and retakes leave something to compare and something to re-narrate", () => {
    demoStore.applyScenario("stale-audio");
    const chapters = libraryStore.chaptersOf("starforge");
    expect(chapters.filter((c) => c.narration === "stale").length).toBeGreaterThan(1);
    const all = chapters.flatMap((c) => scriptsStore.segmentsOf("starforge", c.id));
    expect(all.filter((s) => s.edited && s.audio.status === "stale").length).toBeGreaterThan(1);
    expect(all.some((s) => s.candidate)).toBe(true);
    expect(all.some((s) => s.audio.takes?.some((t) => t.rejected))).toBe(true);
    expect(all.filter((s) => s.flag).length).toBeGreaterThan(1);
    // the drift the ledger explains is real drift, not a status set by hand
    const edited = all.find((s) => s.edited && s.audio.status === "stale")!;
    expect(narrationStore.clipDrift("starforge", edited).length).toBeGreaterThan(0);
  });

  test("a mis-attributed speaker opens Search on the matches it scattered", () => {
    const to = demoStore.applyScenario("mis-attributed")!;
    const alias = demoStore.searchDemo("cliche")!.alias;
    expect(to).toBe(
      `/book/cliche/search?q=${encodeURIComponent(alias)}&speaker=${encodeURIComponent(alias)}`,
    );
    const speakers = new Set(
      libraryStore
        .chaptersOf("cliche")
        .flatMap((c) => scriptsStore.segmentsOf("cliche", c.id).map((s) => s.speaker)),
    );
    expect(speakers.has(alias)).toBe(true);
    expect(castStore.charactersOf("cliche").some((c) => c.name === alias)).toBe(true);
  });

  test("the export rows leave builds to run, to retry and to update", () => {
    demoStore.applyScenario("ready");
    expect(libraryStore.chaptersOf("starforge").every((c) => c.narration === "done")).toBe(true);
    expect(exportsStore.exportsOf("starforge")).toHaveLength(0);

    demoStore.applyScenario("builds");
    expect(
      exportsStore.exports.some((e) => e.bookId === "starforge" && e.status === "failed"),
    ).toBe(true);
    expect(
      exportsStore.exports.some((e) => e.bookId === "starforge" && e.status === "building"),
    ).toBe(true);

    demoStore.applyScenario("update");
    const behind = exportsStore
      .exportsOf("gates")
      .filter((e) => e.status === "done" && exportsStore.exportUpdateFor(e).needed);
    expect(behind.length).toBeGreaterThan(0);
  });
});
