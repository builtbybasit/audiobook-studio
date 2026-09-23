import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import {
  baseRates,
  ensurePricing,
  estimateRates,
  newPricing,
  normalizeUsage,
  observedCacheRate,
  priceRequest,
  promotionExpired,
  promotionRunning,
  uncachedInput,
  usageTrustworthy,
} from "@/lib/pricing";
import { newProfile, tokenEstimate } from "@/lib/scripting";
import { cacheShapeFor, simulateUsage, usageFormatFor } from "@/mock/simulators/usage";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { FRI, THU, card, config, promo, utc } from "./support/pricingFixtures";

beforeEach(() => {
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  setActivePinia(createPinia());
});

describe("token accounting", () => {
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
});

describe("invalid or contradictory usage", () => {
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
});

describe("provider-reported vs calculated", () => {
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
});

describe("estimates", () => {
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
});

describe("reservations and budgets", () => {
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
    const book = library.books[0];
    const ids = library
      .chaptersOf(book.id)
      .slice(0, 2)
      .map((c) => c.id);

    const bare = scripting.scriptEstimate(book.id, ids);
    expect(bare.rates).not.toBeNull();
    // the seeded profile has a promotion running, so there is a discount for the cap to sit under
    expect(bare.rates!.withoutPromotions).toBeGreaterThan(bare.rates!.cost);
    // a cap that the discounted run fits but the undiscounted one does not
    const cap = (bare.rates!.cost + bare.rates!.withoutPromotions) / 2;
    book.scriptBudget = cap;
    const blocked = scripting.scriptEstimate(book.id, ids);
    expect(blocked.blockers.join(" ")).toContain("Without the discounts in force");
    book.scriptBudget = null;
  });
});

describe("historical accuracy", () => {
  test("a receipt is not re-priced when the rate card changes afterwards", () => {
    const cfg = config({ promotions: [promo({ percent: 50 })] });
    const usage = normalizeUsage(
      {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
      },
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
      {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
      },
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
});

describe("the simulated provider", () => {
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
});

describe("the seeded world", () => {
  test("the seeded endpoints cover every pricing case the demo claims to", () => {
    const store = useEndpointsStore();
    const byId = (id: string) => store.profiles.find((p) => p.id === id)!;
    // cached input, a schedule with a midnight-crossing window, and promotions
    expect(byId("openai").pricing!.cachedInput).toBeGreaterThan(0);
    expect(byId("openai").pricing!.windows.some((w) => w.to <= w.from)).toBe(true);
    // promotions running, ended and not started yet
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
});

describe("input is not always the dearest way an input token is charged", () => {
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
});
