import { expect, test } from "bun:test";
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
import { probeCost, probeUnits, seriesFrom } from "@/services/endpoints";
import { maybeMoney, money, perMillionChars, speechRates } from "@/lib/pricing";
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
  expect(maybeMoney(null)).toBe("unknown");
  expect(maybeMoney(0)).toBe("$0.00");
  expect(pricingLabel(unifyEndpoint(ttsEndpoint({ billing: unknown })))).toBe("rate not known");
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

// ---------- the estimate beside the connection test ----------

test("a probe is priced through the same engine the rest of the page uses", () => {
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
    billing: { unit: "chars" as const, rate: 20 },
    pricing: { base: speechRates({ unit: "chars", rate: 20 }), config },
  };
  // the probe line at $20/1M, halved by the promotion in force
  const probeChars = probeUnits(ep.billing).chars;
  const estimate = probeCost(ep);
  expect(estimate).toBeCloseTo((probeChars / 1e6) * 10, 12);

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
    pricing: { base, config: { ...config, windows: [] } },
  })!;
  const discounted = probeCost({
    key: "scripting:x",
    id: "x",
    kind: "scripting",
    pricing: { base, config },
  })!;
  expect(full).toBeCloseTo((24 * 2 + 8 * 8) / 1e6, 15);
  expect(discounted).toBeCloseTo(full / 2, 15);
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
