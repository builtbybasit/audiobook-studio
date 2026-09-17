// The queue. One job per chapter of work, whatever kind it is; `scriptRun` and `exportRun` carry
// the live detail the Queue page opens up, and everything a retry needs to run it again.
import type { ExportSettings } from "@/types/export";
import type { Profile } from "@/types/scripting";

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
    requests: number;
    completed: number;
    active: number;
    reserved: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
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
