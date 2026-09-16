// TTS and scripting endpoints: how they are configured, what they bill, and the request telemetry
// the Endpoints page draws from.
//
// The app talks to two kinds of OpenAI-compatible server: a chat model that turns prose into an
// attributed script, and a speech model that renders a line. They are configured, paused, rate
// limited and billed the same way, so the Endpoints page treats them as one list of two kinds.
import type { SplitMode } from "@/types/common";
import type { Voice } from "@/types/voice";
import type { ExpressionConfig } from "@/types/expression";
import type { Profile, ScriptSettings } from "@/types/scripting";

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

/** How a TTS provider bills. Not every provider bills per character. */
export type TtsBillingUnit = "chars" | "tokens" | "minute" | "request";

export interface TtsBilling {
  unit: TtsBillingUnit;
  /** USD per 1M chars / per 1M tokens / per audio minute / per request. `null` = not known — and
   *  an unknown rate is never rendered as $0. */
  rate: number | null;
}

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

export interface RequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  chars?: number;
  /** rendered audio, seconds */
  audioSeconds?: number;
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
  costBasis: "recorded" | "estimated" | "unknown";
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
