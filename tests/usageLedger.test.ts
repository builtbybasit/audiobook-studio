// What a book has spent, and what its endpoints have been asked to do.
//
// Both used to be read off whatever the app happened to be holding at the time — the clip currently
// on each line, the jobs currently unfinished — and both lost requests that had really been made.
// The properties tested here are what replaced that:
//
// **Spending only ever goes up.** A request that settled was paid for. Accepting a retake, failing,
// being superseded by a later run: none of them can take money back off the total.
//
// **A settled request keeps its receipt and its place.** It does not disappear from the endpoint's
// activity at the moment it finishes, which is the one moment its receipt is worth opening.
//
// **The cap is the store's job, not a panel's.** Every way of starting narration checks it and
// reserves against it, so two runs that each fit cannot both start and overshoot together.
import { test, expect, beforeEach, afterEach, spyOn, describe } from "bun:test";
import { createPinia, setActivePinia } from "pinia";

import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";
import { keyring } from "@/lib/keyring";
import { newProfile } from "@/lib/scripting";
import { SEEDED_KEYS } from "@/mock";
import { DEFAULT_PACING, silenceOf } from "@/lib/speech";
import { billingOf } from "@/lib/endpoints";
import { useDemoStore } from "@/stores/demo";
import { BILLING_CHAPTER } from "@/mock/scenarios/situations";
import type { TtsBilling } from "@/types";

let timers = new Map<number, { fn: () => void; repeat: boolean }>();
let clock = 1_000_000;
let restore: (() => void)[] = [];
let castStore: ReturnType<typeof useCastStore>;
let endpointsStore: ReturnType<typeof useEndpointsStore>;
let jobsStore: ReturnType<typeof useJobsStore>;
let libraryStore: ReturnType<typeof useLibraryStore>;
let narrationStore: ReturnType<typeof useNarrationStore>;
let scriptingStore: ReturnType<typeof useScriptingStore>;
let scriptsStore: ReturnType<typeof useScriptsStore>;
let uiStore: ReturnType<typeof useUiStore>;
let usageStore: ReturnType<typeof useUsageStore>;

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
  endpointsStore = useEndpointsStore();
  jobsStore = useJobsStore();
  libraryStore = useLibraryStore();
  narrationStore = useNarrationStore();
  scriptingStore = useScriptingStore();
  scriptsStore = useScriptsStore();
  uiStore = useUiStore();
  usageStore = useUsageStore();
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
    // the middle of every simulated coin toss: no rate limits, no failures
    spyOn(Math, "random").mockReturnValue(0.5),
  ].map((s) => () => s.mockRestore());
});
afterEach(() => restore.forEach((f) => f()));

const BOOK = "cliche";
const segments = (id: number) => scriptsStore.segmentsOf(BOOK, id);

/** Route every speaker at one endpoint with a rate card we control. */
function route(rate: number | null = 12, id = "local") {
  const ep = endpointsStore.endpoints.find((e) => e.id === id)!;
  ep.enabled = true;
  ep.backoffUntil = 0;
  ep.failRate = 0;
  ep.billing = { unit: "chars", rate };
  ep.price = rate ?? 0;
  ep.pricing = {
    cachedInput: null,
    cacheWrite: null,
    timezone: "UTC",
    windows: [],
    promotions: [],
  };
  for (const c of castStore.characters[BOOK]) c.voice = `${ep.id}/${ep.voices[0].id}`;
  return ep;
}

/** Route scripting at one profile with a rate card we control. */
function routeScripting() {
  const p = newProfile({
    id: "test",
    name: "Test endpoint",
    model: "test-model",
    needsKey: false,
    concurrency: 2,
    maxChars: 4000,
    inPrice: 1,
    outPrice: 2,
    maxOutputTokens: 4000,
  });
  endpointsStore.profiles = [p];
  scriptingStore.scriptSettings.profile = p.id;
  return p;
}

describe("spending is append-only", () => {
  test("accepting a retake does not take back what the clip it displaced cost", () => {
    route();
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const afterRun = jobsStore.spent(BOOK);
    expect(afterRun).toBeGreaterThan(0);
    const rendered = usageStore.requests.filter((r) => r.kind === "tts");
    expect(rendered.length).toBeGreaterThan(0);

    const line = segments(1).find((s) => s.audio.status === "done" && s.audio.duration > 0)!;
    const firstCost = line.audio.cost!;
    expect(firstCost).toBeGreaterThan(0);

    narrationStore.retakeSegment(BOOK, 1, line.id);
    drain();
    expect(line.candidate?.status).toBe("done");
    const withRetake = jobsStore.spent(BOOK);
    // the retake was a second request, so it cost a second time
    expect(withRetake).toBeGreaterThan(afterRun);

    narrationStore.acceptTake(BOOK, 1, line.id);
    // the clip in the book changed; nothing about what has been spent did
    expect(jobsStore.spent(BOOK)).toBeCloseTo(withRetake, 12);
    // and the take it displaced kept its receipt rather than being left with a bare number
    const displaced = line.audio.takes!.at(-1)!;
    expect(displaced.cost).toBeCloseTo(firstCost, 12);
    expect(displaced.charge?.lines[0].rate).toBe(12);
    expect(displaced.charge?.at).toBeGreaterThan(0);
  });

  test("a rejected retake was still paid for", () => {
    route();
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const line = segments(1).find((s) => s.audio.duration > 0)!;
    narrationStore.retakeSegment(BOOK, 1, line.id);
    drain();
    const withRetake = jobsStore.spent(BOOK);

    narrationStore.rejectTake(BOOK, 1, line.id);
    expect(jobsStore.spent(BOOK)).toBeCloseTo(withRetake, 12);
    expect(line.audio.takes!.some((t) => t.rejected)).toBe(true);
  });

  test("a later run over the same chapter adds to the bill rather than replacing it", () => {
    route();
    const opening = jobsStore.spent(BOOK);
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const once = jobsStore.spent(BOOK);
    const firstRun = once - opening;
    expect(firstRun).toBeGreaterThan(0);
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    // the same lines at the same rate cost the same again, on top of the first run
    expect(jobsStore.spent(BOOK) - once).toBeCloseTo(firstRun, 12);
  });

  test("retrying a clip the seeded world arrived with does not refund it", () => {
    route();
    // chapters 1–3 of this book are narrated in the seeded world; that spending is an opening
    // balance with no receipt behind it, and putting one of its clips back in the queue is not a
    // refund of what it cost
    const before = jobsStore.spent(BOOK);
    expect(before).toBeGreaterThan(0);
    const line = segments(1).find((s) => s.audio.status === "done" && s.audio.duration > 0)!;
    // the clip carries the receipt it was priced from, and that receipt is not a credit note
    expect(line.audio.charge!.amount).toBeCloseTo(line.audio.cost!, 12);

    narrationStore.retrySegment(BOOK, 1, line.id);
    expect(jobsStore.spent(BOOK)).toBeGreaterThanOrEqual(before);
    drain();
    // and the re-render is a request of its own, on top
    expect(jobsStore.spent(BOOK)).toBeGreaterThan(before);
  });
});

describe("a settled request keeps its place in the endpoint's activity", () => {
  test("it is still there after the run has finished", () => {
    const ep = route();
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    expect(jobsStore.jobs.every((j) => !!j.finishedAt)).toBe(true);

    const rows = usageStore.ofEndpoint(ep.id, "tts");
    expect(rows.length).toBeGreaterThan(0);
    // this session's own work, not backstory, and each one carries the receipt it was charged at
    expect(rows.every((r) => !r.simulated)).toBe(true);
    expect(rows.every((r) => !!r.speech)).toBe(true);
    expect(rows.every((r) => r.bookId === BOOK && r.chapterId === 1)).toBe(true);
    // newest first, the order the list reads in
    expect(rows[0].finishedAt).toBeGreaterThanOrEqual(rows.at(-1)!.finishedAt!);
  });

  test("a speech endpoint and a scripting profile sharing an id keep their own rows", () => {
    // the seeded world has an `openai` of each kind, and the page keys them `tts:` / `scripting:`
    expect(endpointsStore.profiles.some((p) => p.id === "openai")).toBe(true);
    route(12, "openai");
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    expect(usageStore.ofEndpoint("openai", "tts").length).toBeGreaterThan(0);
    // the speech work did not land in the scripting profile that happens to share its id
    expect(usageStore.ofEndpoint("openai", "scripting")).toEqual([]);
  });

  test("a scripting request lands in the same list, with its token receipt", () => {
    routeScripting();
    scriptingStore.runScripting(BOOK, [13]);
    drain();

    const rows = usageStore.ofEndpoint("test", "scripting");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === "scripting" && !!r.priced)).toBe(true);
    // and the two ways of reading the ledger agree
    expect(jobsStore.scriptUsage.length).toBe(rows.length);
    expect(jobsStore.scriptSpent(BOOK)).toBeCloseTo(
      rows.reduce((n, r) => n + (r.cost ?? 0), 0),
      12,
    );
  });
});

describe("the book's cap holds whichever way narration is started", () => {
  /** Spend most of the cap, then leave `headroom` dollars of it. */
  function capAfterFirstRun(headroom: number) {
    route();
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const book = libraryStore.bookById(BOOK)!;
    book.budget = { cap: jobsStore.spent(BOOK) + headroom, paused: false };
    return book;
  }

  test("a retake that does not fit is refused rather than queued", () => {
    capAfterFirstRun(0);
    const line = segments(1).find((s) => s.audio.duration > 0)!;
    narrationStore.retakeSegment(BOOK, 1, line.id);
    expect(line.candidate).toBeUndefined();
    expect(jobsStore.jobs.some((j) => !j.finishedAt)).toBe(false);
  });

  test("a retry of one line is refused too — the check is not only on the run panel", () => {
    capAfterFirstRun(0);
    const line = segments(1).find((s) => s.audio.duration > 0)!;
    const before = line.audio.status;
    narrationStore.retrySegment(BOOK, 1, line.id);
    expect(line.audio.status).toBe(before);
  });

  test("retaking everything flagged is refused as one decision, not line by line", () => {
    capAfterFirstRun(0);
    for (const s of segments(1).slice(0, 3))
      narrationStore.flagSegment(BOOK, 1, s.id, "delivery", "");
    expect(narrationStore.retakeFlagged(BOOK, 1)).toBe(0);
    expect(segments(1).every((s) => !s.candidate)).toBe(true);
  });

  test("two runs that each fit cannot both start and land past the cap together", () => {
    route();
    const book = libraryStore.bookById(BOOK)!;
    const one = narrationStore.estimate(BOOK, [1], "all");
    const two = narrationStore.estimate(BOOK, [2], "all");
    const each = Math.max(one.cost, one.withoutPromotions);
    const other = Math.max(two.cost, two.withoutPromotions);
    expect(each).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(0);
    // The seeded world already narrated this book once, and that spending is real. On top of it, a
    // cap either run fits on its own and the two of them together do not.
    const already = jobsStore.spent(BOOK);
    book.budget = { cap: already + each + other / 2, paused: false };

    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    expect(jobsStore.jobs.filter((j) => j.kind === "narration").length).toBe(1);
    // the first run has not spent anything yet — it is only reserved — and that is what stops this
    expect(jobsStore.reserved(BOOK)).toBeGreaterThan(0);
    narrationStore.runNarration(BOOK, [2], { scope: "all" });
    expect(jobsStore.jobs.filter((j) => j.kind === "narration").length).toBe(1);

    drain();
    expect(jobsStore.spent(BOOK)).toBeLessThanOrEqual(book.budget.cap!);
    // and with the first run landed and its reservation released, the second one fits again
    expect(jobsStore.reserved(BOOK)).toBe(0);
  });

  test("a multi-chapter run reserves for all of it, not only for the chapter in flight", () => {
    route();
    const book = libraryStore.bookById(BOOK)!;
    const whole = narrationStore.estimate(BOOK, [1, 2, 3], "all");
    book.budget = { cap: jobsStore.spent(BOOK) + whole.withoutPromotions * 2, paused: false };
    narrationStore.runNarration(BOOK, [1, 2, 3], { scope: "all" });
    const queued = jobsStore.jobs.filter((j) => j.kind === "narration");
    expect(queued.length).toBe(3);
    // every chapter of the run is holding its own share before any of them has been dispatched
    expect(queued.every((j) => (j.narrationRun?.reserved ?? 0) > 0)).toBe(true);
    expect(jobsStore.reserved(BOOK)).toBeCloseTo(whole.withoutPromotions, 6);
    drain();
    expect(jobsStore.reserved(BOOK)).toBe(0);
  });

  test("spending survives clearing the jobs that produced it", () => {
    route();
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const spent = jobsStore.spent(BOOK);
    jobsStore.clearFinished();
    expect(jobsStore.jobs).toEqual([]);
    expect(jobsStore.spent(BOOK)).toBeCloseTo(spent, 12);
  });

  test("a run that fits is not blocked by its own reservation", () => {
    route();
    const book = libraryStore.bookById(BOOK)!;
    const est = narrationStore.estimate(BOOK, [1], "all");
    book.budget = { cap: Math.max(est.cost, est.withoutPromotions) * 4, paused: false };
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    expect(segments(1).some((s) => s.audio.status === "done")).toBe(true);
  });
});

describe("a run's per-chapter reconciliation", () => {
  test("each chapter is estimated from its own chunks, not from the batch average", () => {
    routeScripting();

    const ids = [13, 14, 15];
    const lengths = ids.map((id) => scriptsStore.rawText(BOOK, id).length);
    // the chapters have to differ in size for this to be able to say anything
    expect(new Set(lengths).size).toBeGreaterThan(1);
    // taken before the run: once the chapters are queued they are no longer "what a run would cost"
    const whole = scriptingStore.scriptEstimate(BOOK, ids);

    scriptingStore.runScripting(BOOK, ids);
    const runs = jobsStore.jobs
      .filter((j) => j.kind === "scripting" && j.scriptRun)
      .map((j) => ({ chapterId: j.chapterId!, estimated: j.scriptRun!.estimated! }));
    expect(runs.length).toBe(ids.length);
    // the longer chapter carries the bigger estimate
    const byLength = [...runs].sort(
      (a, b) =>
        scriptsStore.rawText(BOOK, a.chapterId).length -
        scriptsStore.rawText(BOOK, b.chapterId).length,
    );
    for (let i = 1; i < byLength.length; i++)
      expect(byLength[i].estimated).toBeGreaterThanOrEqual(byLength[i - 1].estimated);
    expect(new Set(runs.map((r) => r.estimated)).size).toBeGreaterThan(1);

    // and they still add up to what the run as a whole was estimated at
    expect(runs.reduce((n, r) => n + r.estimated, 0)).toBeCloseTo(whole.cost, 8);
  });
});

// ---------- billing models, end to end ----------

/** Route every speaker at one endpoint under a billing model we control. */
function routeBilling(billing: TtsBilling) {
  const ep = endpointsStore.endpoints.find((e) => e.id === "local")!;
  ep.enabled = true;
  ep.backoffUntil = 0;
  ep.failRate = 0;
  ep.maxChars = 0;
  ep.billing = billing;
  ep.pricing = {
    cachedInput: null,
    cacheWrite: null,
    timezone: "UTC",
    windows: [],
    promotions: [],
  };
  for (const c of castStore.characters[BOOK]) c.voice = `local/${ep.voices[0].id}`;
  return ep;
}

const ttsRows = () => usageStore.requests.filter((r) => r.kind === "tts" && !r.simulated);

describe("a run is charged in its endpoint's billing model", () => {
  test("every settled request records all four counts, not only the one it was billed on", () => {
    routeBilling({ unit: "bytes", rate: 15 });
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const rows = ttsRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.usage.chars).toBeGreaterThan(0);
      expect(r.usage.bytes).toBeGreaterThanOrEqual(r.usage.chars!);
      expect(r.usage.textTokens).toBeGreaterThan(0);
      // charged on the bytes, and the receipt says so
      expect(r.speech!.unit).toBe("bytes");
      expect(r.speech!.lines).toHaveLength(1);
      expect(r.speech!.lines[0].quantity).toBe(r.usage.bytes!);
    }
  });

  test("the pronunciation dictionary is inside the billable count, and the book is not", () => {
    // this book's dictionary rewrites "outer sect" into Hanzi, which is more bytes than the
    // English it replaces — so what is billed follows the request, not the prose
    routeBilling({ unit: "bytes", rate: 15 });
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const rewritten = ttsRows().filter((r) => r.speech!.units.bytes > r.speech!.units.chars);
    expect(rewritten.length).toBeGreaterThan(0);
    for (const r of rewritten) {
      // the row's label leads with the line it rendered: "Line 22 · Narrator"
      const id = Number(/^\D+(\d+) ·/.exec(r.label)![1]);
      const line = segments(1).find((s) => s.id === id);
      expect(line).toBeDefined();
      // the book keeps the English; only the request carries the Hanzi the dictionary swaps in
      expect(line!.text).toContain("outer sect");
      expect(line!.text).not.toMatch(/\p{Script=Han}/u);
    }
  });

  test("a token-billed endpoint charges two lines and the ledger keeps both", () => {
    routeBilling({ unit: "audio-tokens", rate: 1, audioRate: 20, audioTokensPerSecond: 25 });
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const rows = ttsRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const lines = r.speech!.lines;
      expect(lines.map((l) => l.component)).toEqual(["textTokens", "audioTokens"]);
      expect(r.cost!).toBeCloseTo(lines[0].amount! + lines[1].amount!, 12);
      // the audio side follows the clip's duration, not its text
      expect(r.usage.audioTokens).toBe(Math.round(r.usage.audioSeconds! * 25));
    }
    // and spending is the sum of both halves of every request
    expect(jobsStore.spent(BOOK)).toBeGreaterThan(usageStore.openingNarrationSpend(BOOK));
  });

  test("a free endpoint spends nothing and an unconfigured one spends unknown", () => {
    routeBilling({ unit: "chars", rate: 0 });
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    expect(ttsRows().every((r) => r.cost === 0 && r.costBasis !== "unknown")).toBe(true);

    routeBilling({ unit: "audio-tokens", rate: 1, audioRate: null });
    narrationStore.runNarration(BOOK, [2], { scope: "all" });
    drain();
    const second = ttsRows().filter((r) => r.chapterId === 2);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((r) => r.cost === null && r.costBasis === "unknown")).toBe(true);
  });
});

describe("estimates reconcile against what was actually charged", () => {
  test("a chapter's estimate is recorded and the run reports the difference", () => {
    routeBilling({ unit: "audio-tokens", rate: 1, audioRate: 20, audioTokensPerSecond: 25 });
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const job = jobsStore.jobs.find((j) => j.kind === "narration" && j.chapterId === 1)!;
    expect(job.narrationRun!.estimated).toBeGreaterThan(0);
    // the two halves were estimated separately, because they are wrong for different reasons
    expect(job.narrationRun!.estimatedInput).toBeGreaterThan(0);
    expect(job.narrationRun!.estimatedAudio).toBeGreaterThan(0);

    const line = job.activity!.find((e) => e.message.startsWith("Estimate reconciled"))!;
    expect(line).toBeTruthy();
    const detail = line.detail as Record<string, unknown>;
    expect(detail.estimatedUSD).toBeCloseTo(job.narrationRun!.estimated!, 12);
    // what was charged is what the ledger holds for this chapter, to the cent
    const charged = ttsRows()
      .filter((r) => r.chapterId === 1)
      .reduce((n, r) => n + (r.cost ?? 0), 0);
    expect(detail.chargedUSD as number).toBeCloseTo(charged, 12);
    expect(detail.billableAttempts).toBe(ttsRows().filter((r) => r.chapterId === 1).length);
  });

  test("a request that failed is charged for what it sent, and the reconciliation counts it", () => {
    const ep = routeBilling({ unit: "chars", rate: 12 });
    ep.failRate = 1; // every request fails, and every one is still charged for what it sent
    const before = jobsStore.spent(BOOK);
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const rows = ttsRows().filter((r) => r.chapterId === 1);
    expect(rows.length).toBeGreaterThan(0);
    // every attempt failed, so this run produced no new audio at all — and still cost money:
    // per-character billing charges what went out even when nothing came back
    expect(rows.every((r) => r.status === "failed" && (r.cost ?? 0) > 0)).toBe(true);
    expect(jobsStore.spent(BOOK)).toBeGreaterThan(before);

    // the reconciliation counts billable attempts, not the clips that survived
    const job = jobsStore.jobs.find((j) => j.kind === "narration" && j.chapterId === 1)!;
    const detail = job.activity!.find((e) => e.message.startsWith("Estimate reconciled"))!
      .detail as Record<string, unknown>;
    expect(String(detail.failedButCharged)).toContain("still charged");
    expect(detail.chargedUSD as number).toBeGreaterThan(0);
    expect(detail.billableAttempts).toBe(rows.length);
  });

  test("silence stitched between clips is never counted as generated audio", () => {
    routeBilling({ unit: "minute", rate: 6 });
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const rows = ttsRows().filter((r) => r.chapterId === 1);
    const billed = rows.reduce((n, r) => n + (r.speech!.units.audioSeconds ?? 0), 0);
    const clips = segments(1).reduce((n, s) => n + s.audio.duration, 0);
    // the chapter's rendered length includes the pauses; the billed audio does not
    expect(billed).toBeCloseTo(clips, 6);
    const withSilence = silenceOf(segments(1), DEFAULT_PACING) + clips;
    expect(withSilence).toBeGreaterThan(billed);
  });
});

describe("a change of billing model cannot rewrite history", () => {
  test("receipts keep the model and the rates they were charged under", () => {
    const ep = routeBilling({ unit: "chars", rate: 12 });
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const before = jobsStore.spent(BOOK);
    const rows = ttsRows().map((r) => ({ id: r.id, unit: r.speech!.unit, cost: r.cost }));
    expect(rows.length).toBeGreaterThan(0);

    // the endpoint moves to a completely different billing model at a much higher rate
    ep.billing = { unit: "audio-tokens", rate: 50, audioRate: 500, audioTokensPerSecond: 25 };
    for (const r of rows) {
      const now = usageStore.requests.find((x) => x.id === r.id)!;
      expect(now.speech!.unit).toBe("chars");
      expect(now.cost).toBe(r.cost);
    }
    expect(jobsStore.spent(BOOK)).toBeCloseTo(before, 12);
  });

  test("a later run under the new model is charged under it, and adds to the same total", () => {
    const ep = routeBilling({ unit: "chars", rate: 12 });
    narrationStore.runNarration(BOOK, [1], { scope: "all" });
    drain();
    const afterFirst = jobsStore.spent(BOOK);

    ep.billing = { unit: "bytes", rate: 15 };
    narrationStore.runNarration(BOOK, [2], { scope: "all" });
    drain();
    const units = new Set(ttsRows().map((r) => r.speech!.unit));
    expect(units).toEqual(new Set(["chars", "bytes"]));
    expect(jobsStore.spent(BOOK)).toBeGreaterThan(afterFirst);
  });

  test("a bulk run over several chapters charges every one of them and nothing else", () => {
    routeBilling({ unit: "bytes", rate: 15 });
    const ids = [1, 2, 3];
    narrationStore.runNarration(BOOK, ids, { scope: "all" });
    drain();
    const touched = new Set(ttsRows().map((r) => r.chapterId));
    expect(touched).toEqual(new Set(ids));
    // each chapter's own estimate, against its own clips
    for (const id of ids) {
      const job = jobsStore.jobs.find((j) => j.kind === "narration" && j.chapterId === id)!;
      expect(job.narrationRun!.estimated).toBeGreaterThan(0);
    }
    const jobs = ids.map((id) =>
      jobsStore.jobs.find((j) => j.kind === "narration" && j.chapterId === id)!,
    );
    expect(new Set(jobs.map((j) => j.bulk!.id)).size).toBe(1);
  });
});

test("the billing-models scenario puts every model into one chapter's estimate", () => {
  const demoStore = useDemoStore();
  demoStore.applyScenario("billing-models");
  const est = narrationStore.estimate(BOOK, [BILLING_CHAPTER], "all");
  const models = new Set(est.per.map((e) => billingOf(e.endpoint).unit));
  expect(models.has("chars")).toBe(true);
  expect(models.has("bytes")).toBe(true);
  expect(models.has("audio-tokens")).toBe(true);
  // the dictionary's Hanzi make the byte-billed share cost more than its character count suggests
  const fish = est.per.find((e) => e.endpoint.id === "fish")!;
  expect(fish.units.bytes).toBeGreaterThan(fish.units.chars);
  // the audio half exists because something in this run bills on the audio, and the halves add up
  expect(est.audioCost).not.toBeNull();
  expect(est.inputCost + est.audioCost!).toBeCloseTo(est.cost, 12);
  // the free model contributes nothing, and the unpriced one is counted rather than invented as $0
  expect(est.per.find((e) => e.endpoint.id === "local")!.cost).toBe(0);
  expect(est.per.find((e) => e.endpoint.id === "proxy")!.cost).toBeNull();
  expect(est.unpriced).toBeGreaterThan(0);
});
