// What the Endpoints page makes of an endpoint's past requests, and what a connection test costs.
//
// The requests themselves are the server's: every one a job sent, priced when it completed, read
// through the usage service (`useEndpointHistory`). The connection test is the server's too
// (`endpointsStore.testSaved`). What is left here is the arithmetic the page does over them — the
// ranges, the buckets the charts and the Activity list share — and the estimate shown before a test
// is run, priced through the same engine the server prices with.
import type {
  BillableUnits,
  EndpointKind,
  MetricBucket,
  MetricSeries,
  MetricTotals,
  PricingConfig,
  RangeKey,
  RateSet,
  RequestRecord,
  TtsBilling,
} from "@/types";

import {
  AUDIO_CHARS_PER_SECOND,
  billableChars,
  measureSpeech,
  normalizeUsage,
  priceRequest,
  priceSpeechRequest,
  PRICING_RULE,
} from "@/lib/pricing";

/** Which endpoint the page means, and the rates a probe of it is priced at. */
export interface EndpointDescriptor {
  /** `<kind>:<id>` */
  key: string;
  id: string;
  kind: EndpointKind;
  /** the full rate card — base rates, the peak/off-peak schedule and the promotions */
  pricing?: { base: RateSet; config: PricingConfig };
  /** tts: what the rate is per */
  billing?: TtsBilling;
}

/**
 * The one deliberate request a connection test sends, as the estimate beside the button counts it.
 *
 * It is priced through the same engine every other request goes through — at the rates in force
 * *now*, schedule and promotions included. Pricing a probe off the base rates instead told an
 * operator sitting inside a 40% off-peak window the wrong number.
 */
export const PROBE = {
  scripting: { inputTokens: 24, outputTokens: 8 },
  tts: { text: "The quick brown fox." },
} as const;

/** The probe's sample line, counted the way the endpoint's own billing model counts it. */
export const probeUnits = (billing: TtsBilling): BillableUnits =>
  measureSpeech(
    {
      text: PROBE.tts.text,
      requests: 1,
      audioSeconds: billableChars(PROBE.tts.text) / AUDIO_CHARS_PER_SECOND,
    },
    billing,
  );

/** What one probe would cost at the rates in force at `at`. `null` = this endpoint's rate is not
 *  known, which is never the same as free. */
export function probeCost(ep: EndpointDescriptor, at: number = Date.now()): number | null {
  if (!ep.pricing) return null;
  if (ep.kind === "scripting")
    return priceRequest(
      ep.pricing.base,
      ep.pricing.config,
      normalizeUsage({ ...PROBE.scripting, cachedInput: 0, cacheWrite: 0 }, "internal"),
      { at, rule: PRICING_RULE },
    ).total;
  if (!ep.billing) return null;
  return priceSpeechRequest(ep.billing, ep.pricing.config, probeUnits(ep.billing), {
    at,
    rule: PRICING_RULE,
  }).amount;
}

// ---------- ranges & bucketing ----------

export const RANGES: { value: RangeKey; label: string; ms: number; buckets: number }[] = [
  { value: "1h", label: "1 hour", ms: 3600e3, buckets: 24 },
  { value: "6h", label: "6 hours", ms: 6 * 3600e3, buckets: 36 },
  { value: "24h", label: "24 hours", ms: 24 * 3600e3, buckets: 48 },
  { value: "7d", label: "7 days", ms: 7 * 24 * 3600e3, buckets: 42 },
];

const emptyTotals = (): MetricTotals => ({
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
});

const p95 = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};

/**
 * What a request produced, in the unit its kind's throughput is judged by — tokens for scripting,
 * audio minutes for speech. `null` when the provider did not say, which is never the same as none.
 */
const producedBy = (r: RequestRecord, kind: EndpointKind): number | null => {
  const u = r.usage;
  if (kind !== "scripting") return u.audioSeconds == null ? null : u.audioSeconds / 60;
  return u.inputTokens == null && u.outputTokens == null
    ? null
    : (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
};

/** Work per minute over the requests that reported it; unknown when requests finished and none did. */
const rate = (work: number, reported: number, unreported: number, minutes: number) =>
  unreported && !reported ? null : work / minutes;

/** When a request counts towards a bucket: when it settled, or when it was queued if it hasn't. */
export const recordAt = (r: RequestRecord): number => r.finishedAt ?? r.startedAt ?? r.queuedAt;

/**
 * Fold records into evenly spaced buckets. The charts and the activity list are built from the same
 * rows, so clicking a spike can filter to exactly the requests that made it.
 */
export function seriesFrom(
  records: RequestRecord[],
  kind: EndpointKind,
  range: RangeKey,
  now: number,
): MetricSeries {
  const spec = RANGES.find((r) => r.value === range)!;
  const to = now;
  const from = now - spec.ms;
  const width = spec.ms / spec.buckets;
  const buckets: MetricBucket[] = Array.from({ length: spec.buckets }, (_, i) => ({
    from: from + i * width,
    to: from + (i + 1) * width,
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
  }));
  const queueSamples: number[][] = buckets.map(() => []);
  const responseSamples: number[][] = buckets.map(() => []);
  // what the requests that reported usage produced, and how many of them there were
  const work: number[] = buckets.map(() => 0);
  const reported: number[] = buckets.map(() => 0);
  const totals = emptyTotals();
  const allResponses: number[] = [];

  for (const r of records) {
    const t = recordAt(r);
    if (t < from || t > to) continue;
    const i = Math.min(buckets.length - 1, Math.max(0, Math.floor((t - from) / width)));
    const b = buckets[i];
    b.requests++;
    totals.requests++;
    if (r.status === "failed") {
      b.failures++;
      totals.failures++;
    }
    if (r.rateLimited) {
      b.rateLimits++;
      totals.rateLimits++;
    }
    if (r.attempts > 1) {
      b.retries++;
      totals.retries++;
    }
    if (r.status === "done") {
      b.eventualOk++;
      totals.eventualOk++;
      if (r.attempts === 1) {
        b.firstAttemptOk++;
        totals.firstAttemptOk++;
      }
    }
    if (r.cost == null) {
      b.unknownCost++;
      totals.unknownCost++;
    } else {
      b.cost += r.cost;
      totals.cost += r.cost;
    }
    if (r.status === "done" || r.status === "failed") {
      queueSamples[i].push(r.queueMs);
      responseSamples[i].push(r.responseMs);
      allResponses.push(r.responseMs);
      totals.queueMs += r.queueMs;
      totals.responseMs += r.responseMs;
    }
    if (r.costBasis === "provider-reported") totals.providerReported++;
    if (r.costBasis === "estimated") totals.estimatedCost++;
    const u = r.usage;
    totals.inputTokens += u.inputTokens ?? 0;
    totals.outputTokens += u.outputTokens ?? 0;
    // a provider that said nothing about cache use is left out of both counts rather than counted
    // as a miss — "nothing cached" and "nobody said" are different facts
    if (u.cachedInput != null) {
      totals.cachedInputTokens += u.cachedInput;
      totals.cacheReportedInputTokens += u.inputTokens ?? 0;
      totals.cacheReported++;
    }
    totals.chars += u.chars ?? 0;
    totals.audioSeconds += u.audioSeconds ?? 0;
    // throughput is measured on what the endpoint produced. A finished request whose provider
    // reported no usage is counted apart rather than as zero; one that failed without usage
    // produced nothing, and that is a known zero.
    const made = producedBy(r, kind);
    if (made != null) {
      work[i] += made;
      reported[i]++;
    } else if (r.status === "done") {
      b.unreported++;
      totals.unreported++;
    }
  }

  const minutes = width / 60000;
  buckets.forEach((b, i) => {
    const q = queueSamples[i];
    const s = responseSamples[i];
    b.queueMs = q.length ? q.reduce((a, x) => a + x, 0) / q.length : 0;
    b.responseMs = s.length ? s.reduce((a, x) => a + x, 0) / s.length : 0;
    b.p95Ms = p95(s);
    b.throughput = rate(work[i], reported[i], b.unreported, minutes);
  });
  const settled = totals.eventualOk + totals.failures;
  totals.queueMs = settled ? totals.queueMs / settled : 0;
  totals.responseMs = settled ? totals.responseMs / settled : 0;
  totals.p95Ms = p95(allResponses);
  totals.throughput = rate(
    work.reduce((a, x) => a + x, 0),
    reported.reduce((a, x) => a + x, 0),
    totals.unreported,
    spec.ms / 60000,
  );
  return { kind, range, from, to, buckets, totals };
}
