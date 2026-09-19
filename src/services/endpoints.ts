// The seam where a backend would go.
//
// Everything the Endpoints page knows about *past* requests — the charts, the totals, the activity
// list, the connection test — comes through `EndpointService`. This file ships one implementation,
// `FixtureEndpointService`, which invents a plausible week of traffic from a seeded generator and
// answers the connection test without touching the network. Swapping in an HTTP implementation is
// a one-line change at the bottom of this file.
//
// Everything it returns is marked `simulated: true`, and the page says so wherever it is shown.
// No request in here reaches a provider, and nothing is charged.
import type {
  BillableUnits,
  ConnectionTest,
  CostBasis,
  EndpointKind,
  MetricBucket,
  MetricSeries,
  MetricTotals,
  PricingConfig,
  RangeKey,
  RateSet,
  RequestRecord,
  RequestStatus,
  RequestUsage,
  TtsBilling,
  UsageFormat,
} from "@/types";

import { onDemoReset } from "@/lib/pageState";
import {
  AUDIO_CHARS_PER_SECOND,
  billableChars,
  measureSpeech,
  normalizeUsage,
  noUnits,
  priceRequest,
  priceSpeechRequest,
  PRICING_RULE,
  ttsCost,
} from "@/lib/pricing";
import {
  cacheShapeFor,
  reportedChargeFor,
  reportsOwnCost,
  simulateSpeechUsage,
  simulateUsage,
  speechUsageFormatFor,
} from "@/mock/simulators/usage";

/**
 * A sample line of the right size for one invented request, in the endpoint's own script.
 *
 * The byte-billed endpoints get non-ASCII text, because that is the whole point of byte billing: a
 * week of Fish Audio history whose bytes equalled its characters would demonstrate nothing, and the
 * Activity list is where the difference is meant to be visible.
 */
const SAMPLE_ASCII = "The quick brown fox jumps over the lazy dog. ";
const SAMPLE_CJK = "他抬起头，望向远处的山峦，轻声说道：“时候到了。” ";

function sampleText(ep: EndpointDescriptor, chars: number): string {
  const unit = ep.billing?.unit;
  const seed = unit === "bytes" ? SAMPLE_CJK : SAMPLE_ASCII;
  return seed.repeat(Math.max(1, Math.ceil(chars / [...seed].length))).slice(0, chars);
}

/** What one invented speech request submitted, counted the way its endpoint bills. */
function measuredUnits(
  ep: EndpointDescriptor,
  chars: number,
  status: RequestStatus,
): BillableUnits {
  const text = sampleText(ep, chars);
  return measureSpeech(
    {
      text,
      requests: ep.maxChars ? Math.max(1, Math.ceil(chars / ep.maxChars)) : 1,
      audioSeconds: status === "done" ? billableChars(text) / AUDIO_CHARS_PER_SECOND : 0,
    },
    ep.billing ?? { unit: "chars", rate: null },
  );
}

/** The same thing as the row's `usage`: every quantity counted, none of them conversions. */
function speechUnits(ep: EndpointDescriptor, chars: number, status: RequestStatus): RequestUsage {
  const u = measuredUnits(ep, chars, status);
  return {
    chars: u.chars,
    bytes: u.bytes,
    ...(u.textTokens != null ? { textTokens: u.textTokens } : {}),
    audioSeconds: u.audioSeconds,
    ...(u.audioTokens != null ? { audioTokens: u.audioTokens } : {}),
  };
}

/** What the service needs to know about an endpoint. A real backend would use `key` alone; the
 *  fixture implementation also prices its rows from the rates configured on the page. */
export interface EndpointDescriptor {
  key: string;
  id: string;
  kind: EndpointKind;
  name: string;
  model: string;
  baseUrl: string;
  concurrency: number;
  /** scripting: USD per 1M tokens */
  inPrice?: number;
  outPrice?: number;
  /**
   * scripting: the full rate card — base rates, cached-input and cache-write rates, the
   * peak/off-peak schedule and the promotions. A real backend would price server side and send the
   * receipt back; the fixture prices each invented request at the instant it finished, which is
   * what makes a week of seeded history show off-peak and promotion periods at the right prices.
   */
  pricing?: { base: RateSet; config: PricingConfig };
  /** which payload shape this provider reports usage in */
  usageFormat?: UsageFormat;
  /** tts: the rate's unit, and the per-request character cap a long line is split against —
   *  a provider that charges per call charges for every piece a split line became */
  billing?: TtsBilling;
  maxChars?: number;
  hasKey?: boolean;
}

/**
 * The one deliberate request a connection test sends.
 *
 * Both the estimate the page shows before the button is pressed and the figure the test reports
 * afterwards are priced from this, through the same engine every other request goes through — at
 * the rates in force *now*, schedule and promotions included. Pricing a probe off the base rates
 * instead told an operator sitting inside a 40% off-peak window the wrong number twice over.
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

export interface EndpointService {
  /** false only when these numbers come from somewhere real */
  readonly simulated: boolean;
  /** Drop anything cached about a world that has been replaced. A real backend has nothing to do. */
  reset?(): void;
  /** Every request this endpoint has handled inside `range`, newest first. */
  history(ep: EndpointDescriptor, range: RangeKey): Promise<RequestRecord[]>;
  /** One deliberate probe. The caller shows its scope and cost before this is called. */
  testConnection(ep: EndpointDescriptor): Promise<ConnectionTest>;
}

// ---------- ranges & bucketing ----------

export const RANGES: { value: RangeKey; label: string; ms: number; buckets: number }[] = [
  { value: "1h", label: "1 hour", ms: 3600e3, buckets: 24 },
  { value: "6h", label: "6 hours", ms: 6 * 3600e3, buckets: 36 },
  { value: "24h", label: "24 hours", ms: 24 * 3600e3, buckets: 48 },
  { value: "7d", label: "7 days", ms: 7 * 24 * 3600e3, buckets: 42 },
];

export const rangeMs = (r: RangeKey): number => RANGES.find((x) => x.value === r)!.ms;

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
    cost: 0,
    unknownCost: 0,
  }));
  const queueSamples: number[][] = buckets.map(() => []);
  const responseSamples: number[][] = buckets.map(() => []);
  const work: number[] = buckets.map(() => 0);
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
    // throughput is measured on what the endpoint produced, in the unit that kind is judged by
    work[i] +=
      kind === "scripting"
        ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
        : (u.audioSeconds ?? 0) / 60;
  }

  const minutes = width / 60000;
  buckets.forEach((b, i) => {
    const q = queueSamples[i];
    const s = responseSamples[i];
    b.queueMs = q.length ? q.reduce((a, x) => a + x, 0) / q.length : 0;
    b.responseMs = s.length ? s.reduce((a, x) => a + x, 0) / s.length : 0;
    b.p95Ms = p95(s);
    b.throughput = work[i] / minutes;
  });
  const settled = totals.eventualOk + totals.failures;
  totals.queueMs = settled ? totals.queueMs / settled : 0;
  totals.responseMs = settled ? totals.responseMs / settled : 0;
  totals.p95Ms = p95(allResponses);
  totals.throughput =
    (kind === "scripting" ? totals.inputTokens + totals.outputTokens : totals.audioSeconds / 60) /
    (spec.ms / 60000);
  return { kind, range, from, to, buckets, totals };
}

// ---------- the fixture implementation ----------

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
};
/** Park–Miller, the same generator the mock world uses. Plain multiplication on purpose:
 *  `Math.imul` wraps to a signed 32-bit int and would hand back negative "randoms". */
const rng = (seed: number): (() => number) => {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
};

/** How busy, how reliable, how slow — hand-set per seeded endpoint so the page has something with
 *  a shape to it: one quiet endpoint, one that rate limits, one that has never been touched. */
interface Behaviour {
  /** requests per hour at the busiest */
  rate: number;
  latency: number;
  spread: number;
  failRate: number;
  rateLimitRate: number;
  /** hours since the last request; Infinity = never used */
  quietFor: number;
}
const BEHAVIOUR: Record<string, Behaviour> = {
  "scripting:openai": {
    rate: 26,
    latency: 8200,
    spread: 0.5,
    failRate: 0.02,
    rateLimitRate: 0.01,
    quietFor: 0.2,
  },
  "scripting:deepseek": {
    rate: 14,
    latency: 15000,
    spread: 0.7,
    failRate: 0.05,
    rateLimitRate: 0.1,
    quietFor: 1.5,
  },
  "scripting:anthropic": {
    rate: 18,
    latency: 11000,
    spread: 0.45,
    failRate: 0.015,
    rateLimitRate: 0.02,
    quietFor: 0.6,
  },
  "scripting:antigravity": {
    rate: 0,
    latency: 24000,
    spread: 0.3,
    failRate: 0,
    rateLimitRate: 0,
    quietFor: Infinity,
  },
  "tts:openai": {
    rate: 90,
    latency: 1500,
    spread: 0.45,
    failRate: 0.015,
    rateLimitRate: 0.02,
    quietFor: 0.1,
  },
  "tts:local": {
    rate: 55,
    latency: 2700,
    spread: 0.6,
    failRate: 0.06,
    rateLimitRate: 0,
    quietFor: 0.4,
  },
  "tts:proxy": {
    rate: 6,
    latency: 2000,
    spread: 0.4,
    failRate: 0.09,
    rateLimitRate: 0.03,
    quietFor: 52,
  },
};

const BOOKS: { id: string; chapters: number }[] = [
  { id: "cliche", chapters: 28 },
  { id: "starforge", chapters: 22 },
  { id: "drowned", chapters: 18 },
];

const FAILURES: { code: number; message: string; body: string }[] = [
  {
    code: 500,
    message: "Upstream model error",
    body: '{"error":{"message":"The model produced no completion.","type":"server_error"}}',
  },
  {
    code: 502,
    message: "Bad gateway",
    body: '{"error":{"message":"Upstream connect error or disconnect/reset before headers.","type":"gateway_error"}}',
  },
  {
    code: 408,
    message: "Request timed out",
    body: '{"error":{"message":"Timed out waiting for the provider to respond.","type":"timeout"}}',
  },
  {
    code: 400,
    message: "Input too long for this model",
    body: '{"error":{"message":"This model supports at most 8192 input tokens.","type":"invalid_request_error"}}',
  },
];
const RATE_LIMIT = {
  code: 429,
  message: "Rate limited",
  body: '{"error":{"message":"Rate limit reached for requests. Retry after 4 seconds.","type":"rate_limit_error"}}',
};

export class FixtureEndpointService implements EndpointService {
  readonly simulated = true;
  /** generated once per endpoint per session, so the page doesn't rewrite history as you click */
  private cache = new Map<string, { at: number; rows: RequestRecord[] }>();

  /**
   * Forget the invented week.
   *
   * This history is priced from the rate cards the seeded world holds, so a demo reset or a
   * scenario that changes a rate card has to be able to drop it — otherwise the page would show a
   * week of traffic priced at rates the world no longer has. That is the one case where dropping a
   * recorded cost is right: these rows belong to a world that has been replaced, not to a run
   * anybody made. Nothing this session actually produced lives here.
   */
  reset(): void {
    this.cache.clear();
  }

  private generate(ep: EndpointDescriptor, now: number): RequestRecord[] {
    // An endpoint this build didn't seed was added in this session: it has no past, and inventing
    // one would be a lie the page then reports as health.
    const b = BEHAVIOUR[ep.key];
    if (!b || !Number.isFinite(b.quietFor)) return [];
    const r = rng(hash(ep.key) + 7);
    const rows: RequestRecord[] = [];
    const window = 7 * 24 * 3600e3;
    const start = now - window;
    const end = now - b.quietFor * 3600e3;
    if (end <= start) return [];
    // Traffic arrives in runs, not evenly: a book is scripted or narrated, then nothing for hours.
    // The runs are spread across the whole window rather than emitted until a row cap is hit — a
    // cap would fill the oldest day and leave "last hour" looking dead on a busy endpoint.
    const span = end - start;
    const runs = Math.max(3, Math.min(40, Math.round(span / 3600e3 / 5)));
    const perRun = Math.max(3, Math.min(24, Math.round((b.rate * span) / 3600e3 / 6 / runs)));
    let n = 0;
    for (let run = 0; run < runs; run++) {
      const book = BOOKS[Math.floor(r() * BOOKS.length)];
      const chapter = 1 + Math.floor(r() * book.chapters);
      const burst = Math.max(2, Math.round(perRun * (0.5 + r())));
      // a run's requests are spaced by how fast the endpoint clears its concurrency window
      const gapInRun = (b.latency / Math.max(1, ep.concurrency)) * (0.7 + r() * 0.8);
      // Start this run somewhere inside its own slice of the window, leaving room for the burst.
      // The last run is pinned to the end so "the last hour" reflects how recently this endpoint
      // was actually busy, rather than landing in a gap.
      const slot = run === runs - 1 ? 1 : 0.1 + r() * 0.7;
      let t = Math.min(end - burst * gapInRun, start + (span * (run + slot)) / runs);
      for (let i = 0; i < burst; i++) {
        const queuedAt = t;
        // the deeper into a run, the longer new requests wait for a slot
        const queueMs = Math.round(
          (i / Math.max(1, ep.concurrency)) * b.latency * (0.15 + r() * 0.5),
        );
        const rateLimited = r() < b.rateLimitRate;
        const failed = !rateLimited && r() < b.failRate;
        // a rate limited request is retried and usually gets through the second time
        const attempts = rateLimited ? (r() < 0.85 ? 2 : 3) : failed && r() < 0.3 ? 2 : 1;
        const responseMs = Math.round(
          b.latency * (1 - b.spread / 2 + r() * b.spread) * (rateLimited ? 1.8 : 1),
        );
        const startedAt = queuedAt + queueMs;
        const finishedAt = startedAt + responseMs;
        const status: RequestStatus = failed ? "failed" : r() < 0.01 ? "cancelled" : "done";
        const chars = 400 + Math.floor(r() * 2600);
        // A scripting request's usage comes back in the provider's own payload shape and is read
        // through the same normalizer a real client would use, so the fixture exercises the
        // "cached tokens are a slice of the input" rule rather than asserting it.
        const scripted = ep.kind === "scripting";
        const reports = (ep.usageFormat ?? "openai") !== "plain";
        // A provider that normally reports cache detail sometimes does not — a proxy strips the
        // field, an older model does not carry it. Those rows must read as "unknown", never as a
        // confident miss, so a few of them are seeded deliberately. And a smaller few come back
        // with counts that contradict each other, which is the case the arithmetic has to survive.
        const roll = r();
        const drops = reports && roll < 0.12;
        const contradicts = reports && roll >= 0.12 && roll < 0.15;
        const answer = scripted
          ? simulateUsage(
              {
                inputTokens: Math.round((chars / 4) * 1.6) + 500,
                outputTokens: status === "done" ? Math.round((chars / 4) * 1.15) : 0,
                ...cacheShapeFor(i + 1, reports),
                ...(contradicts ? { corrupt: "cache-exceeds-input" as const } : {}),
              },
              drops ? "plain" : (ep.usageFormat ?? "openai"),
            )
          : null;
        const usage = answer
          ? {
              inputTokens: answer.usage.inputTokens,
              outputTokens: answer.usage.outputTokens,
              ...(answer.usage.cachedInput != null
                ? { cachedInput: answer.usage.cachedInput }
                : {}),
              ...(answer.usage.cacheWrite ? { cacheWrite: answer.usage.cacheWrite } : {}),
            }
          : {
              ...speechUnits(ep, chars, status),
            };
        // priced at the instant it finished, from the rate card as it stood then
        const billsItself = scripted && reportsOwnCost(ep.name, ep.baseUrl);
        if (answer && billsItself && ep.pricing)
          answer.usage.reportedCost = reportedChargeFor(
            priceRequest(ep.pricing.base, ep.pricing.config, answer.usage, { at: finishedAt })
              .calculated ?? 0,
          );
        const priced =
          answer && ep.pricing
            ? priceRequest(ep.pricing.base, ep.pricing.config, answer.usage, {
                at: finishedAt,
                rule: PRICING_RULE,
                preferReported: billsItself,
              })
            : null;
        // A speech row is priced the same way and for the same reason: at the instant it landed,
        // from the schedule and promotions that were in force *then*, so a week of history shows
        // its off-peak nights and its promotion periods at the prices they were actually charged.
        const charged =
          !scripted && ep.pricing && ep.billing
            ? priceSpeechRequest(
                ep.billing,
                ep.pricing.config,
                measuredUnits(ep, chars, status),
                // The invented week carries the same mix a real one does: some providers report
                // usage for a completed request and some report nothing at all, and the receipts
                // have to read differently for the two. A failed request reported nothing either.
                {
                  at: finishedAt,
                  rule: PRICING_RULE,
                  reported:
                    status === "done"
                      ? simulateSpeechUsage(
                          { units: measuredUnits(ep, chars, status) },
                          speechUsageFormatFor(ep.model, ep.baseUrl),
                        ).usage
                      : null,
                },
              )
            : null;
        // a failed request still sent its input and is charged for it; its output count is zero,
        // so the receipt already says the right thing without a second rule here
        const cost = priced
          ? { cost: priced.total, basis: priced.basis }
          : charged
            ? { cost: charged.amount, basis: charged.basis }
            : this.priceOf(ep, usage, status);
        rows.push({
          id: `${ep.key}-${n++}`,
          endpointId: ep.id,
          kind: ep.kind,
          bookId: book.id,
          chapterId: chapter,
          label:
            ep.kind === "scripting"
              ? `Script chunk ${1 + Math.floor(r() * 6)}`
              : `Line ${1 + Math.floor(r() * 240)}`,
          status,
          attempts,
          queuedAt,
          startedAt,
          finishedAt,
          queueMs,
          responseMs,
          usage,
          cost: cost.cost,
          costBasis: cost.basis,
          ...(priced ? { priced } : {}),
          ...(charged ? { speech: charged } : {}),
          rateLimited: rateLimited || undefined,
          error: failed
            ? { ...FAILURES[Math.floor(r() * FAILURES.length)], at: finishedAt }
            : rateLimited
              ? { ...RATE_LIMIT, at: startedAt + Math.round(responseMs / 2), retryAfter: 4 }
              : undefined,
          simulated: true,
        });
        t += gapInRun;
      }
    }
    return rows.sort((a, x) => recordAt(x) - recordAt(a));
  }

  private priceOf(
    ep: EndpointDescriptor,
    usage: RequestUsage,
    status: RequestStatus,
  ): { cost: number | null; basis: CostBasis } {
    if (ep.kind === "scripting") {
      const inPrice = ep.inPrice ?? 0;
      const outPrice = ep.outPrice ?? 0;
      if (!inPrice && !outPrice) return { cost: 0, basis: "calculated" };
      return {
        cost: ((usage.inputTokens ?? 0) * inPrice + (usage.outputTokens ?? 0) * outPrice) / 1e6,
        basis: "calculated",
      };
    }
    const billing: TtsBilling = ep.billing ?? { unit: "chars", rate: null };
    // a cancelled or failed request still sent its input; per-request billing still applies, and
    // the audio-side components charge nothing because no audio came back
    const c = ttsCost(billing, {
      ...noUnits(),
      chars: usage.chars ?? 0,
      bytes: usage.bytes ?? usage.chars ?? 0,
      textTokens: usage.textTokens ?? 0,
      audioSeconds: status === "done" ? (usage.audioSeconds ?? 0) : 0,
      audioTokens: usage.audioTokens ?? null,
      requests: 1,
    });
    if (c == null) return { cost: null, basis: "unknown" };
    return { cost: c, basis: "calculated" };
  }

  async history(ep: EndpointDescriptor, range: RangeKey): Promise<RequestRecord[]> {
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
    const now = Date.now();
    const hit = this.cache.get(ep.key);
    // Generated once and then kept until `reset()`. Regenerating on a timer rewrote the past every
    // time the page was revisited — the same week of receipts re-priced against whatever the rate
    // card says now, which is the one thing a receipt is supposed to make impossible.
    const rows = hit ? hit.rows : this.generate(ep, now);
    if (!hit) this.cache.set(ep.key, { at: now, rows });
    const from = now - rangeMs(range);
    return rows.filter((r) => recordAt(r) >= from);
  }

  async testConnection(ep: EndpointDescriptor): Promise<ConnectionTest> {
    const ms = 250 + Math.round(Math.random() * 700);
    await new Promise((r) => setTimeout(r, ms));
    const units = probeUnits(ep.billing ?? { unit: "chars", rate: null });
    const probe: RequestUsage =
      ep.kind === "scripting"
        ? PROBE.scripting
        : { chars: units.chars, bytes: units.bytes, audioSeconds: units.audioSeconds };
    // priced through the shared engine at the rates in force now, schedule and promotions included
    const cost = ep.pricing ? probeCost(ep) : this.priceOf(ep, probe, "done").cost;
    const reachable = !/localhost|127\.0\.0\.1/.test(ep.baseUrl) || Math.random() > 0.35;
    if (!reachable)
      return {
        ok: false,
        at: Date.now(),
        ms,
        message: "Could not reach the endpoint",
        detail: `Nothing answered on ${ep.baseUrl}. Check the server is running and the port is right.`,
        cost: null,
        simulated: true,
      };
    return {
      ok: true,
      at: Date.now(),
      ms,
      message: `${ep.model || "model"} answered in ${ms} ms`,
      detail:
        ep.kind === "scripting"
          ? `POST ${ep.baseUrl.replace(/\/$/, "")}/chat/completions — 1 request, ${PROBE.scripting.inputTokens} input and ${PROBE.scripting.outputTokens} output tokens.`
          : `POST ${ep.baseUrl.replace(/\/$/, "")}/audio/speech — 1 request, ${units.chars} characters (${units.bytes} UTF-8 bytes) of sample text.`,
      cost,
      simulated: true,
    };
  }
}

/** Swap this for an HTTP-backed implementation when there is a backend to talk to. */
export const endpointService: EndpointService = new FixtureEndpointService();

// The invented week is priced from the seeded rate cards, so it belongs to the world that produced
// it: restoring that world drops it and the next look regenerates it against the cards now in play.
onDemoReset(() => endpointService.reset?.());
