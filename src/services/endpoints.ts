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
  ConnectionTest,
  EndpointKind,
  MetricBucket,
  MetricSeries,
  MetricTotals,
  RangeKey,
  RequestRecord,
  RequestStatus,
  TtsBilling,
} from "@/types";
import { AUDIO_CHARS_PER_SECOND, ttsCost } from "@/lib/endpoints";

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
  /** tts */
  billing?: TtsBilling;
  hasKey?: boolean;
}

export interface EndpointService {
  /** false only when these numbers come from somewhere real */
  readonly simulated: boolean;
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
    const u = r.usage;
    totals.inputTokens += u.inputTokens ?? 0;
    totals.outputTokens += u.outputTokens ?? 0;
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
        const usage =
          ep.kind === "scripting"
            ? {
                inputTokens: Math.round((chars / 4) * 1.6) + 500,
                outputTokens: status === "done" ? Math.round((chars / 4) * 1.15) : 0,
              }
            : {
                chars,
                audioSeconds: status === "done" ? chars / AUDIO_CHARS_PER_SECOND : 0,
              };
        const cost = this.priceOf(ep, usage, status);
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
    usage: { inputTokens?: number; outputTokens?: number; chars?: number; audioSeconds?: number },
    status: RequestStatus,
  ): { cost: number | null; basis: RequestRecord["costBasis"] } {
    if (ep.kind === "scripting") {
      const inPrice = ep.inPrice ?? 0;
      const outPrice = ep.outPrice ?? 0;
      if (!inPrice && !outPrice) return { cost: 0, basis: "recorded" };
      return {
        cost: ((usage.inputTokens ?? 0) * inPrice + (usage.outputTokens ?? 0) * outPrice) / 1e6,
        basis: "recorded",
      };
    }
    const billing = ep.billing ?? { unit: "chars" as const, rate: null };
    // a cancelled or failed request still sent its input; per-request billing still applies
    const c = ttsCost(billing, usage.chars ?? 0, usage.audioSeconds ?? 0);
    if (c == null) return { cost: null, basis: "unknown" };
    return { cost: status === "done" ? c : billing.unit === "minute" ? 0 : c, basis: "recorded" };
  }

  async history(ep: EndpointDescriptor, range: RangeKey): Promise<RequestRecord[]> {
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
    const now = Date.now();
    const hit = this.cache.get(ep.key);
    // regenerate at most once a minute, so the clock advancing doesn't invent a new past
    const rows = hit && now - hit.at < 60_000 ? hit.rows : this.generate(ep, now);
    if (!hit || now - hit.at >= 60_000) this.cache.set(ep.key, { at: now, rows });
    const from = now - rangeMs(range);
    return rows.filter((r) => recordAt(r) >= from);
  }

  async testConnection(ep: EndpointDescriptor): Promise<ConnectionTest> {
    const ms = 250 + Math.round(Math.random() * 700);
    await new Promise((r) => setTimeout(r, ms));
    const probe =
      ep.kind === "scripting"
        ? { inputTokens: 24, outputTokens: 8 }
        : { chars: 12, audioSeconds: 12 / AUDIO_CHARS_PER_SECOND };
    const { cost } = this.priceOf(ep, probe, "done");
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
          ? `POST ${ep.baseUrl.replace(/\/$/, "")}/chat/completions — 1 request, ${probe.inputTokens} input and ${probe.outputTokens} output tokens.`
          : `POST ${ep.baseUrl.replace(/\/$/, "")}/audio/speech — 1 request, ${probe.chars} characters of sample text.`,
      cost,
      simulated: true,
    };
  }
}

/** Swap this for an HTTP-backed implementation when there is a backend to talk to. */
export const endpointService: EndpointService = new FixtureEndpointService();
