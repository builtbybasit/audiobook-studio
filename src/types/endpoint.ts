// Scripting, TTS and transcription endpoints: config, billing and the request telemetry the
// Endpoints page draws from. All kinds are configured, paused, rate limited and billed alike.
import type { SplitMode } from "@/types/common";
import type {
  CostBasis,
  PricedRequest,
  PricingConfig,
  SpeechCharge,
  TtsBilling,
} from "@/types/pricing";
import type { Voice } from "@/types/voice";
import type { ExpressionConfig } from "@/types/expression";
import type { Profile, PromptTemplate, ReasoningEffort, ScriptSettings } from "@/types/scripting";

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
  /** absent on the canned ERRORS templates */
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
  /** Read only: the server holds a key for this endpoint. The key itself never comes back. */
  hasKey?: boolean;
  /** Sent only: a key for the server to keep. Left out, a save keeps the key; `""` forgets it. */
  apiKey?: string;
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
  /** what the provider really bills; `price` stays the per-1M-chars figure the estimator uses */
  billing?: TtsBilling;
  /**
   * Schedule and promotions on this rate (no cached-input fields). `ensurePricing` fills defaults.
   */
  pricing?: PricingConfig;
  // operational settings — see EndpointOps
  timeoutSec?: number;
  maxRetries?: number;
  cooldownSec?: number;
  spendLimit?: number | null;
  credentialId?: string | null;
  quotaGroup?: string | null;
  expressions?: ExpressionConfig;
  /** Hz. Absent or null = the model's own: none is requested; the clip records what came back. */
  sampleRate?: SampleRate | null;
  /**
   * Absent or null means WAV, which every part of the server reads. What an endpoint can be asked
   * for is `speechFormats` in `lib/endpointShapes.ts`.
   */
  encoding?: AudioEncoding | null;
  /**
   * Send lines in batches when the server speaks the batch speech API (`docs/speech-batch-api.md`).
   * Absent means yes; false sends one line a request.
   */
  batch?: boolean;
  /**
   * The server makes voices from samples at `POST …/audio/voices`
   * (`docs/speech-batch-api.md#voices`), so the Voices tab offers cloning. Absent means no.
   */
  makesVoices?: boolean;
  /**
   * The server, for one whose base URL can't say (a local `http://127.0.0.1:<port>`). Absent, the
   * base URL decides (`speechProviderOf`).
   */
  server?: SpeechServer | null;
}

/** A server known only by being named, never by its address: Breeze-TTS-2.cpp. */
export type SpeechServer = "breezecpp";

export type AudioFormat = "wav" | "mp3" | "opus";

export interface AudioEncoding {
  format: AudioFormat;
  /**
   * MP3 in kbps, Opus in bps with -1000 meaning the encoder's own choice, as each provider's API
   * spells it. Absent means the provider's default; WAV has none.
   */
  bitrate?: number;
}

export type SampleRate = 16000 | 22050 | 24000 | 32000 | 44100 | 48000;

export interface EndpointLoad {
  active: number;
  done: number;
  failed: number;
  backoff: boolean;
}

/** `GET /api/endpoints/live`: what the server process has seen since it started. Never stored. */
export interface EndpointLive {
  /** lines out at the endpoint right now, across every job */
  active: number;
  /** lines held for it: its concurrency is full, it is paused, or it is cooling down */
  waiting: number;
  rateLimits: number;
  /** epoch ms; in the past when there is none */
  backoffUntil: number;
  /**
   * Clips the library plays, across every book. Counted from storage, so these survive a restart.
   */
  done?: number;
  failed?: number;
}

export type EndpointKind = "scripting" | "tts" | "transcription";

/**
 * A speech-to-text server (clone sample transcripts, checking a rendered line by ear). Any OpenAI
 * `POST /audio/transcriptions` server works; `verbose_json` word timestamps feed the Listen page.
 * Priced by the minute of audio sent.
 */
export interface Transcriber extends Partial<EndpointOps> {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  concurrency: number;
  needsKey: boolean;
  /** as on `Endpoint`: read only, the server holds a key */
  hasKey?: boolean;
  /** as on `Endpoint`: sent only, absent keeps the kept key and `""` forgets it */
  apiKey?: string;
  /** USD per minute of audio sent */
  perMinute: number;
  /** Sent as `hotword_lambda` with hinted names (Phonon-2: 0–100, default 2); absent sends none */
  hotwordLambda?: number;
  /**
   * Send each recording as 16 kHz mono WAV (Fermion Phonon's CUDA build takes no other). Absent
   * means yes; false sends it as rendered.
   */
  resample16k?: boolean;
  pricing?: PricingConfig;
}

/**
 * Which provider account an endpoint uses, so endpoints can share one. Only a name: the server
 * keeps one key per endpoint and never sends it back.
 */
export interface Credential {
  id: string;
  label: string;
  /** which account this is — never the key itself */
  note: string;
}

/** Operational settings shared by all kinds. `ensureOps` fills the defaults in on first use. */
export interface EndpointOps {
  /** per-request wall clock, seconds */
  timeoutSec: number;
  /** attempts *after* the first, per request */
  maxRetries: number;
  /** how long dispatch holds off after a 429 with no Retry-After, seconds */
  cooldownSec: number;
  /** USD/day for this endpoint across every book; null = no endpoint-level limit */
  spendLimit: number | null;
  /** null = this endpoint's own key slot */
  credentialId: string | null;
  /** endpoints that share one provider rate limit and spend pool */
  quotaGroup: string | null;
}

export type RequestStatus = "done" | "failed" | "running" | "queued" | "cancelled";

/** Why a queued request has not been dispatched yet. */
export type WaitReason = "paused" | "concurrency" | "cooldown" | "nokey" | "budget" | "ordered";

/**
 * `inputTokens` is the **total** input; the cached and cache-write parts are slices of it. Absent
 * means not reported, which is not zero.
 */
export interface RequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInput?: number;
  cacheWrite?: number;
  /** of `outputTokens`, spent reasoning before the answer */
  reasoningTokens?: number;
  /** Speech side: separate quantities, not conversions; only the billing unit is charged. */
  chars?: number;
  bytes?: number;
  textTokens?: number;
  /** generated audio only; silence stitched in locally is not here */
  audioSeconds?: number;
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
  /** scripting: the reasoning level asked for; absent = left to the model */
  reasoningEffort?: ReasoningEffort;
  /** null when the endpoint's rate is unknown */
  cost: number | null;
  costBasis: CostBasis;
  /**
   * The receipt, frozen at completion; later rate edits never touch it. Scripting requests get
   * `priced`, speech requests get `speech`.
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
  /** tokens/min or audio minutes/min over requests that reported output; `null` when none did */
  throughput: number | null;
  /** finished requests whose provider reported no usage — left out of `throughput`, never as 0 */
  unreported: number;
  cost: number;
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
  /** as on a bucket: `null` when requests finished and none reported usage */
  throughput: number | null;
  unreported: number;
  cost: number;
  unknownCost: number;
  inputTokens: number;
  outputTokens: number;
  /** only from requests that reported it */
  cachedInputTokens: number;
  /** input tokens from those same requests, so a cache hit rate divides like by like */
  cacheReportedInputTokens: number;
  /** requests whose provider reported cache detail at all */
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
}

/** The settings file written by `exportSettings` (API keys are deliberately absent). */
export interface SettingsFile {
  version: number;
  exportedAt: string;
  endpoints: Partial<Endpoint>[];
  /** an `append` prompt on one is read in as that endpoint's notes (`upgradeProfilePrompt`) */
  profiles: Profile[];
  /** absent leaves the current transcribers be */
  transcribers?: Transcriber[];
  /** the library's default scripting prompt; null is the built-in one, absent leaves it be */
  prompt?: PromptTemplate | null;
  scriptSettings: ScriptSettings;
}
