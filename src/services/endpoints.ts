// What the Endpoints page shares with the server about past requests (ranges, summary and page
// shapes, the row-time rule), plus the probe estimate priced through the server's pricing engine.
// The requests and their sums live on the server (`~/usage/ledger`).
import type {
  BillableUnits,
  EndpointKind,
  MetricSeries,
  PricingConfig,
  RangeKey,
  RateSet,
  RequestRecord,
  RequestStatus,
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
  /** base rates, schedule and promotions */
  pricing?: { base: RateSet; config: PricingConfig };
  /** tts: what the rate is per */
  billing?: TtsBilling;
  /** transcription: its one rate */
  perMinute?: number;
}

/**
 * A connection test's one request, priced at the rates in force now (schedule and promotions too).
 */
export const PROBE = {
  scripting: { inputTokens: 24, outputTokens: 8 },
  tts: { text: "The quick brown fox." },
  // server/endpoints/test-sample.wav
  transcription: { seconds: 3.39 },
} as const;

/** The probe's line, counted the way the endpoint bills. */
export const probeUnits = (billing: TtsBilling): BillableUnits =>
  measureSpeech(
    {
      text: PROBE.tts.text,
      requests: 1,
      audioSeconds: billableChars(PROBE.tts.text) / AUDIO_CHARS_PER_SECOND,
    },
    billing,
  );

/** At the rates in force at `at`. `null` = rate not known, never the same as free. */
export function probeCost(ep: EndpointDescriptor, at: number = Date.now()): number | null {
  switch (ep.kind) {
    case "scripting":
      if (!ep.pricing) return null;
      return priceRequest(
        ep.pricing.base,
        ep.pricing.config,
        normalizeUsage({ ...PROBE.scripting, cachedInput: 0, cacheWrite: 0 }, "internal"),
        { at, rule: PRICING_RULE },
      ).total;
    case "tts":
      if (!ep.pricing || !ep.billing) return null;
      return priceSpeechRequest(ep.billing, ep.pricing.config, probeUnits(ep.billing), {
        at,
        rule: PRICING_RULE,
      }).amount;
    case "transcription":
      return ep.perMinute == null ? null : (PROBE.transcription.seconds / 60) * ep.perMinute;
  }
}

// ---------- ranges, summaries & pages ----------

/** How many buckets the server folds each range into. */
export const RANGES: { value: RangeKey; label: string; ms: number; buckets: number }[] = [
  { value: "1h", label: "1 hour", ms: 3600e3, buckets: 24 },
  { value: "6h", label: "6 hours", ms: 6 * 3600e3, buckets: 36 },
  { value: "24h", label: "24 hours", ms: 24 * 3600e3, buckets: 48 },
  { value: "7d", label: "7 days", ms: 7 * 24 * 3600e3, buckets: 42 },
];

/** Summed by the server over every ledger row, never over a page. */
export interface EndpointSummary {
  /** the range asked for, folded into the buckets the charts draw, with its totals */
  series: MetricSeries;
  /**
   * since the start of the day asked about; `unknown` counts unpriced requests, never added as $0
   */
  today: { cost: number; unknown: number };
  /** null when nothing has settled */
  lastSeen: number | null;
}

/** Every filter is the server's, so counts and later pages match the rows on screen. */
export interface RequestFilter {
  range: RangeKey;
  /** a clicked chart bucket, `to` exclusive */
  window?: { from: number; to: number } | null;
  status?: RequestStatus | "all";
  bookId?: string | null;
  search?: string;
}

/** One page of an endpoint's settled requests, newest first. */
export interface RequestPage {
  requests: RequestRecord[];
  /** cursor for the next page; null on the last */
  next: string | null;
  /** matching the filter, over every page */
  total: number;
  /** in the range, unfiltered */
  of: number;
}

/** Settled time, else queued time. The ledger's SQL matches (`rowAt` in `~/usage/ledger`). */
export const recordAt = (r: Pick<RequestRecord, "finishedAt" | "queuedAt">): number =>
  r.finishedAt ?? r.queuedAt;
