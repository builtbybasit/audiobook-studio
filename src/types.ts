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

/** An LLM provider used for scripting (splitting prose into attributed segments). */
export interface Profile {
  id: string;
  name: string;
  model: string;
  /** USD per million input tokens */
  inPrice: number;
  /** USD per million output tokens */
  outPrice: number;
  secPerChunk: number;
  needsKey: boolean;
}

export interface ScriptSettings {
  profile: string;
  chunkChars: number;
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
