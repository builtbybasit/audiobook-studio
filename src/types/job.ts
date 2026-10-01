// The queue. One job per chapter of work, whatever kind it is; `scriptRun` and `exportRun` carry
// the live detail the Queue page opens up, and everything a retry needs to run it again.
import type { ExportSettings } from "@/types/export";
import type { NarrationScope } from "@/types/run";
import type { Profile, ResolvedPrompt } from "@/types/scripting";

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
  /**
   * Moved ahead of the queue by "Run next": higher runs first, ties oldest first (`byRunOrder`).
   * Absent on a job never moved, which counts as 0.
   */
  priority?: number;
  /** What the job reported as it ran, oldest first; absent for a job that reported nothing. */
  activity?: JobEvent[];
  droppedEvents?: number;
  waitingReason?: string;
  /**
   * The bulk run this job belongs to. Several chapters asked for in one press share an id, so the
   * queue can say "chapter 3 of 8", the whole run can be cancelled at once, and a retry can pick out
   * the chapters of one run that failed.
   */
  bulk?: {
    id: number;
    /** what was asked for, in the words the button used */
    op: string;
    index: number;
    total: number;
    /** the narration scope, or the scripting run's preservation setting */
    scope?: string;
  };
  scriptRun?: {
    profile: Profile;
    /**
     * The prompt the run was queued with, its layers resolved and its tags not yet filled, and the
     * book's notes as they were then. Absent on a run queued before prompts were editable, which is
     * sent the built-in prompt.
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
    /** of `inputTokens`, reported as served from cache — only from requests that reported it */
    cachedInput?: number;
    /** requests whose provider said nothing about cache use, so their cost is an estimate */
    cacheUnreported?: number;
    /** what this run was estimated to cost when it was planned, for the reconciliation afterwards */
    estimated?: number;
  };
  /**
   * What a narration job is holding against the book's cap while it runs.
   *
   * Narration is charged per clip as each one lands, so without this two runs that each fit the
   * remaining budget on their own could start together and land past the cap between them. The
   * figure is the **undiscounted** price of everything the job queued — the same rule the scripting
   * side reserves by. The demo releases it when the job finishes rather than clip by clip, so the
   * reservation only ever errs towards holding too much back; the server gives each line's share
   * back once the line is written, because it asks the budget again before every line it sends.
   */
  narrationRun?: {
    reserved: number;
    /** clips this job put in the queue, for the reconciliation the queue shows afterwards */
    clips: number;
    /**
     * What the run renders: a scope, or `pending` — only the clips already in flight, as a retake's
     * job is. Absent on a job queued before it was kept, whose `bulk.scope` label says instead.
     */
    scope?: NarrationScope | "pending";
    /** what this chapter was estimated at when it was dispatched, at the rates in force then */
    estimated?: number;
    /**
     * The estimate's two halves, where anything in this chapter bills on the audio it returns.
     * They reconcile separately because they are wrong for different reasons: the input side only
     * if the text changed under the run, the audio side whenever a line reads longer or shorter
     * than this app's estimate — or whenever the provider's audio tokeniser is not the one
     * `audioTokensPerSecond` assumes.
     */
    estimatedInput?: number;
    estimatedAudio?: number | null;
  };
  /** Live detail of a build, and everything a retry needs to run it again. */
  exportRun?: {
    exportId: number;
    settings: ExportSettings;
    chapterIds: number[];
    /** the export this build updates, when it is an update */
    updates: number | null;
    files: number;
    /** 1-based index of the file being written */
    file: number;
    fileName: string;
    stage: string;
    /** chapters this build has to encode */
    encode: number;
    /** chapters carried over from the previous version */
    reuse: number;
    done: number;
  };
}

export interface Eta {
  seconds: number;
  at: number;
  books: number;
}
