// The queue: one job per chapter of work. The `*Run` fields carry the live detail the Queue page
// shows and everything a retry needs.
import type { ExistingScope } from "@/types/effect";
import type { ExportSettings } from "@/types/export";
import type { NarrationScope } from "@/types/run";
import type { Profile, ResolvedPrompt } from "@/types/scripting";

export type JobKind =
  | "scripting"
  | "narration"
  | "export"
  | "transcribe"
  | "effects"
  | "facts"
  | "profiles";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobEvent {
  id: number;
  at: number;
  level: "info" | "warning" | "error";
  message: string;
  detail?: Record<string, string | number>;
}

/** What a cast job's requests have used so far. */
export interface CastUsage {
  requests: number;
  /** the cached slice included */
  inputTokens: number;
  outputTokens: number;
  cachedInput: number;
  cost: number;
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
  /** Set by "Run next": higher runs first, ties oldest first (`byRunOrder`). Absent counts as 0. */
  priority?: number;
  /** oldest first */
  activity?: JobEvent[];
  droppedEvents?: number;
  waitingReason?: string;
  /** Shared by the chapters of one press: "chapter 3 of 8", cancel all, retry the failed ones. */
  bulk?: {
    id: number;
    /** in the words the button used */
    op: string;
    index: number;
    total: number;
    /** the narration scope, or the scripting run's preservation setting */
    scope?: string;
  };
  scriptRun?: {
    profile: Profile;
    /**
     * Resolved layers with tags unfilled, plus the book's notes at queue time. Absent means the
     * built-in prompt.
     */
    prompt?: ResolvedPrompt & { notes: string };
    requests: number;
    completed: number;
    active: number;
    /** held against the budget at undiscounted rates while requests are in flight */
    reserved: number;
    cost: number;
    /** total input tokens, the cached slice included */
    inputTokens: number;
    outputTokens: number;
    /** only from requests that reported it */
    cachedInput?: number;
    /** requests that didn't report cache use, so their cost is an estimate */
    cacheUnreported?: number;
    /** the planned estimate, for reconciliation afterwards */
    estimated?: number;
  };
  /**
   * Held against the book's cap while it runs, at **undiscounted** prices (as scripting reserves),
   * so two runs that each fit can't together overshoot. The server returns each line's share once
   * it is written; the demo releases it all at the end.
   */
  narrationRun?: {
    reserved: number;
    /** for the reconciliation the queue shows afterwards */
    clips: number;
    /** `pending`: only the clips already in flight, as for a retake. Absent: see `bulk.scope`. */
    scope?: NarrationScope | "pending";
    /** at the rates in force when dispatched */
    estimated?: number;
    /**
     * Input and audio halves, where the chapter bills on returned audio. They reconcile apart:
     * input drifts only if the text changed, audio whenever lines run longer/shorter than estimated
     * or the tokeniser differs from `audioTokensPerSecond`.
     */
    estimatedInput?: number;
    estimatedAudio?: number | null;
  };
  exportRun?: {
    exportId: number;
    settings: ExportSettings;
    chapterIds: number[];
    updates: number | null;
    files: number;
    /** 1-based index of the file being written */
    file: number;
    fileName: string;
    stage: string;
    done: number;
  };
  /** One chapter's script read again for cast facts, by this scripting endpoint. */
  factsRun?: {
    profile: string;
    /** only the speakers marked major */
    major: boolean;
    /** speakers asked about */
    speakers?: number;
    /** facts saved */
    facts?: number;
    usage?: CastUsage;
  };
  /** The book's stale profiles rewritten from their facts. */
  profilesRun?: {
    profile: string;
    /** stale speakers to rewrite */
    speakers?: number;
    /** speakers rewritten */
    rewritten?: number;
    /** whose profile stayed as it was */
    failed?: string[];
    usage?: CastUsage;
  };
  /** A Re-apply's reach; absent = the whole book. */
  effectsRun?: ExistingScope;
  /** One chapter's current clips heard by a transcription endpoint. */
  transcribeRun?: {
    endpoint: string;
    /** lines with a clip to hear */
    lines: number;
    /** this run */
    transcribed: number;
    /** heard saying something other than their line */
    mismatched: number;
    /** requests that failed; the lines stay untranscribed */
    failed: number;
    /** "Transcribe again": hears every clip, including those already heard right */
    again?: true;
  };
}

export interface Eta {
  seconds: number;
  at: number;
  books: number;
}
