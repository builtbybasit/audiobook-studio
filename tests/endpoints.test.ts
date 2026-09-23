import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { newProfile } from "@/lib/scripting";
import {
  ensureOps,
  fishModelsUrl,
  healthOf,
  isFishAudio,
  pricingLabel,
  sanitize,
  ttsRequestPath,
  unifyEndpoint,
  unifyProfile,
  voicesFromFishModels,
} from "@/lib/endpoints";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import {
  FixtureEndpointService,
  probeCost,
  probeUnits,
  seriesFrom,
  type EndpointDescriptor,
} from "@/services/endpoints";
import { maybeMoney, money, noUnits, perMillionChars, speechRates, ttsCost } from "@/lib/pricing";
import type { BillableUnits } from "@/types";
import type {
  Endpoint,
  MetricTotals,
  PricingConfig,
  RateSet,
  RequestRecord,
  TtsBilling,
} from "@/types";

const NOW = 1_700_000_000_000;

function ttsEndpoint(over: Partial<Endpoint> = {}): Endpoint {
  return {
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
    ...over,
  };
}

const totals = (over: Partial<MetricTotals> = {}): MetricTotals => ({
  requests: 0,
  failures: 0,
  rateLimits: 0,
  retries: 0,
  firstAttemptOk: 0,
  eventualOk: 0,
  queueMs: 0,
  responseMs: 0,
  p95Ms: 0,
  throughput: 0,
  cost: 0,
  unknownCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  chars: 0,
  audioSeconds: 0,
  ...over,
});

const health = (u: UnifiedEndpoint, over: Partial<Parameters<typeof healthOf>[1]> = {}) =>
  healthOf(u, {
    hasKey: true,
    errors: [],
    now: NOW,
    totals: null,
    lastSeen: null,
    tested: false,
    ...over,
  });

// ---------- billing ----------

test("a rate that isn't known is never rendered as zero", () => {
  const unknown: TtsBilling = { unit: "minute", rate: null };
  expect(perMillionChars(unknown)).toBeNull();
  expect(ttsCost(unknown, 5000, 300)).toBeNull();
  expect(maybeMoney(null)).toBe("unknown");
  expect(maybeMoney(0)).toBe("$0.00");
  expect(pricingLabel(unifyEndpoint(ttsEndpoint({ billing: unknown })))).toBe("rate not known");
});

const units = (over: Partial<BillableUnits> = {}): BillableUnits => ({
  ...noUnits(),
  requests: 1,
  ...over,
});

test("each billing unit prices a request by what it actually charges for", () => {
  expect(ttsCost({ unit: "chars", rate: 15 }, units({ chars: 2_000_000 }))).toBeCloseTo(30, 6);
  expect(ttsCost({ unit: "bytes", rate: 15 }, units({ bytes: 2_000_000 }))).toBeCloseTo(30, 6);
  // `tokens` is per 1M **text tokens**, not a per-character rate wearing a different label
  expect(ttsCost({ unit: "tokens", rate: 4 }, units({ textTokens: 1_000_000 }))).toBeCloseTo(4, 6);
  expect(ttsCost({ unit: "minute", rate: 0.3 }, units({ audioSeconds: 120 }))).toBeCloseTo(0.6, 6);
  // a flat fee does not scale with the text
  expect(ttsCost({ unit: "request", rate: 0.02 }, units({ chars: 10 }))).toBe(0.02);
  expect(
    ttsCost({ unit: "request", rate: 0.02 }, units({ chars: 100_000, audioSeconds: 900 })),
  ).toBe(0.02);
  // two rates, charged on two different quantities, added rather than substituted
  expect(
    ttsCost(
      { unit: "audio-tokens", rate: 1, audioRate: 20 },
      units({ textTokens: 1_000_000, audioTokens: 500_000 }),
    ),
  ).toBeCloseTo(1 + 10, 6);
});

test("per-request billing has no per-character equivalent for the run estimator", () => {
  expect(perMillionChars({ unit: "request", rate: 0.02 })).toBeNull();
  expect(perMillionChars({ unit: "chars", rate: 12 })).toBe(12);
  expect(perMillionChars({ unit: "tokens", rate: 12 })).toBe(3);
  expect(perMillionChars({ unit: "minute", rate: 0.3 })!).toBeGreaterThan(0);
  // a byte rate is a different quantity over non-ASCII text, not a different scale, so it has no
  // honest per-character equivalent at all
  expect(perMillionChars({ unit: "bytes", rate: 15 })).toBeNull();
  expect(perMillionChars({ unit: "audio-tokens", rate: 1, audioRate: 20 })).toBeNull();
});

test("money keeps fractions of a cent visible", () => {
  expect(money(0)).toBe("$0.00");
  expect(money(12.5)).toBe("$12.50");
  expect(money(0.000045)).toBe("$0.00005");
});

// ---------- health ----------

test("an endpoint that has never been used is not called healthy", () => {
  const u = unifyProfile(newProfile({ id: "p", name: "P", model: "m" }));
  const h = health(u, { totals: totals() });
  expect(h.state).toBe("untested");
  expect(h.label).toBe("Not tested");
});

test("an endpoint that has answered before but not lately reads as quiet, not healthy", () => {
  const u = unifyProfile(newProfile({ id: "p", name: "P", model: "m" }));
  const h = health(u, { totals: totals(), lastSeen: NOW - 3 * 3600e3 });
  expect(h.state).toBe("idle");
  expect(h.label).toBe("No recent activity");
});

test("paused, misconfigured and key-less states win over observed traffic", () => {
  const good = totals({ requests: 10, eventualOk: 10, firstAttemptOk: 10 });
  const paused = unifyProfile(newProfile({ id: "p", name: "P", model: "m", enabled: false }));
  expect(health(paused, { totals: good }).state).toBe("paused");

  const u = unifyProfile(newProfile({ id: "p", name: "P", model: "m" }));
  expect(health(u, { totals: good, errors: ["Enter a model ID."] }).state).toBe("misconfigured");
  expect(health(u, { totals: good, hasKey: false }).state).toBe("nokey");

  const cooling = unifyEndpoint(ttsEndpoint({ backoffUntil: NOW + 9000 }));
  const h = health(cooling, { totals: good });
  expect(h.state).toBe("cooldown");
  expect(h.label).toContain("9s");
});

test("first-attempt and eventual success are judged separately", () => {
  const u = unifyProfile(newProfile({ id: "p", name: "P", model: "m" }));
  // everything lands, but only after retries
  expect(
    health(u, { totals: totals({ requests: 20, eventualOk: 20, firstAttemptOk: 10 }) }).state,
  ).toBe("degraded");
  // rate limits alone are enough to stop calling it healthy
  expect(
    health(u, {
      totals: totals({ requests: 20, eventualOk: 20, firstAttemptOk: 20, rateLimits: 2 }),
    }).state,
  ).toBe("degraded");
  expect(
    health(u, { totals: totals({ requests: 20, eventualOk: 20, firstAttemptOk: 20 }) }).state,
  ).toBe("healthy");
  expect(
    health(u, { totals: totals({ requests: 20, eventualOk: 4, firstAttemptOk: 4 }) }).state,
  ).toBe("failing");
});

// ---------- metrics ----------

function record(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: Math.random().toString(36),
    endpointId: "p",
    kind: "scripting",
    bookId: "cliche",
    chapterId: 1,
    label: "chunk",
    status: "done",
    attempts: 1,
    queuedAt: NOW - 60_000,
    startedAt: NOW - 55_000,
    finishedAt: NOW - 50_000,
    queueMs: 5000,
    responseMs: 5000,
    usage: { inputTokens: 1000, outputTokens: 500 },
    cost: 0.001,
    costBasis: "recorded",
    simulated: true,
    ...over,
  };
}

test("queue wait and provider response stay separate in the buckets", () => {
  const s = seriesFrom(
    [record({ queueMs: 2000, responseMs: 8000 }), record({ queueMs: 4000, responseMs: 6000 })],
    "scripting",
    "1h",
    NOW,
  );
  expect(s.totals.requests).toBe(2);
  expect(s.totals.queueMs).toBe(3000);
  expect(s.totals.responseMs).toBe(7000);
});

test("unknown costs are counted, not silently added as zero", () => {
  const s = seriesFrom(
    [record({ cost: 0.25 }), record({ cost: null, costBasis: "unknown" })],
    "scripting",
    "1h",
    NOW,
  );
  expect(s.totals.cost).toBe(0.25);
  expect(s.totals.unknownCost).toBe(1);
});

test("throughput is tokens a minute for scripting and audio minutes a minute for speech", () => {
  const tokens = seriesFrom(
    [record({ usage: { inputTokens: 600, outputTokens: 0 } })],
    "scripting",
    "1h",
    NOW,
  );
  expect(tokens.totals.throughput).toBeCloseTo(10, 6); // 600 tokens over 60 minutes

  const audio = seriesFrom(
    [record({ kind: "tts", usage: { chars: 100, audioSeconds: 600 } })],
    "tts",
    "1h",
    NOW,
  );
  expect(audio.totals.throughput).toBeCloseTo(10 / 60, 6); // 10 audio minutes over 60
});

test("records outside the range do not reach the buckets", () => {
  const old = record({ finishedAt: NOW - 5 * 3600e3, queuedAt: NOW - 5 * 3600e3 });
  expect(seriesFrom([old], "scripting", "1h", NOW).totals.requests).toBe(0);
  expect(seriesFrom([old], "scripting", "6h", NOW).totals.requests).toBe(1);
});

test("a clicked bucket selects exactly the records that made it", () => {
  const rows = [record(), record({ finishedAt: NOW - 40 * 60_000 })];
  const s = seriesFrom(rows, "scripting", "1h", NOW);
  const spike = s.buckets.find((b) => b.requests > 0)!;
  const inside = rows.filter((r) => r.finishedAt! >= spike.from && r.finishedAt! <= spike.to);
  expect(inside.length).toBe(spike.requests);
});

// ---------- redaction ----------

test("anything key-shaped is redacted before an error body is shown or copied", () => {
  const body = '{"error":{"message":"Invalid key sk-abcdef0123456789abcdef"},"api_key":"hunter2"}';
  const clean = sanitize(body);
  expect(clean).not.toContain("abcdef0123456789abcdef");
  expect(clean).not.toContain("hunter2");
  expect(clean).toContain("redacted");
  expect(sanitize("Authorization: Bearer xyz1234567890abcdef")).not.toContain(
    "xyz1234567890abcdef",
  );
});

// ---------- ops defaults ----------

test("operational defaults are filled in once and never overwrite what is set", () => {
  const e = ttsEndpoint({ cooldownSec: 42 });
  ensureOps(e, "tts");
  expect(e.cooldownSec).toBe(42);
  expect(e.timeoutSec).toBeGreaterThan(0);
  expect(e.spendLimit).toBeNull();
  const before = { ...e };
  ensureOps(e, "tts");
  expect(e).toEqual(before);
});

// ---------- the fixture service ----------
// It sleeps a few hundred milliseconds to feel like a network; the waits are skipped. The hooks
// apply to the whole file, where nothing else sets a timer.
let restoreTimers: () => void = () => {};
beforeEach(() => {
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
  restoreTimers = () => spy.mockRestore();
});
afterEach(() => restoreTimers());

test("the fixture service marks everything it invents as simulated", async () => {
  const service = new FixtureEndpointService();
  expect(service.simulated).toBe(true);
  const rows = await service.history(
    {
      key: "scripting:openai",
      id: "openai",
      kind: "scripting",
      name: "OpenAI",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      concurrency: 4,
      inPrice: 0.15,
      outPrice: 0.6,
    },
    "24h",
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.simulated)).toBe(true);
  expect(rows.every((r) => r.queuedAt >= Date.now() - 25 * 3600e3)).toBe(true);
});

test("a connection test reports its own cost, and unknown when there is no rate", async () => {
  const service = new FixtureEndpointService();
  const priced = await service.testConnection({
    key: "tts:a",
    id: "a",
    kind: "tts",
    name: "A",
    model: "tts-1",
    baseUrl: "https://example.test/v1",
    concurrency: 1,
    billing: { unit: "chars", rate: 15 },
  });
  expect(priced.simulated).toBe(true);
  // the probe line at the endpoint's own $15 per million characters
  expect(priced.cost).toBeCloseTo((probeUnits({ unit: "chars", rate: 15 }).chars / 1e6) * 15, 12);

  const unpriced = await service.testConnection({
    key: "tts:b",
    id: "b",
    kind: "tts",
    name: "B",
    model: "tts-1",
    baseUrl: "https://example.test/v1",
    concurrency: 1,
    billing: { unit: "minute", rate: null },
  });
  expect(unpriced.cost).toBeNull();
});

test("a busy endpoint has traffic in every range, not just the oldest day", async () => {
  // regression: generating until a row cap was hit filled the far end of the week and left
  // "last hour" empty on exactly the endpoints that are busiest
  const service = new FixtureEndpointService();
  const ep = {
    key: "tts:local",
    id: "local",
    kind: "tts" as const,
    name: "Local Kokoro",
    model: "kokoro",
    baseUrl: "http://127.0.0.1:8880/v1",
    concurrency: 2,
    billing: { unit: "chars" as const, rate: 0 },
  };
  const week = await service.history(ep, "7d");
  const now = Date.now();
  for (const [label, ms] of [
    ["1h", 3600e3],
    ["24h", 24 * 3600e3],
  ] as const) {
    const inRange = week.filter((r) => (r.finishedAt ?? r.queuedAt) >= now - ms);
    expect(inRange.length, `expected requests within ${label}`).toBeGreaterThan(0);
  }
  // and the week is actually covered, not bunched at one end
  const days = new Set(week.map((r) => Math.floor((now - (r.finishedAt ?? r.queuedAt)) / 86400e3)));
  expect(days.size).toBeGreaterThanOrEqual(5);
});

test("an endpoint with no past has no invented history to show", async () => {
  const service = new FixtureEndpointService();
  const cases: [string, EndpointDescriptor][] = [
    // seeded, but nothing has ever been sent through it
    [
      "seeded and never used",
      {
        key: "scripting:antigravity",
        id: "antigravity",
        kind: "scripting",
        name: "Antigravity",
        model: "local",
        baseUrl: "http://localhost:8000/v1",
        concurrency: 4,
      },
    ],
    // added in this session: a past invented for it would be reported back as health
    [
      "added this session",
      {
        key: "tts:" + crypto.randomUUID(),
        id: "new",
        kind: "tts",
        name: "New endpoint",
        model: "",
        baseUrl: "http://localhost:8880/v1",
        concurrency: 2,
      },
    ],
  ];
  for (const [why, ep] of cases) expect(await service.history(ep, "7d"), why).toEqual([]);
});

// ---------- Fish Audio ----------

test("a Fish Audio host is recognised, and a lookalike path is not", () => {
  expect(isFishAudio({ baseUrl: "https://api.fish.audio/v1" })).toBe(true);
  expect(isFishAudio({ baseUrl: "https://fish.audio" })).toBe(true);
  expect(isFishAudio({ baseUrl: "https://api.openai.com/v1" })).toBe(false);
  expect(isFishAudio({ baseUrl: "http://127.0.0.1:8880/v1" })).toBe(false);
  // a host that merely mentions fish.audio in its path must not be treated as Fish
  expect(isFishAudio({ baseUrl: "https://evil.example/fish.audio/v1" })).toBe(false);
});

test("Fish Audio speech is /tts, everything else keeps /audio/speech", () => {
  expect(ttsRequestPath({ baseUrl: "https://api.fish.audio/v1" })).toBe("/tts");
  expect(ttsRequestPath({ baseUrl: "https://api.openai.com/v1" })).toBe("/audio/speech");
});

test("the model catalogue hangs off the host, not the versioned speech base", () => {
  const want = "https://api.fish.audio/model?self=true&page_size=100";
  expect(fishModelsUrl("https://api.fish.audio/v1")).toBe(want);
  expect(fishModelsUrl("https://api.fish.audio/v1/")).toBe(want);
  expect(fishModelsUrl("  https://api.fish.audio  ")).toBe(want);
});

test("a model list becomes voices, dropping what cannot narrate a line", () => {
  const voices = voicesFromFishModels([
    { _id: "a", title: "Narrator", type: "tts", state: "trained", tags: ["Male", "audiobook"] },
    { _id: "b", title: "Lan’er", type: "tts", state: "trained", tags: ["female"] },
    { _id: "c", title: "Steward", type: "tts", state: "trained", tags: ["dry"] },
    { _id: "d", title: "Still training", type: "tts", state: "created", tags: ["female"] },
    { _id: "e", title: "Conversion", type: "svc", state: "trained", tags: [] },
    { _id: "xyz", title: "   " },
  ]);
  expect(voices.map((v) => v.id)).toEqual(["a", "b", "c", "xyz"]);
  // the reference_id is the id a TTS request quotes, so it is what is kept
  expect(voices[0]).toEqual({ id: "a", label: "Narrator", gender: "m" });
  expect(voices[1].gender).toBe("f");
  // Fish has no gender field; an untagged voice is unknown rather than guessed
  expect(voices[2].gender).toBe("?");
  // a voice with no title is labelled by its reference_id
  expect(voices[3]).toEqual({ id: "xyz", label: "xyz", gender: "?" });
});

// ---------- the connection test and the estimate beside it agree ----------

test("a probe is priced through the same engine the rest of the page uses", async () => {
  const service = new FixtureEndpointService();
  const config: PricingConfig = {
    cachedInput: null,
    cacheWrite: null,
    timezone: "UTC",
    windows: [],
    promotions: [
      { id: "p", label: "Half price", from: null, until: null, scope: ["model"], percent: 50 },
    ],
  };
  const ep = {
    key: "tts:a",
    id: "a",
    kind: "tts" as const,
    name: "A",
    model: "tts-1",
    baseUrl: "https://example.test/v1",
    concurrency: 1,
    billing: { unit: "chars" as const, rate: 20 },
    pricing: { base: speechRates({ unit: "chars", rate: 20 }), config },
  };
  // the probe line at $20/1M, halved by the promotion in force
  const probeChars = probeUnits(ep.billing).chars;
  const estimate = probeCost(ep);
  expect(estimate).toBeCloseTo((probeChars / 1e6) * 10, 12);
  const result = await service.testConnection(ep);
  expect(result.cost).toBeCloseTo(estimate!, 12);

  // a rate nobody knows stays unknown through the discount
  const unknown = { ...ep, billing: { unit: "minute" as const, rate: null } };
  expect(
    probeCost({ ...unknown, pricing: { base: speechRates(unknown.billing), config } }),
  ).toBeNull();
});

test("a scripting probe follows the schedule too", () => {
  const base: RateSet = { input: 2, output: 8, cachedInput: null, cacheWrite: null, speech: null };
  const config: PricingConfig = {
    cachedInput: null,
    cacheWrite: null,
    timezone: "UTC",
    windows: [{ id: "n", label: "Off-peak", days: [], from: 0, to: 1439, percent: 50 }],
    promotions: [],
  };
  const full = probeCost({
    key: "scripting:x",
    id: "x",
    kind: "scripting",
    name: "X",
    model: "m",
    baseUrl: "https://example.test/v1",
    concurrency: 1,
    pricing: { base, config: { ...config, windows: [] } },
  })!;
  const discounted = probeCost({
    key: "scripting:x",
    id: "x",
    kind: "scripting",
    name: "X",
    model: "m",
    baseUrl: "https://example.test/v1",
    concurrency: 1,
    pricing: { base, config },
  })!;
  expect(full).toBeCloseTo((24 * 2 + 8 * 8) / 1e6, 15);
  expect(discounted).toBeCloseTo(full / 2, 15);
});

test("the invented week is invented once and not re-priced on the next look", async () => {
  const service = new FixtureEndpointService();
  const ep = {
    key: "scripting:openai",
    id: "openai",
    kind: "scripting" as const,
    name: "OpenAI",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    concurrency: 4,
    inPrice: 0.15,
    outPrice: 0.6,
    pricing: {
      base: {
        input: 0.15,
        output: 0.6,
        cachedInput: null,
        cacheWrite: null,
        speech: null,
      } as RateSet,
      config: {
        cachedInput: null,
        cacheWrite: null,
        timezone: "UTC",
        windows: [],
        promotions: [],
      } as PricingConfig,
    },
  };
  const first = await service.history(ep, "7d");
  expect(first.length).toBeGreaterThan(0);
  const before = first.map((r) => `${r.id}:${r.cost}`).join("|");

  // the rate card is doubled, and the page is looked at again well over a minute later
  ep.pricing.base = { ...ep.pricing.base, input: 999, output: 999 };
  const again = await service.history(ep, "7d");
  expect(again.map((r) => `${r.id}:${r.cost}`).join("|")).toBe(before);

  // only an explicit reset — a demo reset, a scenario replacing the world — drops it
  service.reset();
  const after = await service.history(ep, "7d");
  expect(after.map((r) => `${r.id}:${r.cost}`).join("|")).not.toBe(before);
});

test("a cache percentage divides by the input of the requests that reported one", () => {
  const rows: RequestRecord[] = [
    // reported: 4,000 of 10,000 cached
    record({ usage: { inputTokens: 10_000, outputTokens: 0, cachedInput: 4000 } }),
    // said nothing at all: its 90,000 input tokens are not evidence of a miss
    record({ usage: { inputTokens: 90_000, outputTokens: 0 } }),
  ];
  const totals = seriesFrom(rows, "scripting", "1h", NOW).totals;
  expect(totals.inputTokens).toBe(100_000);
  expect(totals.cacheReported).toBe(1);
  expect(totals.cachedInputTokens).toBe(4000);
  // 40% of what was reported on, not 4% of everything that went out
  expect(totals.cacheReportedInputTokens).toBe(10_000);
  expect(Math.round((totals.cachedInputTokens / totals.cacheReportedInputTokens) * 100)).toBe(40);
});
