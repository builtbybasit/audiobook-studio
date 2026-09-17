import { beforeEach, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import {
  activeWindow,
  baseRates,
  calendarDay,
  effectiveRates,
  endOfDay,
  endOfDayAfter,
  ensurePricing,
  estimateRates,
  estimateSpeech,
  localClock,
  localTimezone,
  newPricing,
  nextChange,
  normalizeUsage,
  observedCacheRate,
  priceRequest,
  priceSpeechRequest,
  pricingProblems,
  pricingWarnings,
  promotionExpired,
  promotionRunning,
  speechChargeLines,
  speechRates,
  startOfDay,
  tokenChargeLines,
  uncachedInput,
  usageTrustworthy,
  windowCovers,
  noUnits,
  speechWhy,
  measureSpeech,
  utf8Bytes,
  billableChars,
  normalizeSpeechUsage,
  speechComponents,
  billingProblems,
  switchBillingUnit,
} from "@/lib/pricing";
import { newProfile, tokenEstimate } from "@/lib/scripting";
import { TTS_PRESETS, billingOf, endpointErrors, unifyEndpoint } from "@/lib/endpoints";
import { makeEndpoints } from "@/mock/fixtures/endpoints";
import { cacheShapeFor, simulateUsage, usageFormatFor } from "@/mock/simulators/usage";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useScriptingStore } from "@/stores/scripting";
import { useLibraryStore } from "@/stores/library";
import type {
  BillableUnits,
  Endpoint,
  PricingConfig,
  Promotion,
  RateSet,
  RateWindow,
  TtsBilling,
} from "@/types";

/** A speech endpoint that is valid apart from whatever a test puts on its rate card. */
const ttsEndpointForPricing = (): Endpoint => ({
  id: "t1",
  name: "Test TTS",
  baseUrl: "https://example.test/v1",
  model: "tts-1",
  concurrency: 2,
  enabled: true,
  latency: 1000,
  failRate: 0,
  price: 10,
  needsKey: false,
  maxChars: 500,
  splitAt: "sentence",
  voices: [{ id: "alloy", gender: "n", label: "alloy" }],
  history: [],
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
  billing: { unit: "chars", rate: 10 },
  pricing: newPricing({ timezone: "UTC" }),
});

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
});

const card = (over: Partial<RateSet> = {}): RateSet => ({
  input: 1,
  output: 4,
  cachedInput: null,
  cacheWrite: null,
  speech: null,
  ...over,
});

const config = (over: Partial<PricingConfig> = {}): PricingConfig =>
  newPricing({ timezone: "UTC", ...over });

/** Measured units for a speech request, with everything nobody set left at zero. */
const u = (over: Partial<BillableUnits> = {}): BillableUnits => ({
  ...noUnits(),
  requests: 1,
  ...over,
});

/** An instant with a known UTC wall clock, so window tests read as wall-clock tests. */
const utc = (day: string, time: string): number => Date.parse(`${day}T${time}:00.000Z`);
// 2026-09-17 is a Thursday
const THU = "2026-09-17";
const FRI = "2026-09-18";
const SAT = "2026-09-19";

// ---------- token accounting ----------

test("cached input is a slice of the total input, never an addition to it", () => {
  // the example from the brief: 10,000 input of which 8,000 cached
  const usage = normalizeUsage(
    {
      prompt_tokens: 10_000,
      completion_tokens: 2_000,
      prompt_tokens_details: { cached_tokens: 8_000 },
    },
    "openai",
  );
  expect(usage.inputTokens).toBe(10_000);
  expect(usage.cachedInput).toBe(8_000);
  expect(uncachedInput(usage)).toBe(2_000);

  const priced = priceRequest(card({ cachedInput: 0.25 }), config(), usage, {
    at: utc(THU, "12:00"),
  });
  const line = (c: string) => priced.lines.find((l) => l.component === c)!;
  expect(line("input").tokens).toBe(2_000);
  expect(line("cachedInput").tokens).toBe(8_000);
  expect(line("output").tokens).toBe(2_000);
  // 2,000 @ $1 + 8,000 @ $0.25 + 2,000 @ $4, all per 1M
  expect(priced.total).toBeCloseTo((2000 * 1 + 8000 * 0.25 + 2000 * 4) / 1e6, 12);
  // and the tokens on the lines add back up to exactly what came back — nothing counted twice
  expect(line("input").tokens + line("cachedInput").tokens).toBe(usage.inputTokens);
  expect(priced.basis).toBe("calculated");
});

test("the two provider shapes disagree about the input total, and normalizing settles it", () => {
  // OpenAI: prompt_tokens INCLUDES the cached tokens
  const openai = normalizeUsage(
    {
      prompt_tokens: 10_000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 8_000 },
    },
    "openai",
  );
  // Anthropic: input_tokens EXCLUDES cache reads and cache creation
  const anthropic = normalizeUsage(
    {
      input_tokens: 2_000,
      output_tokens: 100,
      cache_read_input_tokens: 8_000,
      cache_creation_input_tokens: 0,
    },
    "anthropic",
  );
  expect(openai.inputTokens).toBe(anthropic.inputTokens);
  expect(openai.cachedInput).toBe(anthropic.cachedInput);
  expect(uncachedInput(openai)).toBe(uncachedInput(anthropic));
  // the same rate card therefore charges the same request the same way whichever shape it arrived in
  const at = utc(THU, "12:00");
  const a = priceRequest(card({ cachedInput: 0.25 }), config(), openai, { at });
  const b = priceRequest(card({ cachedInput: 0.25 }), config(), anthropic, { at });
  expect(a.total).toBeCloseTo(b.total!, 12);
});

test("anthropic cache-creation tokens are part of the input total and charged on their own line", () => {
  const usage = normalizeUsage(
    {
      input_tokens: 1_000,
      output_tokens: 50,
      cache_read_input_tokens: 4_000,
      cache_creation_input_tokens: 5_000,
    },
    "anthropic",
  );
  expect(usage.inputTokens).toBe(10_000);
  expect(uncachedInput(usage)).toBe(1_000);
  const priced = priceRequest(card({ cachedInput: 0.1, cacheWrite: 1.25 }), config(), usage, {
    at: utc(THU, "12:00"),
  });
  const line = (c: string) => priced.lines.find((l) => l.component === c)!;
  expect(line("input").tokens).toBe(1_000);
  expect(line("cachedInput").tokens).toBe(4_000);
  expect(line("cacheWrite").tokens).toBe(5_000);
  expect(line("input").tokens + line("cachedInput").tokens + line("cacheWrite").tokens).toBe(
    10_000,
  );
});

test("zero cached tokens and no cache report are different facts", () => {
  const reportedZero = normalizeUsage(
    { prompt_tokens: 1_000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } },
    "openai",
  );
  const notReported = normalizeUsage({ prompt_tokens: 1_000, completion_tokens: 10 }, "plain");
  expect(reportedZero.cachedInput).toBe(0);
  expect(notReported.cachedInput).toBeNull();
  expect(reportedZero.problems.map((p) => p.code)).not.toContain("cache-not-reported");
  expect(notReported.problems.map((p) => p.code)).toContain("cache-not-reported");

  const at = utc(THU, "12:00");
  const a = priceRequest(card({ cachedInput: 0.25 }), config(), reportedZero, { at });
  const b = priceRequest(card({ cachedInput: 0.25 }), config(), notReported, { at });
  // the same money, but only one of them is a fact
  expect(a.total).toBeCloseTo(b.total!, 12);
  expect(a.basis).toBe("calculated");
  expect(b.basis).toBe("estimated");
  expect(b.unknowns.join(" ")).toContain("not reported");
  expect(a.unknowns).toEqual([]);
});

test("a cached rate that is not configured charges cached tokens as ordinary input, and says so", () => {
  const usage = normalizeUsage(
    { prompt_tokens: 1_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 600 } },
    "openai",
  );
  const priced = priceRequest(card(), config(), usage, { at: utc(THU, "12:00") });
  const cached = priced.lines.find((l) => l.component === "cachedInput")!;
  expect(cached.rate).toBe(1);
  expect(cached.note).toContain("no separate cached rate");
  expect(priced.total).toBeCloseTo(1000 / 1e6, 12);
});

// ---------- invalid or contradictory usage ----------

test("counts that contradict each other are repaired, flagged, and never charged twice", () => {
  const usage = normalizeUsage(
    {
      prompt_tokens: 1_000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 4_000 },
    },
    "openai",
  );
  expect(usage.problems.map((p) => p.code)).toContain("cache-exceeds-input");
  expect(usageTrustworthy(usage)).toBe(false);
  expect(uncachedInput(usage)).toBe(0);
  const priced = priceRequest(card({ cachedInput: 0.25 }), config(), usage, {
    at: utc(THU, "12:00"),
  });
  expect(priced.lines.every((l) => l.tokens >= 0)).toBe(true);
  expect(priced.basis).toBe("estimated");
  expect(priced.unknowns.join(" ")).toContain("unreliable");
});

test("negative and missing counts are read as zero, not as money", () => {
  const negative = normalizeUsage(
    { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: -40 } },
    "openai",
  );
  expect(negative.cachedInput).toBe(0);
  expect(negative.problems.map((p) => p.code)).toContain("negative");

  const missing = normalizeUsage({ completion_tokens: 10 }, "plain");
  expect(missing.inputTokens).toBe(0);
  expect(missing.problems.map((p) => p.code)).toContain("input-missing");
  const priced = priceRequest(card(), config(), missing, { at: utc(THU, "12:00") });
  expect(priced.total).toBeCloseTo(40 / 1e6, 12);
  expect(priced.basis).toBe("estimated");
});

// ---------- schedule boundaries ----------

test("a window that runs past midnight covers both sides of it", () => {
  const night: RateWindow = {
    id: "n",
    label: "Off-peak",
    days: [],
    from: 22 * 60,
    to: 6 * 60,
    percent: 50,
  };
  const cfg = config({ windows: [night] });
  expect(activeWindow(cfg, utc(THU, "23:30")).window).toBe(night);
  expect(activeWindow(cfg, utc(FRI, "05:59")).window).toBe(night);
  // the edges: inclusive at the start, exclusive at the end
  expect(activeWindow(cfg, utc(THU, "22:00")).window).toBe(night);
  expect(activeWindow(cfg, utc(FRI, "06:00")).window).toBeNull();
  expect(activeWindow(cfg, utc(THU, "21:59")).window).toBeNull();
  expect(activeWindow(cfg, utc(THU, "12:00")).window).toBeNull();
});

test("the day list of a midnight-crossing window names the day it starts on", () => {
  // Friday 22:00 – Saturday 02:00
  const w: RateWindow = { id: "w", label: "Fri night", days: [5], from: 22 * 60, to: 2 * 60 };
  const day = (t: number) => localClock(t, "UTC");
  expect(windowCovers(w, day(utc(FRI, "23:00")).day, day(utc(FRI, "23:00")).minutes)).toBe(true);
  // Saturday 01:00 is the tail of the Friday window
  expect(windowCovers(w, day(utc(SAT, "01:00")).day, day(utc(SAT, "01:00")).minutes)).toBe(true);
  // Saturday 23:00 is not: the window does not start on Saturday
  expect(windowCovers(w, day(utc(SAT, "23:00")).day, day(utc(SAT, "23:00")).minutes)).toBe(false);
  // and Friday 01:00 belongs to Thursday's window, which does not exist
  expect(windowCovers(w, day(utc(FRI, "01:00")).day, day(utc(FRI, "01:00")).minutes)).toBe(false);
});

test("windows do not stack: the first one in the list that covers the moment wins", () => {
  const a: RateWindow = { id: "a", label: "A", days: [], from: 0, to: 1439, percent: 20 };
  const b: RateWindow = { id: "b", label: "B", days: [], from: 0, to: 1439, percent: 90 };
  const at = utc(THU, "12:00");
  expect(effectiveRates(card(), config({ windows: [a, b] }), at).components.input.rate).toBeCloseTo(
    0.8,
    12,
  );
  // reordering is how precedence is changed, and it is the only thing that changes it
  expect(effectiveRates(card(), config({ windows: [b, a] }), at).components.input.rate).toBeCloseTo(
    0.1,
    12,
  );
});

test("a window is read in its own timezone, not the machine's", () => {
  const w: RateWindow = { id: "w", label: "Night", days: [], from: 0, to: 6 * 60, percent: 50 };
  // 2026-09-17 03:00 UTC is 11:00 in Shanghai and 23:00 the previous day in New York
  const at = utc(THU, "03:00");
  expect(activeWindow(config({ windows: [w] }), at).window).toBe(w);
  expect(activeWindow(config({ timezone: "Asia/Shanghai", windows: [w] }), at).window).toBeNull();
  expect(
    activeWindow(config({ timezone: "America/New_York", windows: [w] }), at).window,
  ).toBeNull();
});

test("an unreadable timezone falls back to UTC and says it did rather than pretending", () => {
  const cfg = config({ timezone: "Mars/Olympus" });
  const snapshot = effectiveRates(card(), cfg, utc(THU, "12:00"));
  expect(snapshot.timezoneOk).toBe(false);
  expect(pricingProblems(cfg).join(" ")).toContain("not a timezone");
});

test("the next change is the next boundary that actually moves a rate", () => {
  const cfg = config({
    windows: [{ id: "n", label: "Off-peak", days: [], from: 22 * 60, to: 6 * 60, percent: 50 }],
  });
  const change = nextChange(card(), cfg, utc(THU, "20:00"));
  expect(change?.label).toBe("Off-peak starts");
  expect(change?.at).toBe(utc(THU, "22:00"));

  const inside = nextChange(card(), cfg, utc(THU, "23:00"));
  expect(inside?.label).toBe("Off-peak ends");
  expect(inside?.at).toBe(utc(FRI, "06:00"));

  // a card with nothing scheduled has no next change at all
  expect(nextChange(card(), config(), utc(THU, "20:00"))).toBeNull();
});

// ---------- promotions ----------

const promo = (over: Partial<Promotion> = {}): Promotion => ({
  id: "p",
  label: "P",
  from: null,
  until: null,
  scope: ["model"],
  percent: 50,
  ...over,
});

test("a promotion applies on top of the schedule, not instead of it", () => {
  const cfg = config({
    windows: [{ id: "n", label: "Off-peak", days: [], from: 0, to: 1439, percent: 50 }],
    promotions: [promo({ percent: 50 })],
  });
  const r = effectiveRates(card(), cfg, utc(THU, "12:00")).components.input;
  expect(r.base).toBe(1);
  expect(r.scheduled).toBeCloseTo(0.5, 12);
  // 50% off the scheduled rate, not 100% off the base rate
  expect(r.rate).toBeCloseTo(0.25, 12);
  expect(r.why).toHaveLength(2);
});

test("promotions do not stack: only the cheapest applies to a component", () => {
  const cfg = config({
    promotions: [
      promo({ id: "a", label: "A", percent: 30 }),
      promo({ id: "b", label: "B", percent: 60 }),
    ],
  });
  const snapshot = effectiveRates(card(), cfg, utc(THU, "12:00"));
  expect(snapshot.components.input.rate).toBeCloseTo(0.4, 12);
  expect(snapshot.applied.map((p) => p.id)).toEqual(["b"]);
  // the one that lost is named rather than silently dropped
  expect(snapshot.shadowed.map((p) => p.id)).toEqual(["a"]);
  // and it is never 30% and then 60% of what is left
  expect(snapshot.components.input.rate).not.toBeCloseTo(0.28, 6);
});

test("a tie between two promotions goes to the one ending soonest", () => {
  const now = utc(THU, "12:00");
  const cfg = config({
    promotions: [
      promo({ id: "long", label: "Long", percent: 50, until: now + 30 * 86400e3 }),
      promo({ id: "short", label: "Short", percent: 50, until: now + 2 * 86400e3 }),
    ],
  });
  expect(effectiveRates(card(), cfg, now).applied.map((p) => p.id)).toEqual(["short"]);
});

test("a promotion's scope decides which rates it touches", () => {
  const cfg = config({
    promotions: [promo({ scope: ["output"], percent: 50 })],
  });
  const c = effectiveRates(card({ cachedInput: 0.25 }), cfg, utc(THU, "12:00")).components;
  expect(c.output.rate).toBeCloseTo(2, 12);
  expect(c.input.rate).toBe(1);
  expect(c.cachedInput.rate).toBe(0.25);

  // "model" covers every component the endpoint prices, and only those
  const all = effectiveRates(
    card({ cachedInput: 0.25 }),
    config({ promotions: [promo({ scope: ["model"], percent: 50 })] }),
    utc(THU, "12:00"),
  ).components;
  expect(all.input.rate).toBeCloseTo(0.5, 12);
  expect(all.cachedInput.rate).toBeCloseTo(0.125, 12);
  // a component the endpoint does not price stays unpriced; a promotion cannot invent a rate
  expect(all.cacheWrite.rate).toBeNull();
});

test("a promotion can replace rates outright, ignoring the schedule for what it names", () => {
  const cfg = config({
    windows: [
      { id: "p", label: "Peak", days: [], from: 0, to: 1439, rates: { input: 2, output: 8 } },
    ],
    promotions: [promo({ scope: ["input"], percent: undefined, rates: { input: 0.1 } })],
  });
  const c = effectiveRates(card(), cfg, utc(THU, "12:00")).components;
  expect(c.input.scheduled).toBe(2);
  expect(c.input.rate).toBe(0.1);
  expect(c.output.rate).toBe(8);
});

test("an expired promotion stops applying and stays on the record", () => {
  const now = utc(THU, "12:00");
  const ended = promo({ id: "old", label: "Old", until: now - 86400e3 });
  const later = promo({ id: "new", label: "Later", from: now + 86400e3 });
  const cfg = config({ promotions: [ended, later] });
  const snapshot = effectiveRates(card(), cfg, now);
  expect(snapshot.applied).toEqual([]);
  expect(snapshot.components.input.rate).toBe(1);
  // nothing was deleted
  expect(cfg.promotions).toHaveLength(2);
  expect(promotionExpired(ended, now)).toBe(true);
  expect(promotionRunning(later, now)).toBe(false);
  // and at an instant while it ran, it applied
  expect(effectiveRates(card(), cfg, now - 2 * 86400e3).applied.map((p) => p.id)).toEqual(["old"]);
});

test("a promotion expiry is a next change, and the rate is back the moment it passes", () => {
  const now = utc(THU, "12:00");
  const until = now + 3600e3;
  const cfg = config({ promotions: [promo({ until })] });
  expect(nextChange(card(), cfg, now)).toEqual({ at: until, label: "P ends" });
  expect(effectiveRates(card(), cfg, until - 1).components.input.rate).toBeCloseTo(0.5, 12);
  expect(effectiveRates(card(), cfg, until).components.input.rate).toBe(1);
});

test("two promotions on one component are called out as not stacking", () => {
  const cfg = config({
    promotions: [
      promo({ id: "a", label: "A", percent: 30 }),
      promo({ id: "b", label: "B", percent: 60 }),
    ],
  });
  expect(pricingWarnings(card(), cfg, utc(THU, "12:00")).join(" ")).toContain("do not stack");
});

// ---------- provider-reported vs calculated ----------

test("a charge the provider reported is kept apart from the one we worked out", () => {
  const usage = normalizeUsage(
    {
      prompt_tokens: 1_000,
      completion_tokens: 1_000,
      prompt_tokens_details: { cached_tokens: 0 },
      cost: 0.009,
    },
    "openai",
  );
  const at = utc(THU, "12:00");
  const ours = priceRequest(card(), config(), usage, { at });
  expect(ours.basis).toBe("calculated");
  expect(ours.total).toBeCloseTo(0.005, 12);
  expect(ours.reported).toBe(0.009);

  const theirs = priceRequest(card(), config(), usage, { at, preferReported: true });
  expect(theirs.basis).toBe("provider-reported");
  expect(theirs.total).toBe(0.009);
  // both figures survive either way, so the difference is always visible
  expect(theirs.calculated).toBeCloseTo(0.005, 12);
});

// ---------- estimates ----------

test("an estimate before a run assumes no cache savings", () => {
  const e = estimateRates(
    card({ cachedInput: 0 }),
    config(),
    { inputTokens: 1_000_000, outputTokens: 0 },
    utc(THU, "12:00"),
  );
  // a free cached rate would make this zero if the estimate assumed a hit
  expect(e.cost).toBeCloseTo(1, 12);
  expect(e.cautions.join(" ")).toContain("assumes none of the input is cached");
  expect(e.withObservedCache).toBeNull();
});

test("an observed cache figure is offered separately and only from requests that reported one", () => {
  const e = estimateRates(
    card({ cachedInput: 0.25 }),
    config(),
    { inputTokens: 1_000_000, outputTokens: 0 },
    utc(THU, "12:00"),
    { hitRate: 0.8, samples: 12 },
  );
  expect(e.cost).toBeCloseTo(1, 12);
  expect(e.withObservedCache!.cost).toBeCloseTo(0.2 * 1 + 0.8 * 0.25, 12);
  expect(e.withObservedCache!.samples).toBe(12);

  // a provider that reports nothing produces no observation at all
  expect(
    observedCacheRate([normalizeUsage({ prompt_tokens: 100, completion_tokens: 1 }, "plain")]),
  ).toBeNull();
  expect(
    observedCacheRate([
      normalizeUsage(
        {
          prompt_tokens: 1000,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 500 },
        },
        "openai",
      ),
    ]),
  ).toEqual({ hitRate: 0.5, samples: 1 });
});

test("an estimate says what the price would be without the discounts in force", () => {
  const cfg = config({
    windows: [{ id: "n", label: "Off-peak", days: [], from: 0, to: 1439, percent: 50 }],
    promotions: [promo({ percent: 50 })],
  });
  const e = estimateRates(
    card(),
    cfg,
    { inputTokens: 1_000_000, outputTokens: 0 },
    utc(THU, "12:00"),
  );
  expect(e.cost).toBeCloseTo(0.25, 12);
  expect(e.withoutPromotions).toBeCloseTo(1, 12);
  expect(e.cautions.join(" ")).toContain("Budget checks use");
});

test("an estimate warns when a batch may cross a boundary", () => {
  const cfg = config({
    windows: [{ id: "n", label: "Off-peak", days: [], from: 22 * 60, to: 6 * 60, percent: 50 }],
  });
  const e = estimateRates(card(), cfg, { inputTokens: 1000, outputTokens: 0 }, utc(THU, "21:00"));
  expect(e.cautions.join(" ")).toContain("off-peak starts");
  expect(e.cautions.join(" ")).toContain("straddles it");
});

// ---------- reservations and budgets ----------

test("a reservation ignores discounts, so a promotion ending mid-run cannot overshoot a cap", () => {
  const p = newProfile({
    id: "x",
    name: "X",
    model: "m",
    inPrice: 1,
    outPrice: 4,
    maxOutputTokens: 1000,
    pricing: newPricing({
      timezone: "UTC",
      promotions: [{ ...promo({ percent: 90 }), id: "big", label: "Big" }],
    }),
  });
  const at = utc(THU, "12:00");
  const cheap = tokenEstimate("x".repeat(4000), p, at);
  const bare = tokenEstimate(
    "x".repeat(4000),
    { ...p, pricing: newPricing({ timezone: "UTC" }) },
    at,
  );
  // the estimate follows the promotion...
  expect(cheap.cost).toBeCloseTo(bare.cost * 0.1, 10);
  // ...but the reservation does not
  expect(cheap.reserve).toBeCloseTo(bare.reserve, 12);
  expect(cheap.reserve).toBeGreaterThan(cheap.cost);
});

test("a budget check uses the undiscounted price, and says so when that is what blocks it", () => {
  const library = useLibraryStore();
  const scripting = useScriptingStore();
  const jobs = useJobsStore();
  const book = library.books[0];
  const ids = library
    .chaptersOf(book.id)
    .slice(0, 2)
    .map((c) => c.id);

  const bare = scripting.scriptEstimate(book.id, ids);
  expect(bare.rates).not.toBeNull();
  // a cap that the discounted run fits but the undiscounted one does not
  const cap = (bare.rates!.cost + bare.rates!.withoutPromotions) / 2;
  if (bare.rates!.withoutPromotions > bare.rates!.cost) {
    book.scriptBudget = cap;
    const blocked = scripting.scriptEstimate(book.id, ids);
    expect(blocked.blockers.join(" ")).toContain("Without the discounts in force");
  }
  book.scriptBudget = null;
  expect(jobs.scriptSpent(book.id)).toBe(0);
});

// ---------- historical accuracy ----------

test("a receipt is not re-priced when the rate card changes afterwards", () => {
  const cfg = config({ promotions: [promo({ percent: 50 })] });
  const usage = normalizeUsage(
    { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
    "openai",
  );
  const receipt = priceRequest(card(), cfg, usage, { at: utc(THU, "12:00") });
  expect(receipt.total).toBeCloseTo(0.5, 12);

  // the promotion ends and the base rate doubles, long after the request landed
  cfg.promotions = [];
  const base = card({ input: 2 });
  expect(receipt.total).toBeCloseTo(0.5, 12);
  expect(receipt.rates.input.rate).toBeCloseTo(0.5, 12);
  expect(receipt.rates.input.why.join(" ")).toContain("P");
  // only a *new* request sees the new card
  expect(priceRequest(base, cfg, usage, { at: utc(FRI, "12:00") }).total).toBeCloseTo(2, 12);
});

test("each request is priced at its own instant, not at the batch's starting price", () => {
  const cfg = config({
    windows: [{ id: "n", label: "Off-peak", days: [], from: 22 * 60, to: 6 * 60, percent: 50 }],
  });
  const usage = normalizeUsage(
    { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
    "openai",
  );
  // a four-request batch straddling 06:00, when the off-peak window closes
  const instants = [utc(FRI, "05:58"), utc(FRI, "05:59"), utc(FRI, "06:00"), utc(FRI, "06:01")];
  const totals = instants.map((at) => priceRequest(card(), cfg, usage, { at }).total);
  expect(totals).toEqual([0.5, 0.5, 1, 1]);
  // and every receipt records which instant it used, and the rule that chose it
  const one = priceRequest(card(), cfg, usage, { at: instants[0] });
  expect(one.at).toBe(instants[0]);
  expect(one.rule).toContain("completed");
});

// ---------- the simulated provider ----------

test("the simulated provider round-trips through the normalizer for every shape it speaks", () => {
  for (const format of ["openai", "anthropic", "plain"] as const) {
    const { raw, usage } = simulateUsage(
      { inputTokens: 10_000, outputTokens: 2_000, cacheHit: 0.8 },
      format,
    );
    expect(usage.inputTokens).toBe(10_000);
    expect(usage.outputTokens).toBe(2_000);
    expect(usage.format).toBe(format);
    if (format === "plain") {
      expect(usage.cachedInput).toBeNull();
      expect(raw.prompt_tokens_details).toBeUndefined();
    } else {
      expect(usage.cachedInput).toBe(8_000);
      expect(uncachedInput(usage)).toBe(2_000);
    }
  }
});

test("a corrupt payload is caught by the normalizer rather than by the arithmetic", () => {
  const { usage } = simulateUsage(
    { inputTokens: 1_000, outputTokens: 10, cacheHit: 0.5, corrupt: "cache-exceeds-input" },
    "openai",
  );
  expect(usageTrustworthy(usage)).toBe(false);
  expect(uncachedInput(usage)).toBe(0);

  const { usage: noOutput } = simulateUsage(
    { inputTokens: 1_000, outputTokens: 10, cacheHit: 0, corrupt: "no-output" },
    "anthropic",
  );
  expect(noOutput.problems.map((p) => p.code)).toContain("output-missing");
});

test("the provider shape follows the provider, and only a reporting one can have a cache", () => {
  expect(usageFormatFor("claude-sonnet-5", "https://api.anthropic.com/v1")).toBe("anthropic");
  expect(usageFormatFor("gpt-4o-mini", "https://api.openai.com/v1")).toBe("openai");
  expect(usageFormatFor("kokoro", "http://localhost:8000/v1")).toBe("plain");
  // the first request of a run has nothing to read back, and writes the prefix instead
  expect(cacheShapeFor(1, true).cacheHit).toBe(0);
  expect(cacheShapeFor(1, true).cacheWrite).toBeGreaterThan(0);
  expect(cacheShapeFor(4, true).cacheHit).toBeGreaterThan(0);
  expect(cacheShapeFor(4, false)).toEqual({ cacheHit: 0, cacheWrite: 0 });
});

// ---------- configuration validation ----------

test("contradictory rate cards are reported rather than silently priced", () => {
  const problems = pricingProblems(
    config({
      windows: [{ id: "w", label: "", days: [], from: 0, to: 60 }],
      promotions: [
        promo({ id: "a", label: "A", from: 100, until: 50 }),
        promo({ id: "b", label: "B", scope: [], percent: 0 }),
      ],
    }),
  );
  const text = problems.join(" | ");
  expect(text).toContain("needs a name");
  expect(text).toContain("does not change any rate");
  expect(text).toContain("ends before it starts");
  expect(text).toContain("pick a scope");
});

test("a cached rate dearer than ordinary input is a warning, not a blocker", () => {
  const cfg = config({ cachedInput: 5 });
  expect(pricingProblems(cfg)).toEqual([]);
  expect(pricingWarnings(card(), cfg, utc(THU, "12:00")).join(" ")).toContain("right way round");
});

test("a profile with no advanced pricing prices exactly as it always did", () => {
  const p = newProfile({ id: "p", name: "P", model: "m", inPrice: 0.15, outPrice: 0.6 });
  const cfg = ensurePricing(p);
  expect(cfg.windows).toEqual([]);
  expect(cfg.promotions).toEqual([]);
  expect(cfg.cachedInput).toBeNull();
  const at = Date.now();
  const e = tokenEstimate("x".repeat(4000), p, at);
  const tokens = { inputTokens: e.inputTokens, outputTokens: e.outputTokens };
  expect(e.cost).toBeCloseTo((tokens.inputTokens * 0.15 + tokens.outputTokens * 0.6) / 1e6, 12);
  expect(effectiveRates(baseRates(p), cfg, at).next).toBeNull();
});

// ---------- the seeded world ----------

test("the seeded endpoints cover every pricing case the demo claims to", () => {
  const store = useEndpointsStore();
  const byId = (id: string) => store.profiles.find((p) => p.id === id)!;
  // cached input, a schedule with a midnight-crossing window, and promotions
  expect(byId("openai").pricing!.cachedInput).toBeGreaterThan(0);
  expect(byId("openai").pricing!.windows.some((w) => w.to <= w.from)).toBe(true);
  expect(byId("openai").pricing!.promotions.length).toBeGreaterThan(2);
  // one running, one ended, one not started yet
  const now = Date.now();
  const promos = byId("openai").pricing!.promotions;
  expect(promos.some((p) => promotionRunning(p, now))).toBe(true);
  expect(promos.some((p) => promotionExpired(p, now))).toBe(true);
  expect(promos.some((p) => p.from != null && p.from > now)).toBe(true);
  // a separate cache-write rate where it is relevant, and none where it is not
  expect(byId("deepseek").pricing!.cacheWrite).toBeGreaterThan(0);
  expect(byId("openai").pricing!.cacheWrite).toBeNull();
  // and a model you host yourself, with no advanced pricing at all
  expect(byId("antigravity").pricing!.windows).toEqual([]);
  expect(byId("antigravity").pricing!.promotions).toEqual([]);
});

// ---------- speech endpoints ----------

const speechCard = (over: Partial<TtsBilling> = {}): TtsBilling => ({
  unit: "chars",
  rate: 12,
  ...over,
});

test("a speech rate goes through the same schedule and the same promotions as a token rate", () => {
  const cfg = config({
    windows: [{ id: "n", label: "Off-peak", days: [], from: 22 * 60, to: 6 * 60, percent: 40 }],
    promotions: [promo({ scope: ["model"], percent: 20 })],
  });
  // outside the window: only the promotion
  const day = effectiveRates(speechRates(speechCard()), cfg, utc(THU, "12:00")).components.speech;
  expect(day.base).toBe(12);
  expect(day.scheduled).toBe(12);
  expect(day.rate).toBeCloseTo(9.6, 12);

  // inside it: the schedule first, then the promotion on what it left — never compounded off base
  const night = effectiveRates(speechRates(speechCard()), cfg, utc(THU, "23:00")).components.speech;
  expect(night.scheduled).toBeCloseTo(7.2, 12);
  expect(night.rate).toBeCloseTo(5.76, 12);
  expect(night.why).toHaveLength(2);
});

test("a speech promotion scoped to a token component does nothing, and says so", () => {
  const cfg = config({ promotions: [promo({ scope: ["output"], percent: 50 })] });
  const at = utc(THU, "12:00");
  const base = speechRates(speechCard());
  expect(effectiveRates(base, cfg, at).components.speech.rate).toBe(12);
  expect(pricingWarnings(base, cfg, at).join(" ")).toContain(
    "applies to nothing this endpoint prices",
  );
});

test("a discount on a rate nobody knows is still a rate nobody knows", () => {
  const cfg = config({
    windows: [{ id: "n", label: "Night", days: [], from: 0, to: 1439, percent: 30 }],
    promotions: [promo({ percent: 50 })],
  });
  const at = utc(THU, "12:00");
  const snapshot = effectiveRates(speechRates(speechCard({ rate: null })), cfg, at);
  expect(snapshot.components.speech.rate).toBeNull();
  expect(snapshot.components.speech.why).toEqual([]);
  expect(snapshot.applied).toEqual([]);

  const charge = priceSpeechRequest(
    speechCard({ rate: null }),
    cfg,
    u({ chars: 5000, audioSeconds: 60 }),
    { at },
  );
  expect(charge.amount).toBeNull();
  expect(charge.basis).toBe("unknown");
  expect(charge.unknowns.join(" ")).toContain("floor");
});

test("a clip is charged in the unit its endpoint bills by, at the rate in force when it landed", () => {
  const cfg = config({
    windows: [{ id: "n", label: "Off-peak", days: [], from: 22 * 60, to: 6 * 60, percent: 50 }],
  });
  const measured = u({ chars: 1_000_000, audioSeconds: 600, requests: 3 });

  const perChar = priceSpeechRequest(speechCard({ unit: "chars", rate: 12 }), cfg, measured, {
    at: utc(THU, "23:00"),
  });
  expect(perChar.lines[0].rate).toBe(6);
  expect(perChar.amount).toBeCloseTo(6, 12);
  expect(perChar.unit).toBe("chars");

  // per audio minute: the text length is irrelevant, the duration is not
  const perMinute = priceSpeechRequest(speechCard({ unit: "minute", rate: 0.3 }), cfg, measured, {
    at: utc(THU, "23:00"),
  });
  expect(perMinute.amount).toBeCloseTo((600 / 60) * 0.15, 12);

  // a flat fee per call is charged for every piece a split line became
  const perRequest = priceSpeechRequest(
    speechCard({ unit: "request", rate: 0.02 }),
    cfg,
    measured,
    {
      at: utc(THU, "23:00"),
    },
  );
  expect(perRequest.amount).toBeCloseTo(0.01 * 3, 12);

  // and outside the window the same clip costs the card rate
  expect(
    priceSpeechRequest(speechCard({ unit: "chars", rate: 12 }), cfg, measured, {
      at: utc(THU, "12:00"),
    }).amount,
  ).toBeCloseTo(12, 12);
});

test("a clip that failed is charged for what it sent, not for audio it never produced", () => {
  const at = utc(THU, "12:00");
  const failed = u({ chars: 1_000_000, audioSeconds: 0, requests: 1 });
  expect(
    priceSpeechRequest(speechCard({ unit: "chars", rate: 12 }), config(), failed, { at }).amount,
  ).toBeCloseTo(12, 12);
  expect(
    priceSpeechRequest(speechCard({ unit: "minute", rate: 0.3 }), config(), failed, { at }).amount,
  ).toBe(0);
});

test("a speech receipt keeps its rate when the card changes afterwards", () => {
  const cfg = config({ promotions: [promo({ percent: 50 })] });
  const receipt = priceSpeechRequest(speechCard(), cfg, u({ chars: 1_000_000, audioSeconds: 60 }), {
    at: utc(THU, "12:00"),
  });
  expect(receipt.amount).toBeCloseTo(6, 12);
  cfg.promotions = [];
  expect(receipt.amount).toBeCloseTo(6, 12);
  expect(receipt.lines[0].rate).toBe(6);
  expect(receipt.lines[0].base).toBe(12);
  expect(speechWhy(receipt).join(" ")).toContain("P");
});

test("a speech estimate offers the undiscounted figure a budget has to use", () => {
  const cfg = config({ promotions: [promo({ percent: 75 })] });
  const e = estimateSpeech(
    speechCard(),
    cfg,
    { chars: 1_000_000, audioSeconds: 600, requests: 4 },
    utc(THU, "12:00"),
  );
  expect(e.cost).toBeCloseTo(3, 12);
  expect(e.withoutPromotions).toBeCloseTo(12, 12);
  expect(e.cautions.join(" ")).toContain("Budget checks use");
});

test("both kinds of receipt render through the same charge lines", () => {
  const usage = normalizeUsage(
    {
      prompt_tokens: 10_000,
      completion_tokens: 2_000,
      prompt_tokens_details: { cached_tokens: 8_000 },
    },
    "openai",
  );
  const tokens = tokenChargeLines(
    priceRequest(card({ cachedInput: 0.25 }), config(), usage, { at: utc(THU, "12:00") }),
  );
  expect(tokens.map((l) => l.label)).toEqual(["Input", "Cached input", "Output"]);
  expect(tokens[0].quantity).toBe("2,000 tokens");
  expect(tokens[0].rate).toBe("$1.00 / 1M tokens");

  const speech = speechChargeLines(
    priceSpeechRequest(
      speechCard({ unit: "minute", rate: 0.3 }),
      config(),
      {
        chars: 1240,
        audioSeconds: 90,
      },
      { at: utc(THU, "12:00") },
    ),
  );
  expect(speech).toHaveLength(1);
  expect(speech[0].quantity).toBe("1.50 audio minutes");
  expect(speech[0].rate).toBe("$0.30 / audio min");
  // the two shapes agree on what a line is, which is what lets one table render both
  expect(Object.keys(speech[0]).every((k) => k in tokens[0] || k === "note")).toBe(true);
});

test("the seeded speech endpoints cover the discount cases too", () => {
  const store = useEndpointsStore();
  const byId = (id: string) => store.endpoints.find((e) => e.id === id)!;
  // a nightly window that runs past midnight, and a promotion on top of it
  expect(byId("openai").pricing!.windows.some((w) => w.to <= w.from)).toBe(true);
  expect(byId("openai").pricing!.promotions.some((p) => promotionRunning(p, Date.now()))).toBe(
    true,
  );
  // a free local model with no advanced pricing at all — the block is absent until something asks
  // for it, and asking gives it an empty schedule and no promotions, which is "ordinary pricing"
  expect(byId("local").pricing).toBeUndefined();
  expect(ensurePricing(byId("local"))).toEqual({
    cachedInput: null,
    cacheWrite: null,
    timezone: localTimezone(),
    windows: [],
    promotions: [],
  });
  // and one whose rate is unknown, where the window it has changes nothing
  const proxy = byId("proxy");
  expect(proxy.billing!.rate).toBeNull();
  expect(proxy.pricing!.windows.length).toBeGreaterThan(0);
  expect(
    effectiveRates(speechRates(proxy.billing!), proxy.pricing!, Date.now()).components.speech.rate,
  ).toBeNull();
});

// ---------- input is not always the dearest way an input token is charged ----------
//
// Cached and cache-write tokens are slices of the input, and nothing makes them cheaper than it. A
// cache write usually costs *more* — the app's own switch defaults one to 125% of the input rate —
// so "the whole input at the ordinary rate" is a middle case, not a ceiling, and a reservation
// worked out that way can be overshot by the very first request that writes to the cache.

test("the dearest input rate is what a reservation is taken at, not the ordinary one", () => {
  const p = newProfile({
    id: "cw",
    name: "CW",
    model: "m",
    inPrice: 1,
    outPrice: 4,
    maxOutputTokens: 1000,
    // exactly what the Pricing tab's "charge for cache writes" switch sets
    pricing: newPricing({ timezone: "UTC", cacheWrite: 1.25 }),
  });
  const at = utc(THU, "12:00");
  const e = tokenEstimate("x".repeat(4000), p, at);
  const ordinary = (e.inputTokens * p.inPrice + p.maxOutputTokens * p.outPrice) / 1e6;
  expect(e.reserve).toBeCloseTo((e.inputTokens * 1.25 + p.maxOutputTokens * 4) / 1e6, 12);
  expect(e.reserve).toBeGreaterThan(ordinary);

  // and a request that really does write its whole input to the cache fits inside that reservation
  const usage = normalizeUsage(
    { inputTokens: e.inputTokens, cacheWrite: e.inputTokens, cachedInput: 0, outputTokens: 0 },
    "internal",
  );
  const real = priceRequest(baseRates(p), ensurePricing(p), usage, { at });
  expect(real.total!).toBeLessThanOrEqual(e.reserve + 1e-12);
});

test("a run estimate names the ceiling rather than promising the real cost is lower", () => {
  const e = estimateRates(
    card({ cacheWrite: 3 }),
    config(),
    { inputTokens: 1e6, outputTokens: 0 },
    utc(THU, "12:00"),
  );
  // the headline still charges the ordinary rate, because that is what usually happens...
  expect(e.cost).toBeCloseTo(1, 12);
  // ...but it does not claim to be an upper bound, and the budget figure is the real ceiling
  expect(e.cautions.join(" ")).not.toContain("this or less");
  expect(e.cautions.join(" ")).toContain("ceiling");
  expect(e.withoutPromotions).toBeCloseTo(3, 12);
});

test("an endpoint whose cache rates are cheaper keeps the plain upper-bound wording", () => {
  const e = estimateRates(
    card({ cachedInput: 0.25 }),
    config(),
    { inputTokens: 1e6, outputTokens: 0 },
    utc(THU, "12:00"),
  );
  expect(e.cautions.join(" ")).toContain("The real cost is this or less.");
  expect(e.withoutPromotions).toBeCloseTo(1, 12);
});

test("a request whose provider said nothing about cache says which way the uncertainty runs", () => {
  const usage = normalizeUsage({ prompt_tokens: 1e6, completion_tokens: 0 }, "plain");
  const cheap = priceRequest(card({ cachedInput: 0.25 }), config(), usage, {
    at: utc(THU, "12:00"),
  });
  expect(cheap.unknowns.join(" ")).toContain("the real cost is this figure or less");

  const dear = priceRequest(card({ cachedInput: 4 }), config(), usage, { at: utc(THU, "12:00") });
  expect(dear.unknowns.join(" ")).toContain("could be more than this figure");
});

// ---------- calendar dates belong to the endpoint, not to the operator ----------

test("a calendar date is read and written in the endpoint's own timezone", () => {
  const ny = "America/New_York";
  // 02:00 UTC is still the previous evening in New York
  expect(calendarDay(Date.UTC(2026, 8, 17, 2, 0, 0), ny)).toBe("2026-09-16");
  expect(calendarDay(Date.UTC(2026, 8, 17, 2, 0, 0), "Asia/Karachi")).toBe("2026-09-17");
  // a promotion starting on the 17th starts at midnight *there* — 04:00 UTC in September
  expect(new Date(startOfDay("2026-09-17", ny)!).toISOString()).toBe("2026-09-17T04:00:00.000Z");
  // and one ending on the 17th runs to the last moment of that day there
  expect(new Date(endOfDay("2026-09-17", ny)!).toISOString()).toBe("2026-09-18T03:59:59.999Z");
  // winter is an hour further out, so the offset is read at the date rather than assumed
  expect(new Date(endOfDay("2026-01-17", ny)!).toISOString()).toBe("2026-01-18T04:59:59.999Z");
  // a zone the browser cannot read falls back to UTC rather than to the operator's own
  expect(calendarDay(Date.UTC(2026, 8, 17, 2, 0, 0), "Not/AZone")).toBe("2026-09-17");
});

test("a promotion edited from another timezone keeps the day it names", () => {
  const ny = "America/New_York";
  // the day a promotion ends, read back out, is the day that was typed — whatever zone reads it
  for (const day of ["2026-03-07", "2026-03-08", "2026-11-01", "2026-06-30"]) {
    expect(calendarDay(endOfDay(day, ny)!, ny)).toBe(day);
    expect(calendarDay(startOfDay(day, ny)!, ny)).toBe(day);
  }
  // seven days on from an instant is seven calendar days on where the endpoint is billed
  expect(calendarDay(endOfDayAfter(Date.UTC(2026, 8, 17, 12), ny, 7), ny)).toBe("2026-09-24");
});

// ---------- a speech rate is not quoted per million of anything ----------

test("a schedule's reason is written in the unit the endpoint actually bills in", () => {
  const perMinute: TtsBilling = { unit: "minute", rate: 0.9 };
  const cfg = config({
    windows: [{ id: "n", label: "Night", days: [], from: 0, to: 1439, rates: { speech: 0.4 } }],
  });
  const charge = priceSpeechRequest(perMinute, cfg, u({ chars: 1000, audioSeconds: 60 }), {
    at: utc(THU, "12:00"),
  });
  expect(speechWhy(charge).join(" ")).toContain("/ audio min");
  expect(speechWhy(charge).join(" ")).not.toContain("/ 1M");

  // the token side is unchanged: those really are per million tokens
  const tokens = effectiveRates(
    card(),
    config({
      windows: [{ id: "n", label: "Night", days: [], from: 0, to: 1439, rates: { input: 0.4 } }],
    }),
    utc(THU, "12:00"),
  );
  expect(tokens.components.input.why.join(" ")).toContain("/ 1M tokens");
});

test("a promotion that names an explicit speech rate quotes it in the same unit", () => {
  const perRequest: TtsBilling = { unit: "request", rate: 0.02 };
  const cfg = config({
    promotions: [
      {
        id: "p",
        label: "Flat rate week",
        from: null,
        until: null,
        scope: ["speech"],
        rates: { speech: 0.01 },
      },
    ],
  });
  const charge = priceSpeechRequest(
    perRequest,
    cfg,
    u({ chars: 100, audioSeconds: 5, requests: 3 }),
    { at: utc(THU, "12:00") },
  );
  expect(charge.amount).toBeCloseTo(0.03, 12);
  expect(speechWhy(charge).join(" ")).toContain("/ request");
});

// ---------- an invalid rate card blocks a speech endpoint too ----------

test("malformed pricing is an error on a speech endpoint, not only on a scripting profile", () => {
  const ep = ttsEndpointForPricing();
  expect(endpointErrors(unifyEndpoint(ep))).toEqual([]);
  ep.pricing!.promotions = [
    { id: "dup", label: "A", from: null, until: null, scope: ["speech"], percent: 10 },
    { id: "dup", label: "B", from: null, until: null, scope: ["speech"], percent: 20 },
  ];
  expect(endpointErrors(unifyEndpoint(ep)).join(" ")).toContain("share the id");

  ep.pricing!.promotions = [
    { id: "b", label: "Backwards", from: 2000, until: 1000, scope: ["speech"], percent: 10 },
  ];
  expect(endpointErrors(unifyEndpoint(ep)).join(" ")).toContain("ends before it starts");

  ep.pricing!.promotions = [];
  ep.pricing!.windows = [{ id: "w", label: "Bad", days: [], from: -1, to: 99999, percent: 10 }];
  expect(endpointErrors(unifyEndpoint(ep)).join(" ")).toContain("outside 00:00–23:59");
});

// ---------- billing models: what is counted, and what that costs ----------

test("the three counts of one line are different numbers and never conversions of each other", () => {
  // 11 characters; the two Hanzi are three UTF-8 bytes each, the nine ASCII ones are one
  const text = "外门 disciple";
  expect(billableChars(text)).toBe(11);
  expect(utf8Bytes(text)).toBe(6 + 9);
  // an emoji is one billable character and four bytes — `String.length` says two and is wrong twice
  expect(billableChars("🜁")).toBe(1);
  expect("🜁".length).toBe(2);
  expect(utf8Bytes("🜁")).toBe(4);
});

test("counting is of what was submitted, not of the source text or the split limit", () => {
  const billing: TtsBilling = { unit: "bytes", rate: 15 };
  // the line as the endpoint receives it: after the dictionary and the expression tags
  const submitted = measureSpeech(
    { text: "[softly] 外门 disciple", instructions: "weary, half-asleep", requests: 4 },
    billing,
  );
  expect(submitted.chars).toBe(billableChars("[softly] 外门 disciple\nweary, half-asleep"));
  expect(submitted.bytes).toBeGreaterThan(submitted.chars);
  // the instructions are part of it, and separately visible
  expect(submitted.instructionChars).toBe("weary, half-asleep".length);
  // and the split limit changes the request count without changing what was counted
  expect(submitted.requests).toBe(4);
  const unsplit = measureSpeech(
    { text: "[softly] 外门 disciple", instructions: "weary, half-asleep", requests: 1 },
    billing,
  );
  expect(unsplit.chars).toBe(submitted.chars);
  expect(unsplit.bytes).toBe(submitted.bytes);
});

test("an endpoint that does not bill for instructions does not count them", () => {
  const sent = { text: "Hello there.", instructions: "briskly" };
  expect(measureSpeech(sent, { unit: "chars", rate: 1 }).chars).toBe(
    "Hello there.\nbriskly".length,
  );
  expect(measureSpeech(sent, { unit: "chars", rate: 1, billsInstructions: false }).chars).toBe(
    "Hello there.".length,
  );
  // and they are still sent — only the billable count changes
  expect(
    measureSpeech(sent, { unit: "chars", rate: 1, billsInstructions: false }).instructionChars,
  ).toBe(0);
});

test("a byte-billed endpoint charges the bytes, and a character-billed one the characters", () => {
  const cfg = config();
  const at = utc(THU, "12:00");
  const sent = { text: "外门".repeat(1000), requests: 1, audioSeconds: 0 };
  const bytes: TtsBilling = { unit: "bytes", rate: 15 };
  const chars: TtsBilling = { unit: "chars", rate: 15 };

  const byBytes = priceSpeechRequest(bytes, cfg, measureSpeech(sent, bytes), { at });
  const byChars = priceSpeechRequest(chars, cfg, measureSpeech(sent, chars), { at });
  // 2,000 characters, 6,000 bytes: the same rate over the same text, three times the bill
  expect(byChars.lines[0].quantity).toBe(2000);
  expect(byBytes.lines[0].quantity).toBe(6000);
  expect(byBytes.amount!).toBeCloseTo(byChars.amount! * 3, 12);
  // and each receipt still records both counts, so the comparison is inspectable
  expect(byChars.units.bytes).toBe(6000);
  expect(byBytes.units.chars).toBe(2000);
});

test("a token-billed endpoint charges the text and the audio separately and adds them", () => {
  const billing: TtsBilling = {
    unit: "audio-tokens",
    rate: 1,
    audioRate: 20,
    audioTokensPerSecond: 25,
  };
  const units = measureSpeech({ text: "a".repeat(4000), requests: 1, audioSeconds: 120 }, billing);
  expect(units.textTokens).toBe(1000);
  expect(units.audioTokens).toBe(3000);
  const charge = priceSpeechRequest(billing, config(), units, { at: utc(THU, "12:00") });
  expect(charge.lines.map((l) => l.component)).toEqual(["textTokens", "audioTokens"]);
  const input = (1000 / 1e6) * 1;
  const audio = (3000 / 1e6) * 20;
  expect(charge.lines[0].amount!).toBeCloseTo(input, 12);
  expect(charge.lines[1].amount!).toBeCloseTo(audio, 12);
  expect(charge.amount!).toBeCloseTo(input + audio, 12);
  // the audio side is not a text-token approximation: it follows the duration
  expect(charge.lines[1].quantity).toBe(Math.round(120 * 25));
});

test("audio tokens follow the configured conversion, and it is recorded on the receipt", () => {
  const at = utc(THU, "12:00");
  const price = (perSecond: number) => {
    const billing: TtsBilling = {
      unit: "audio-tokens",
      rate: 1,
      audioRate: 20,
      audioTokensPerSecond: perSecond,
    };
    return priceSpeechRequest(
      billing,
      config(),
      measureSpeech({ text: "hello", audioSeconds: 60 }, billing),
      { at },
    );
  };
  const slow = price(25);
  const fast = price(50);
  expect(fast.lines[1].quantity).toBe(slow.lines[1].quantity * 2);
  expect(slow.audioTokensPerSecond).toBe(25);
  expect(fast.audioTokensPerSecond).toBe(50);
  // and it is an assumption, so the charge says so rather than presenting it as measured
  expect(slow.basis).toBe("estimated");
  expect(slow.unknowns.join(" ")).toContain("tokens-per-second");
});

test("half a token rate prices nothing at all rather than half a request", () => {
  const billing: TtsBilling = { unit: "audio-tokens", rate: 1, audioRate: null };
  const charge = priceSpeechRequest(
    billing,
    config(),
    measureSpeech({ text: "hello", audioSeconds: 10 }, billing),
    { at: utc(THU, "12:00") },
  );
  expect(charge.amount).toBeNull();
  expect(charge.basis).toBe("unknown");
  expect(charge.unknowns.join(" ")).toContain("only one of the two rates");
  expect(billingProblems(billing)).toEqual([]);
});

test("zero is free and blank is unknown, and they never read as the same thing", () => {
  const at = utc(THU, "12:00");
  const units = measureSpeech({ text: "hello", audioSeconds: 2 }, { unit: "chars", rate: 0 });
  const free = priceSpeechRequest({ unit: "chars", rate: 0 }, config(), units, { at });
  const unknown = priceSpeechRequest({ unit: "chars", rate: null }, config(), units, { at });
  expect(free.amount).toBe(0);
  expect(free.basis).toBe("calculated");
  expect(free.unknowns).toEqual([]);
  expect(unknown.amount).toBeNull();
  expect(unknown.basis).toBe("unknown");
});

// ---------- what the provider said ----------

test("a speech provider that reports nothing leaves every count unknown, not zero", () => {
  const u = normalizeSpeechUsage(null, "none");
  expect(u.chars).toBeNull();
  expect(u.bytes).toBeNull();
  expect(u.textTokens).toBeNull();
  expect(u.audioTokens).toBeNull();
  expect(u.problems.map((p) => p.code)).toContain("usage-not-reported");
});

test("Gemini's audio tokens are the AUDIO slice of the response, not the whole of it", () => {
  const u = normalizeSpeechUsage(
    {
      usageMetadata: {
        promptTokenCount: 412,
        candidatesTokenCount: 5000,
        candidatesTokensDetails: [
          { modality: "TEXT", tokenCount: 120 },
          { modality: "AUDIO", tokenCount: 4880 },
        ],
      },
    },
    "gemini",
  );
  expect(u.textTokens).toBe(412);
  expect(u.audioTokens).toBe(4880);
});

test("Fish reports the bytes it bills on, and that is what is charged", () => {
  const billing: TtsBilling = { unit: "bytes", rate: 15 };
  const reported = normalizeSpeechUsage({ usage: { bytes: 9000, characters: 3000 } }, "fish");
  expect(reported.bytes).toBe(9000);
  const charge = priceSpeechRequest(
    billing,
    config(),
    // we counted a slightly different number on the way out; the provider's is the one billed
    measureSpeech({ text: "外门".repeat(1400) }, billing),
    { at: utc(THU, "12:00"), reported },
  );
  expect(charge.lines[0].quantity).toBe(9000);
  expect(charge.lines[0].source).toBe("reported");
  expect(charge.amount!).toBeCloseTo((9000 / 1e6) * 15, 12);
  // a figure worked out from reported usage is "calculated", not "estimated"
  expect(charge.basis).toBe("calculated");
});

test("a reported charge and one calculated from reported usage are kept apart", () => {
  const billing: TtsBilling = { unit: "bytes", rate: 15 };
  const reported = {
    ...normalizeSpeechUsage({ usage: { bytes: 9000 } }, "fish"),
    reportedCost: 0.2,
  };
  const units = measureSpeech({ text: "hello" }, billing);
  const ours = priceSpeechRequest(billing, config(), units, { at: utc(THU, "12:00"), reported });
  const theirs = priceSpeechRequest(billing, config(), units, {
    at: utc(THU, "12:00"),
    reported,
    preferReported: true,
  });
  expect(ours.basis).toBe("calculated");
  expect(theirs.basis).toBe("provider-reported");
  expect(theirs.amount).toBe(0.2);
  // both receipts keep the provider's own number beside ours rather than instead of it
  expect(ours.reported!.reportedCost).toBe(0.2);
});

test("a provider that reports a quantity this endpoint does not bill on is an estimate", () => {
  // it reports characters; this endpoint bills bytes, so the bytes are still ours
  const billing: TtsBilling = { unit: "bytes", rate: 15 };
  const reported = normalizeSpeechUsage({ characters: 300, audio_seconds: 12 }, "plain");
  const charge = priceSpeechRequest(
    billing,
    config(),
    measureSpeech({ text: "外门".repeat(150) }, billing),
    { at: utc(THU, "12:00"), reported },
  );
  expect(charge.lines[0].source).toBe("measured");
  expect(charge.unknowns.join(" ")).toContain("not the quantity this endpoint bills on");
});

// ---------- changing the model ----------

test("the components a card prices follow its billing model and nothing else", () => {
  expect(speechComponents("chars")).toEqual(["speech"]);
  expect(speechComponents("bytes")).toEqual(["speech"]);
  expect(speechComponents("request")).toEqual(["speech"]);
  expect(speechComponents("tokens")).toEqual(["textTokens"]);
  expect(speechComponents("audio-tokens")).toEqual(["textTokens", "audioTokens"]);
  // a component the model does not price is null, never zero, so nothing can charge for it
  const card = speechRates({ unit: "chars", rate: 12 });
  expect(card.textTokens).toBeNull();
  expect(card.audioTokens).toBeNull();
  const tokens = speechRates({ unit: "audio-tokens", rate: 1, audioRate: 20 });
  expect(tokens.speech).toBeNull();
  expect(tokens.textTokens).toBe(1);
  expect(tokens.audioTokens).toBe(20);
});

test("a promotion scoped to the speech rate reaches a token-billed endpoint's rates too", () => {
  const cfg = config({
    promotions: [promo({ scope: ["speech"], percent: 50 })],
  });
  const billing: TtsBilling = { unit: "audio-tokens", rate: 1, audioRate: 20 };
  const snapshot = effectiveRates(speechRates(billing), cfg, utc(THU, "12:00"), billing.unit);
  expect(snapshot.components.textTokens.rate).toBeCloseTo(0.5, 12);
  expect(snapshot.components.audioTokens.rate).toBeCloseTo(10, 12);
});

test("a promotion can discount the audio half and leave the text rate alone", () => {
  const cfg = config({ promotions: [promo({ scope: ["audioTokens"], percent: 50 })] });
  const billing: TtsBilling = { unit: "audio-tokens", rate: 1, audioRate: 20 };
  const snapshot = effectiveRates(speechRates(billing), cfg, utc(THU, "12:00"), billing.unit);
  expect(snapshot.components.textTokens.rate).toBe(1);
  expect(snapshot.components.audioTokens.rate).toBeCloseTo(10, 12);
});

test("a rate quoted in a reason wears the unit its component is billed in", () => {
  const cfg = config({
    promotions: [promo({ scope: ["audioTokens"], rates: { audioTokens: 9 } })],
  });
  const billing: TtsBilling = { unit: "audio-tokens", rate: 1, audioRate: 20 };
  const snapshot = effectiveRates(speechRates(billing), cfg, utc(THU, "12:00"), billing.unit);
  expect(snapshot.components.audioTokens.why.join(" ")).toContain("/ 1M audio tokens");
  expect(snapshot.components.audioTokens.why.join(" ")).not.toContain("/ 1M chars");
});

test("a receipt keeps the billing model it was charged under", () => {
  const billing: TtsBilling = { unit: "bytes", rate: 15 };
  const units = measureSpeech({ text: "外门".repeat(100) }, billing);
  const charge = priceSpeechRequest(billing, config(), units, { at: utc(THU, "12:00") });
  expect(charge.unit).toBe("bytes");
  const before = charge.amount;
  // the endpoint moves to token billing afterwards; the receipt does not move with it
  billing.unit = "audio-tokens";
  billing.rate = 1;
  billing.audioRate = 20;
  expect(charge.unit).toBe("bytes");
  expect(charge.amount).toBe(before);
  expect(charge.lines[0].rate).toBe(15);
});

test("a billing model is validated for contradictions but not for being incomplete", () => {
  expect(billingProblems({ unit: "chars", rate: null })).toEqual([]);
  expect(billingProblems({ unit: "chars", rate: -1 })).toHaveLength(1);
  expect(billingProblems({ unit: "audio-tokens", rate: 1, audioRate: -2 })).toHaveLength(1);
  expect(
    billingProblems({ unit: "audio-tokens", rate: 1, audioRate: 20, audioTokensPerSecond: 0 }),
  ).toHaveLength(1);
});

test("an estimate splits the input side from the audio side and they add to the total", () => {
  const billing: TtsBilling = {
    unit: "audio-tokens",
    rate: 1,
    audioRate: 20,
    audioTokensPerSecond: 25,
  };
  const units = measureSpeech(
    { text: "a".repeat(40_000), requests: 1, audioSeconds: 1200 },
    billing,
  );
  const e = estimateSpeech(billing, config(), units, utc(THU, "12:00"));
  expect(e.inputCost!).toBeCloseTo((10_000 / 1e6) * 1, 12);
  expect(e.audioCost!).toBeCloseTo((30_000 / 1e6) * 20, 12);
  expect(e.cost!).toBeCloseTo(e.inputCost! + e.audioCost!, 12);
  // and the assumption behind the audio half is named rather than left implicit
  expect(e.cautions.join(" ")).toContain("25 audio tokens a second");
});

test("a character-billed estimate has no audio side at all", () => {
  const billing: TtsBilling = { unit: "chars", rate: 12 };
  const e = estimateSpeech(
    billing,
    config(),
    measureSpeech({ text: "a".repeat(1_000_000), audioSeconds: 600 }, billing),
    utc(THU, "12:00"),
  );
  expect(e.audioCost).toBeNull();
  expect(e.inputCost!).toBeCloseTo(12, 12);
  expect(e.cost!).toBeCloseTo(12, 12);
});

test("switching billing model never reinterprets a rate, and parks it instead", () => {
  const chars: TtsBilling = { unit: "chars", rate: 15 };
  const toBytes = switchBillingUnit(chars, "bytes");
  // $15 per million characters is not $15 per million bytes, so the new model starts unknown
  expect(toBytes.unit).toBe("bytes");
  expect(toBytes.rate).toBeNull();
  expect(toBytes.parked!.chars).toEqual({ rate: 15 });

  // fill the byte rate in, move to token billing, and both earlier models are still on record
  const bytes: TtsBilling = { ...toBytes, rate: 15 };
  const toTokens = switchBillingUnit(bytes, "audio-tokens");
  expect(toTokens.rate).toBeNull();
  expect(toTokens.audioRate).toBeNull();
  expect(toTokens.audioTokensPerSecond).toBe(25);
  expect(toTokens.parked!.chars!.rate).toBe(15);
  expect(toTokens.parked!.bytes!.rate).toBe(15);

  // and going back restores what was configured rather than asking for it again
  const back = switchBillingUnit({ ...toTokens, rate: 1, audioRate: 20 }, "chars");
  expect(back.rate).toBe(15);
  expect(back.parked!.chars).toBeUndefined();
  expect(back.parked!["audio-tokens"]).toEqual({ rate: 1, audioRate: 20 });
});

test("switching to the same model changes nothing at all", () => {
  const chars: TtsBilling = { unit: "chars", rate: 15 };
  expect(switchBillingUnit(chars, "chars")).toBe(chars);
});

test("the seeded speech endpoints cover every billing model", () => {
  const byId = (id: string) => makeEndpoints(Date.now()).find((e) => e.id === id)!;
  expect(billingOf(byId("openai")).unit).toBe("chars");
  // Fish bills the bytes, whatever its price page calls them
  expect(billingOf(byId("fish"))).toMatchObject({ unit: "bytes", rate: 15 });
  // two rates, and the audio conversion is explicit rather than implied
  expect(billingOf(byId("gemini"))).toMatchObject({
    unit: "audio-tokens",
    rate: 1,
    audioRate: 20,
    audioTokensPerSecond: 25,
  });
  // free is zero and unconfigured is null, and the seeded world has one of each
  expect(billingOf(byId("local")).rate).toBe(0);
  expect(billingOf(byId("proxy")).rate).toBeNull();
  // the Gemini promotion touches the audio half only
  const preview = byId("gemini").pricing!.promotions[0];
  expect(preview.scope).toEqual(["audioTokens"]);
  expect(promotionRunning(preview, Date.now())).toBe(true);
});

test("a preset that bills in bytes says so, and the rate is the published one", () => {
  const fish = TTS_PRESETS.find((p) => p.id === "fish-pro")!;
  expect(fish.apply.billing).toEqual({ unit: "bytes", rate: 15 });
  expect(fish.note).toContain("UTF-8 bytes");
  const gemini = TTS_PRESETS.find((p) => p.id === "gemini-tts")!;
  expect(gemini.apply.billing).toMatchObject({ unit: "audio-tokens", rate: 1, audioRate: 20 });
});

test("a promotion is only called useless where the card prices something for it to miss", () => {
  const cfg = config({ promotions: [promo({ scope: ["speech"], percent: 20 })] });
  // an endpoint whose rate nobody typed in: the scope is not the problem, and saying so would send
  // the reader after the wrong thing
  expect(
    pricingWarnings(speechRates({ unit: "audio-tokens", rate: null }), cfg, utc(THU, "12:00")),
  ).toEqual([]);
  // a speech-scoped promotion does reach a token-billed card, so it is not useless there either
  expect(
    pricingWarnings(
      speechRates({ unit: "audio-tokens", rate: 1, audioRate: 20 }),
      cfg,
      utc(THU, "12:00"),
    ),
  ).toEqual([]);
  // but one scoped to the output tokens of a chat model really does apply to nothing on this card
  const wrong = config({ promotions: [promo({ scope: ["output"], percent: 20 })] });
  expect(
    pricingWarnings(
      speechRates({ unit: "audio-tokens", rate: 1, audioRate: 20 }),
      wrong,
      utc(THU, "12:00"),
    ).join(" "),
  ).toContain("applies to nothing");
});
