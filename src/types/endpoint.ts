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
  /**
   * Backend only, and only ever read: the server holds a key for this endpoint. The key itself
   * never comes back from the server.
   */
  hasKey?: boolean;
  /**
   * Backend only, and only ever sent: a key for the server to keep for this endpoint. Left out, a
   * save keeps the one already kept; `""` forgets it.
   */
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
  /**
   * The sample rate every line is asked for, in Hz. Absent or null means the model's own rate: the
   * request carries no rate at all and the clip records whatever the file came back at.
   */
  sampleRate?: SampleRate | null;
  /**
   * What every line is asked for and kept as. Absent or null means WAV, which every part of the
   * server reads; MP3 and Opus are a tenth of the size and need `EXPORT_ENCODER=ffmpeg` to build.
   * What an endpoint can be asked for is `speechFormats` in `lib/endpointShapes.ts`.
   */
  encoding?: AudioEncoding | null;
  /**
   * Whether a run sends this endpoint's lines in batches when its server takes them — one that
   * speaks the batch speech API (`docs/speech-batch-api.md`). Absent means yes; false sends one
   * line a request whatever the server says.
   */
  batch?: boolean;
  /**
   * An OpenAI-compatible server makes voices from samples at `POST …/audio/voices`
   * (`docs/speech-batch-api.md#voices`), so the Voices tab offers cloning. Absent means no: nothing
   * says whether such a server can until it is asked to.
   */
  makesVoices?: boolean;
}

/** A container this app can keep a clip in. */
export type AudioFormat = "wav" | "mp3" | "opus";

export interface AudioEncoding {
  format: AudioFormat;
  /**
   * MP3 in kbps, Opus in bps with -1000 meaning the encoder's own choice — each as the provider's
   * API spells it. Absent means the provider's default; WAV has none.
   */
  bitrate?: number;
}

/** The rates a speech endpoint can be asked to render at — speech-grade 16 kHz up to 48 kHz. */
export type SampleRate = 16000 | 22050 | 24000 | 32000 | 44100 | 48000;

export interface EndpointLoad {
  active: number;
  done: number;
  failed: number;
  backoff: boolean;
}

/**
 * Backend only: what the server's process has seen of one speech endpoint since it started —
 * `GET /api/endpoints/live`. Never stored; a restart starts it again from nothing.
 */
export interface EndpointLive {
  /** lines out at the endpoint right now, across every job */
  active: number;
  /** lines held for it: its concurrency is full, it is paused, or it is cooling down */
  waiting: number;
  /** requests it has refused as rate limited */
  rateLimits: number;
  /** when the cooldown after its last rate limit ends, epoch ms; in the past when there is none */
  backoffUntil: number;
  /**
   * The clips it rendered that the library plays, done and failed, across every book — counted
   * from what is stored, so unlike the rest these survive a restart. Absent for an endpoint with
   * none.
   */
  done?: number;
  failed?: number;
}

export type EndpointKind = "scripting" | "tts" | "transcription";

/**
 * A speech-to-text server: what turns audio back into words — a clone sample's transcript, and the
 * check that a rendered line says what the script says. Any server that answers OpenAI's
 * `POST /audio/transcriptions` will do; one that answers `verbose_json` with word timestamps also
 * gives the Listen page the time of every word.
 *
 * The same table as the other two kinds and the same ops, with none of a speech endpoint's voices,
 * formats or splitting: a request is one file, and is priced by the minute of audio sent.
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
  /** USD per minute of audio sent; 0 for a server that charges nothing */
  perMinute: number;
  /**
   * How hard the server favours the hinted names, sent as `hotword_lambda` beside them (Phonon-2
   * reads it, 0–100, its own default 2); absent sends none, for a server that takes no such field
   */
  hotwordLambda?: number;
  /** the schedule and promotions on that rate, as on the other kinds */
  pricing?: PricingConfig;
}

/**
 * A named credential: which provider account an endpoint uses, so several endpoints can say they
 * share one. Only a name — the server keeps one key per endpoint and never sends it back, so no
 * key is ever here. The registry travels with the endpoint configuration.
 */
export interface Credential {
  id: string;
  label: string;
  /** free-text reminder of which account this is — never the key itself */
  note: string;
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
  /** of `outputTokens`, spent reasoning before the answer; absent = not reported */
  reasoningTokens?: number;
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
  /** scripting: the reasoning level the request asked for; absent = none, left to the model */
  reasoningEffort?: ReasoningEffort;
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
  /** tokens/minute (scripting) or generated audio minutes per minute (TTS), over the requests
   *  that reported what they produced; `null` when requests finished and none of them did */
  throughput: number | null;
  /** finished requests whose provider reported no usage — left out of `throughput`, never as 0 */
  unreported: number;
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
  /** as on a bucket: `null` when requests finished and none reported usage */
  throughput: number | null;
  unreported: number;
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
}

/** The settings file written by `exportSettings` (API keys are deliberately absent). */
export interface SettingsFile {
  version: number;
  exportedAt: string;
  endpoints: Partial<Endpoint>[];
  /** an older file's `append` prompt on one is read in as that endpoint's notes (`upgradeProfilePrompt`) */
  profiles: Profile[];
  /** absent in a file from before transcription endpoints, which leaves the ones here be */
  transcribers?: Transcriber[];
  /** the library's default scripting prompt; null is the built-in one, absent (an older file) leaves it be */
  prompt?: PromptTemplate | null;
  scriptSettings: ScriptSettings;
}
