// What the Endpoints page reads of an endpoint's past requests, and what a connection test costs.
//
// The requests themselves are the server's: every one a job sent, priced when it completed, and
// summed there too — the charts, the totals and the percentiles come back already worked out over
// every row in the range (`~/usage/ledger`), and the Activity list comes a page at a time. What is
// left here is what both sides share — the ranges and their buckets, the shapes of a summary and a
// page, and the rule a row's time is read by — and the estimate shown before a test is run, priced
// through the same engine the server prices with. The test itself is the server's
// (`endpointsStore.testSaved`).
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
    // a transcription endpoint is tested by listing its models, which sends no audio and is free
    case "transcription":
      return 0;
  }
}

// ---------- ranges, summaries & pages ----------

/** The ranges the Endpoints page offers, and how many buckets the server folds each into. */
export const RANGES: { value: RangeKey; label: string; ms: number; buckets: number }[] = [
  { value: "1h", label: "1 hour", ms: 3600e3, buckets: 24 },
  { value: "6h", label: "6 hours", ms: 6 * 3600e3, buckets: 36 },
  { value: "24h", label: "24 hours", ms: 24 * 3600e3, buckets: 48 },
  { value: "7d", label: "7 days", ms: 7 * 24 * 3600e3, buckets: 42 },
];

/** One endpoint's past, as the server sums it over every row its ledger holds — never a page. */
export interface EndpointSummary {
  /** the range asked for, folded into the buckets the charts draw, with its totals */
  series: MetricSeries;
  /** what it has been charged since the start of the day the page asked about; `unknown` counts
   *  the requests whose cost nobody knows, which are never added in as $0 */
  today: { cost: number; unknown: number };
  /** when it last settled anything, ever; null when nothing has */
  lastSeen: number | null;
}

/**
 * Which of an endpoint's settled requests the Activity list asks for. Every filter is the server's,
 * so a count and the pages after the first say the same as the rows on screen.
 */
export interface RequestFilter {
  range: RangeKey;
  /** a clicked chart bucket, from its `from` up to (not including) its `to` */
  window?: { from: number; to: number } | null;
  status?: RequestStatus | "all";
  bookId?: string | null;
  search?: string;
}

/** One page of an endpoint's settled requests, newest first. */
export interface RequestPage {
  requests: RequestRecord[];
  /** what to ask for the page after this one with; null on the last */
  next: string | null;
  /** how many requests match the filter, over every page */
  total: number;
  /** how many requests the range holds, filtered or not */
  of: number;
}

/**
 * When a request counts as having happened: when it settled, or when it was queued if it has not.
 * The one rule every bucket, total, filter and limit reads a row's time by — the server's ledger
 * says the same in SQL (`rowAt` in `~/usage/ledger`).
 */
export const recordAt = (r: Pick<RequestRecord, "finishedAt" | "queuedAt">): number =>
  r.finishedAt ?? r.queuedAt;
