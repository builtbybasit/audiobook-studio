import { expect, test } from "bun:test";
import { newProfile } from "@/lib/scripting";
import {
  endpointErrors,
  ensureOps,
  fishModelsUrl,
  healthOf,
  isFishAudio,
  opsOf,
  pricingLabel,
  rateCardOf,
  sanitize,
  speechReadiness,
  throughputLabel,
  ttsRequestPath,
  unifiedOf,
  unifyEndpoint,
  unifyProfile,
  unifyTranscriber,
  unpriced,
  voicesFromFishModels,
} from "@/lib/endpoints";
import { OPS_DEFAULTS } from "@/lib/endpointShapes";
import { tabsFor } from "@/views/endpoints/state";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import { probeCost, probeUnits } from "@/services/endpoints";
import { maybeMoney, money, perMillionChars, speechRates } from "@/lib/pricing";
import type {
  Endpoint,
  MetricTotals,
  PricingConfig,
  RateSet,
  Transcriber,
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
  unreported: 0,
  cost: 0,
  unknownCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheReportedInputTokens: 0,
  cacheReported: 0,
  providerReported: 0,
  estimatedCost: 0,
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

test("a scripting endpoint at $0 in and out is free, not missing its rates", () => {
  const free = unifyProfile({ ...newProfile(), inPrice: 0, outPrice: 0 });
  expect(pricingLabel(free, NOW)).toBe("no charge");
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

test.each([
  ["paused, whatever else is wrong", { enabled: false, needsKey: true, voices: [] }, "paused"],
  ["a key it needs and has not got", { needsKey: true }, "nokey"],
  ["a key it needs and has", { needsKey: true, hasKey: true }, "ready"],
  ["cooling down after a 429", { backoffUntil: NOW + 4500 }, "cooldown"],
  ["a cooldown that has ended", { backoffUntil: NOW - 1 }, "ready"],
  ["no voice to render in", { voices: [] }, "novoices"],
] as const)("an endpoint %s reads as %s", (_, over, state) => {
  expect(speechReadiness(ttsEndpoint(over as Partial<Endpoint>), NOW).state).toBe(state);
});

test("a cooldown says how long it has left, and a scripting profile has none of its own", () => {
  expect(speechReadiness(ttsEndpoint({ backoffUntil: NOW + 4500 }), NOW)).toEqual({
    state: "cooldown",
    seconds: 5,
  });
  const profile = newProfile({ id: "p", name: "P", model: "m", needsKey: true });
  expect(speechReadiness(profile, NOW).state).toBe("nokey");
  expect(speechReadiness({ ...profile, hasKey: true }, NOW).state).toBe("ready");
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
  const base: RateSet = {
    input: 2,
    output: 8,
    cachedInput: null,
    cacheWrite: null,
    speech: null,
    textTokens: null,
    audioTokens: null,
  };
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

// ---------- a transcription endpoint ----------

function transcriber(over: Partial<Transcriber> = {}): Transcriber {
  return {
    id: "stt",
    name: "Whisper",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
    enabled: true,
    concurrency: 4,
    needsKey: true,
    perMinute: 0.006,
    ...over,
  };
}

test("a transcriber is its own kind, keyed apart from an endpoint with the same id", () => {
  const t = transcriber({ id: "t1" });
  const u = unifyTranscriber(t);
  expect(u).toMatchObject({ key: "transcription:t1", kind: "transcription", entry: t });
  expect([u.profile, u.endpoint, u.transcriber]).toEqual([null, null, t]);
  const keys = unifiedOf({
    profiles: [newProfile({ id: "t1" })],
    endpoints: [ttsEndpoint()],
    transcribers: [t],
  }).map((x) => x.key);
  expect(keys).toEqual(["scripting:t1", "tts:t1", "transcription:t1"]);
  expect(opsOf(u).timeoutSec).toBe(OPS_DEFAULTS.transcription.timeoutSec);
});

test("a transcriber is priced per audio minute sent, through the speech rate card", () => {
  const u = unifyTranscriber(transcriber());
  const card = rateCardOf(u);
  expect(card.unit).toBe("minute");
  expect(card.components).toEqual(["speech"]);
  expect(card.base.speech).toBe(0.006);
  expect(pricingLabel(u, NOW)).toBe("$0.006 per audio minute sent");
  expect(pricingLabel(unifyTranscriber(transcriber({ perMinute: 0 })), NOW)).toBe("no charge");
  // its one rate is always a number, zero being free, so it is never unpriced
  expect(unpriced(u)).toBe(false);
});

test("a transcriber's schedule moves its rate as a speech endpoint's does", () => {
  const t = transcriber({
    pricing: {
      cachedInput: null,
      cacheWrite: null,
      timezone: "UTC",
      windows: [],
      promotions: [
        { id: "p", label: "Half price", from: null, until: null, scope: ["speech"], percent: 50 },
      ],
    },
  });
  expect(pricingLabel(unifyTranscriber(t), NOW)).toBe("$0.003 per audio minute sent · Half price");
});

test("a transcriber is checked for its connection and its rate, not for voices", () => {
  expect(endpointErrors(unifyTranscriber(transcriber()))).toEqual([]);
  expect(
    endpointErrors(
      unifyTranscriber(
        transcriber({ baseUrl: "https://api.openai.com/v1/audio/transcriptions", perMinute: -1 }),
      ),
    ),
  ).toEqual([
    "Use the base URL without /audio/transcriptions.",
    "The rate per audio minute must be zero or more.",
  ]);
  expect(endpointErrors(unifyTranscriber(transcriber({ baseUrl: "simulated://local" })))).toEqual(
    [],
  );
});

test("a transcriber without its key is not ready, and says what that stops", () => {
  const u = unifyTranscriber(transcriber());
  expect(speechReadiness(u.entry, NOW)).toEqual({ state: "nokey" });
  expect(speechReadiness({ ...u.entry, hasKey: true }, NOW)).toEqual({ state: "ready" });
  expect(speechReadiness({ ...u.entry, enabled: false }, NOW)).toEqual({ state: "paused" });
  expect(health(u, { hasKey: false })).toMatchObject({
    state: "nokey",
    detail: "This endpoint requires a key. Recordings sent here fail until one is set.",
  });
});

test("a transcriber's throughput is the audio it heard, and testing it costs nothing", () => {
  // the figure itself is summed by the server (tests/server/usage.test.ts)
  expect(throughputLabel("transcription")).toBe("Audio minutes heard per minute");
  // the test lists the server's models, which sends no audio
  expect(probeCost({ key: "transcription:stt", id: "stt", kind: "transcription" })).toBe(0);
});

test("a transcriber's tabs are the ones every kind has, and no voices, expressions or prompt", () => {
  expect(tabsFor("transcription").map((t) => t.id)).toEqual([
    "overview",
    "connection",
    "requests",
    "pricing",
    "activity",
  ]);
  expect(tabsFor("tts").map((t) => t.id)).toContain("voices");
  expect(tabsFor("scripting").map((t) => t.id)).toContain("prompt");
});
