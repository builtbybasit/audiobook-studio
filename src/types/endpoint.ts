// TTS and scripting endpoints: how they are configured, what they bill, and the request telemetry
// the Endpoints page draws from.
//
// The app talks to two kinds of OpenAI-compatible server: a chat model that turns prose into an
// attributed script, and a speech model that renders a line. They are configured, paused, rate
// limited and billed the same way, so the Endpoints page treats them as one list of two kinds.
import type { SplitMode } from "@/types/common";
// `TtsBilling` lives with the pricing vocabulary now that a speech rate goes through the same
// schedule and promotions as a token rate; re-exported here so nothing that imports it has moved.
import type {
  CostBasis,
  PricedRequest,
  PricingConfig,
  SpeechCharge,
  TtsBilling,
} from "@/types/pricing";
import type { Voice } from "@/types/voice";
import type { ExpressionConfig } from "@/types/expression";
import type { Profile, ScriptSettings } from "@/types/scripting";

export type { TtsBilling, TtsBillingUnit } from "@/types/pricing";

/** One recorded request, for the endpoint's latency sparkline. */
export interface HistoryPoint {
  t: number;
  ms: number;
  ok: boolean;
}

export interface ReqError {
  code: number;
  message: string;
  body: string;
  /** when it happened; absent on the canned ERRORS templates */
  at?: number;
  /** which part of a split segment failed */
  part?: number;
  retryAfter?: number;
}

export interface Endpoint {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  concurrency: number;
  enabled: boolean;
  latency: number;
  failRate: number;
  /** USD per million characters */
  price: number;
  needsKey: boolean;
  /** per-request character cap; 0 = no limit */
  maxChars: number;
  splitAt: SplitMode;
  voices: Voice[];
  history: HistoryPoint[];
  failures: number;
  rateLimits: number;
  backoffUntil: number;
  lastError?: ReqError;
  /** true while "fetch voices from server" is in flight */
  fetching?: boolean;
  /** what the provider actually charges for. `price` stays the per-1M-chars figure the run
   *  estimator has always used; this says whether that figure is a conversion or the real unit. */
  billing?: TtsBilling;
  /**
   * The peak/off-peak schedule and the temporary promotions on this endpoint's rate, with the
   * timezone its windows are read in. The same shape the scripting endpoints use — a speech rate
   * goes on discount the same way a token rate does — minus the cached-input fields, which mean
   * nothing here and are never offered. Optional so an endpoint saved before it existed still
   * loads; `ensurePricing` fills the defaults in on first use.
   */
  pricing?: PricingConfig;
  // operational settings — see EndpointOps; optional so older saved endpoints still load
  timeoutSec?: number;
  maxRetries?: number;
  cooldownSec?: number;
  spendLimit?: number | null;
  credentialId?: string | null;
  quotaGroup?: string | null;
  expressions?: ExpressionConfig;
}

export interface EndpointLoad {
  active: number;
  done: number;
  failed: number;
  backoff: boolean;
}

export type EndpointKind = "scripting" | "tts";

/** Operational settings shared by both kinds. Optional on the endpoint types so anything saved
 *  before they existed still loads; `ensureOps` fills the defaults in on first use. */
export interface EndpointOps {
  /** per-request wall clock, seconds */
  timeoutSec: number;
  /** attempts *after* the first, per request */
  maxRetries: number;
  /** how long dispatch holds off after a 429 with no Retry-After, seconds */
  cooldownSec: number;
  /** USD/day for this endpoint across every book; null = no endpoint-level limit */
  spendLimit: number | null;
  /** id from the credential registry; null = this endpoint's own key slot */
  credentialId: string | null;
  /** endpoints that share one provider rate limit and spend pool */
  quotaGroup: string | null;
}

export type RequestStatus = "done" | "failed" | "running" | "queued" | "cancelled";

/** Why a queued request has not been dispatched yet. */
export type WaitReason = "paused" | "concurrency" | "cooldown" | "nokey" | "budget" | "ordered";

/**
 * What one request used. For a scripting request `inputTokens` is the **total** input — the cached
 * and cache-write parts below are slices of it, never additions — so the three never double-count.
 * `cachedInput` absent means the provider did not report it, which is not the same as zero.
 */
export interface RequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** of `inputTokens`, served from the provider's cache; absent = not reported */
  cachedInput?: number;
  /** of `inputTokens`, written into the provider's cache; absent = not reported */
  cacheWrite?: number;
  /**
   * The speech side. Four different quantities, never conversions of one another: a request is so
   * many characters *and* so many UTF-8 bytes *and* so many text tokens, and only the one its
   * endpoint bills in is charged. Absent means nobody counted it, which is not zero.
   */
  chars?: number;
  /** UTF-8 bytes of the same submitted content */
  bytes?: number;
  /** input text tokens of the same submitted content */
  textTokens?: number;
  /** rendered audio, seconds. Silence stitched in locally is not generated audio and is not here. */
  audioSeconds?: number;
  /** output audio tokens, where the endpoint bills on them */
  audioTokens?: number;
}

/** One request against one endpoint — the row behind the Activity list and every chart. */
export interface RequestRecord {
  id: string;
  endpointId: string;
  kind: EndpointKind;
  bookId: string | null;
  chapterId: number | null;
  label: string;
  status: RequestStatus;
  /** 1 = settled on the first try; >1 means it was retried */
  attempts: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** ms spent waiting on our side, before dispatch */
  queueMs: number;
  /** ms spent waiting on the provider, after dispatch */
  responseMs: number;
  waiting?: WaitReason;
  usage: RequestUsage;
  /** null when the endpoint's rate is unknown */
  cost: number | null;
  costBasis: CostBasis;
  /**
   * The receipt, frozen when the request completed: the usage as normalized, the rates in force at
   * that instant and the reasoning behind them. Editing a rate or letting a promotion expire never
   * touches one. A scripting request gets `priced` (tokens, with the cache split); a speech request
   * gets `speech` (characters, audio minutes or requests, in the unit its endpoint bills by).
   */
  priced?: PricedRequest;
  speech?: SpeechCharge;
  rateLimited?: boolean;
  error?: ReqError;
  /** false only for rows this session actually produced */
  simulated: boolean;
}

export type RangeKey = "1h" | "6h" | "24h" | "7d";

export interface MetricBucket {
  from: number;
  to: number;
  requests: number;
  failures: number;
  rateLimits: number;
  /** requests in this bucket that took more than one attempt */
  retries: number;
  firstAttemptOk: number;
  eventualOk: number;
  /** mean ms waiting for a slot */
  queueMs: number;
  /** mean ms waiting for the provider */
  responseMs: number;
  p95Ms: number;
  /** tokens/minute (scripting) or generated audio minutes per minute (TTS) */
  throughput: number;
  cost: number;
  /** requests in this bucket whose cost could not be priced */
  unknownCost: number;
}

export interface MetricTotals {
  requests: number;
  failures: number;
  rateLimits: number;
  retries: number;
  firstAttemptOk: number;
  eventualOk: number;
  queueMs: number;
  responseMs: number;
  p95Ms: number;
  throughput: number;
  cost: number;
  unknownCost: number;
  inputTokens: number;
  outputTokens: number;
  /** of `inputTokens`, reported as served from cache — only from requests that reported it */
  cachedInputTokens: number;
  /** input tokens from those same requests, so a cache percentage divides like by like. Dividing
   *  reported cached tokens by *every* request's input understates the hit rate by however much
   *  traffic said nothing about its cache use. */
  cacheReportedInputTokens: number;
  /** requests whose provider reported cache detail at all; the rest say nothing either way */
  cacheReported: number;
  /** requests priced from a charge the provider reported rather than from configured rates */
  providerReported: number;
  /** requests whose cost is an estimate because part of the usage was missing or inconsistent */
  estimatedCost: number;
  chars: number;
  audioSeconds: number;
}

export interface MetricSeries {
  kind: EndpointKind;
  range: RangeKey;
  from: number;
  to: number;
  buckets: MetricBucket[];
  totals: MetricTotals;
}

/** Result of an explicit, user-pressed connection test. */
export interface ConnectionTest {
  ok: boolean;
  at: number;
  ms: number;
  message: string;
  detail: string;
  /** what the probe would cost at the configured rates; null when the rate is unknown */
  cost: number | null;
  simulated: boolean;
}

/** The settings file written by `exportSettings` (API keys are deliberately absent). */
export interface SettingsFile {
  version: number;
  exportedAt: string;
  endpoints: Partial<Endpoint>[];
  profiles: Profile[];
  scriptSettings: ScriptSettings;
}
