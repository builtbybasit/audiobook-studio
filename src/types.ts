// Domain model for the prototype. The mock world in `mock/data.ts` builds these shapes and the
// store mutates them in place; nothing here is persisted or fetched.

export type Gender = "m" | "f" | "n" | "?";

/** Where a too-long segment may be cut, in fallback order. */
export type SplitMode = "sentence" | "clause" | "word" | "char";

/** `<endpointId>/<voiceId>` — a character stores this, not a bare voice id. */
export type VoiceRef = string;

export interface Voice {
  id: string;
  gender: Gender;
  label: string;
}

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
}

export type SegmentType = "dialogue" | "narration" | "thought";

export type AudioStatus = "none" | "queued" | "generating" | "done" | "failed" | "stale";

/** One piece of a segment that had to be split to fit an endpoint's limit. */
export interface Cut {
  text?: string;
  from: number;
  to: number;
  /** boundary actually used for the cut after this part; null on the last part */
  at: SplitMode | null;
  /** true when the preferred boundary didn't exist and we fell down the chain */
  fallback: boolean;
}

/** What a listener complained about after hearing a clip. */
export type FlagKind = "pronunciation" | "delivery" | "pause" | "other";

export interface SegmentFlag {
  kind: FlagKind;
  note: string;
  at: number;
}

/** A clip that was rendered and then superseded — kept so two takes can be compared. */
export interface Take {
  /** 1-based take number, stable for the life of the segment */
  n: number;
  at: number;
  ms: number;
  duration: number;
  cost?: number;
  endpoint: string | null;
  voiceRef?: VoiceRef;
  voice?: string;
  model?: string;
  direction?: string;
  style?: string;
  type?: SegmentType;
  /** the text this clip was rendered from — a later split/join/edit shows up as drift */
  text?: string;
  /** what was sent after the dictionary, when it differed */
  said?: string;
  /** the user listened to it and chose the other take */
  rejected?: boolean;
}

export interface SegmentAudio {
  status: AudioStatus;
  endpoint: string | null;
  ms: number;
  duration: number;

  // split, when the segment exceeded the endpoint's maxChars
  parts?: number;
  splitAt?: SplitMode;
  cuts?: Cut[];

  /** set when the request goes out, for the in-flight elapsed readout */
  startedAt?: number;

  // audit trail — what was actually sent, captured at render time
  voiceRef?: VoiceRef;
  voice?: string;
  model?: string;
  direction?: string;
  style?: string;
  type?: SegmentType;
  at?: number;
  cost?: number;
  /** the exact text sent, so drift can tell "the script changed" from "the delivery changed" */
  text?: string;
  /** the text after the pronunciation dictionary, when it differed from `text` */
  said?: string;
  /** how many dictionary substitutions this clip carried */
  lex?: number;

  // retakes
  /** take number of this clip; absent until the segment has been retaken at least once */
  n?: number;
  /** every superseded clip, oldest first */
  takes?: Take[];

  error?: ReqError;
}

export interface Segment {
  id: number;
  type: SegmentType;
  speaker: string;
  text: string;
  direction: string;
  audio: SegmentAudio;
  /** the LLM failed verification on this run and it was kept whole as narration */
  fallback?: boolean;
  fallbackCount?: number;
  fallbackMismatch?: string;
  /** a re-split of this fallback chunk is in flight */
  fallbackRetrying?: boolean;
  /** changed by hand; survives a re-script when "keep my edits" is on */
  edited?: boolean;
  /** the user flagged the *audio* — wrong pronunciation, bad delivery, awkward pause */
  flag?: SegmentFlag;
  /** seconds of silence stitched in after this line, overriding the book's pacing; 0 = run straight on */
  pause?: number;
  /** A retake rendering *beside* `audio`, waiting to be kept or dropped. Nothing reads it as the
   *  book's clip: the chapter plays, times and exports `audio` until the listener accepts this one. */
  candidate?: SegmentAudio;
  /** the exact whitespace that followed this segment in the source, when it isn't a single space —
   *  a hand split records it so the join that undoes it restores the paragraph break */
  sep?: string;
}

/** One entry of a book's pronunciation dictionary. The book text is never rewritten: the term is
 *  swapped for `say` on the way to the endpoint, so the reader still shows the author's spelling. */
export interface LexEntry {
  id: number;
  /** as it is written in the book */
  term: string;
  /** what the endpoint is sent instead — respell it the way it should sound */
  say: string;
  /** reference spelling for humans; never sent anywhere */
  ipa?: string;
  note?: string;
  /** only match this capitalisation (for a term that is also an ordinary word) */
  matchCase?: boolean;
  /** off keeps the entry in the list without applying it */
  enabled: boolean;
}

/** Default silence between clips, in seconds. Per-line overrides live on the segment. */
export interface Pacing {
  /** after a line followed by the same speaker */
  line: number;
  /** after a line when the next one is someone else */
  turn: number;
}

export type ScriptingStatus = "none" | "queued" | "running" | "done" | "failed" | "fallback";
export type NarrationStatus = "none" | "queued" | "running" | "done" | "failed" | "stale";

export interface Chapter {
  id: number;
  index: number;
  volumeId: number;
  volumeIndex: number;
  title: string;
  words: number;
  scripting: ScriptingStatus;
  scriptingProgress: number;
  narration: NarrationStatus;
  narrationProgress: number;
  duration: number;
  /** front/back matter the user chose to skip */
  excluded?: boolean;
  /** set while a re-script is queued, so the run knows whether to re-apply manual edits */
  rescript?: { keepEdits: boolean };
}

export interface Volume {
  id: number;
  name: string;
  file: string;
  /** chapter index range this volume covers, inclusive */
  from: number;
  to: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  /** two-stop gradient for the generated cover */
  cover: [string, string];
  addedAt: string;
  volumes: Volume[];
  /** spend ceiling and the user's pause switch; absent until either is set */
  budget?: { cap: number | null; paused: boolean };
  scriptBudget?: number | null;
  /** default gaps between clips; absent = the built-in pacing */
  pacing?: Pacing;
}

export interface Character {
  name: string;
  aliases: string[];
  gender: Gender;
  description: string;
  voice: VoiceRef | null;
  /** free-text delivery note applied to every line */
  style: string;
  color: string;
  major: boolean;
  /** first seen in a re-script, not in the original cast */
  isNew?: boolean;
  /** the user dismissed the merge suggestion for this name */
  keep?: boolean;
}

export type JobKind = "scripting" | "narration" | "export";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobEvent {
  id: number;
  at: number;
  level: "info" | "warning" | "error";
  message: string;
  detail?: Record<string, string | number>;
}

export interface Job {
  id: number;
  kind: JobKind;
  bookId: string;
  chapterId: number | null;
  label: string;
  status: JobStatus;
  progress: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  cancelled: boolean;
  /** Observed events from this session's simulator; absent for older sample jobs. */
  activity?: JobEvent[];
  droppedEvents?: number;
  waitingReason?: string;
  scriptRun?: {
    profile: Profile;
    requests: number;
    completed: number;
    active: number;
    reserved: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  };
}

export type ExportStatus = "building" | "done" | "failed" | "replaced";

export interface ExportVolume {
  number: number;
  name: string;
  of: number;
}

export interface ExportItem {
  id: number;
  bookId: string;
  filename: string;
  title: string;
  series: string;
  volume: ExportVolume | null;
  author: string;
  narrator: string;
  year: number;
  description: string;
  chapterIds: number[];
  chapters: number;
  duration: number;
  bitrate: number;
  /** MB */
  size: number;
  createdAt: string;
  version: number;
  /** id of the export this one supersedes */
  replaces: number | null;
  status: ExportStatus;
  markers?: number;
  customCover?: boolean;
  progress?: number;
}

/** Session-only observations from simulated scripting requests. */
export interface ScriptEndpointTelemetry {
  completed: number;
  failures: number;
  rateLimits: number;
  backoffUntil: number;
  lastSuccess: number;
  history: { at: number; ms: number; ok: boolean }[];
  lastError?: {
    code: number;
    message: string;
    body: string;
    at: number;
    bookId: string;
    chapterId: number;
    model: string;
    baseUrl: string;
  };
}

/** An LLM provider used for scripting (splitting prose into attributed segments). */
export interface Profile {
  id: string;
  name: string;
  model: string;
  /** USD per million input tokens */
  inPrice: number;
  /** USD per million output tokens */
  outPrice: number;
  baseUrl: string;
  enabled: boolean;
  concurrency: number;
  maxChars: number;
  splitAt: SplitMode;
  maxOutputTokens: number;
  secPerChunk: number;
  needsKey: boolean;
  // operational settings — see EndpointOps; optional so older saved profiles still load
  timeoutSec?: number;
  maxRetries?: number;
  cooldownSec?: number;
  spendLimit?: number | null;
  credentialId?: string | null;
  quotaGroup?: string | null;
}

export interface ScriptSettings {
  profile: string;
  stripWatermarks: boolean;
}

export interface ExportMeta {
  filename?: string;
  splitPerVolume?: boolean;
  title: string;
  series: string;
  author: string;
  narrator: string;
  year: number;
  description: string;
  bitrate: number;
  cover?: string | null;
  markers?: boolean;
}

/** One option row in the voice pickers. */
export interface VoiceOption {
  value: VoiceRef;
  label: string;
  group: string;
  hint: string;
  disabled: boolean;
}

/** Keyed `${bookId}:${chapterId}`. */
export type SegmentMap = Record<string, Segment[]>;

export interface World {
  books: Book[];
  chapters: Record<string, Chapter[]>;
  characters: Record<string, Character[]>;
  segments: SegmentMap;
  endpoints: Endpoint[];
  exports: ExportItem[];
  /** per book: the pronunciation dictionary, applied at render time */
  lexicon: Record<string, LexEntry[]>;
}

// ---------- derived shapes returned by the store's getters ----------

export interface ResolvedVoice {
  endpoint: Endpoint;
  voice: Voice;
}

/** Which voice actually renders a speaker, after falling back to the Narrator's. */
export interface EffectiveVoice {
  ref: VoiceRef | null;
  /** false when the speaker is borrowing the Narrator's voice */
  own: boolean;
  voice: string | null;
  label: string | null;
  endpoint: Endpoint | null;
}

export type RoutingIssueKind = "missing" | "paused" | "nokey";

export interface RoutingIssue {
  name: string;
  ref: VoiceRef;
  reason: string;
  kind: RoutingIssueKind;
  endpoint?: Endpoint;
}

export interface BookProgress {
  total: number;
  excluded: number;
  scripted: number;
  fallback: number;
  narrated: number;
  stale: number;
  exported: number;
  running: boolean;
}

export interface EndpointLoad {
  active: number;
  done: number;
  failed: number;
  backoff: boolean;
}

export interface Eta {
  seconds: number;
  at: number;
  books: number;
}

export interface CastStat {
  lines: number;
  chapters: Set<number>;
  first: number;
}

export interface MergeSuggestion {
  from: string;
  into: string;
  reason: string;
}

/** One segment whose speaker or direction moved between two script runs. */
export interface DiffChange {
  id: number;
  text: string;
  from: string;
  to: string;
}

export interface ScriptDiff {
  speaker: DiffChange[];
  direction: DiffChange[];
  added: Segment[];
  removed: Segment[];
  total: number;
  prevCount: number;
  curCount: number;
}

export interface ScriptEstimate {
  chapters: number;
  chars: number;
  chunks: number;
  seconds: number;
  cost: number;
  profile: Profile | undefined;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  blockers: string[];
}

/** Per-endpoint slice of a narration estimate. */
export interface EndpointEstimate {
  endpoint: Endpoint;
  chars: number;
  segments: number;
  requests: number;
  /** segments that exceed the endpoint's limit and become several requests */
  split: number;
}

export interface NarrationEstimate {
  chapters: number;
  chars: number;
  segments: number;
  seconds: number;
  cost: number;
  stale: number;
  unrouted: number;
  requests: number;
  split: number;
  endpoints: number;
  per: EndpointEstimate[];
}

// ---------- toasts ----------

export type ToastKind = "info" | "warn" | "warning" | "error" | "success" | "loading";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  /** makes the toast undoable (↻, Undo button, 10 s, ⌘Z) */
  undo?: (() => void) | null;
  action?: ToastAction | null;
  /** 0 sticks */
  timeout?: number;
  description?: string;
}

export interface UndoEntry {
  label: string;
  revert: () => void;
  toastId: string | null;
}

/** The settings file written by `exportSettings` (API keys are deliberately absent). */
export interface SettingsFile {
  version: number;
  exportedAt: string;
  endpoints: Partial<Endpoint>[];
  profiles: Profile[];
  scriptSettings: ScriptSettings;
}

// ---------- endpoints page: operations, billing, request telemetry ----------
// The app talks to two kinds of OpenAI-compatible server: a chat model that turns prose into an
// attributed script, and a speech model that renders a line. They are configured, paused, rate
// limited and billed the same way, so the Endpoints page treats them as one list of two kinds.

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
