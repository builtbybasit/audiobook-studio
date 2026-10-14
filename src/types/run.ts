// A bulk run over several chapters: new work, replaced work, and what it skips and why.
// `lib/runPlan.ts` works it out; the store queues and the panels render exactly what it counted.

export type NarrationScope =
  /** lines with no usable clip (never rendered, or failed), or whose clip no longer matches */
  | "fill"
  /** only the lines whose last request failed */
  | "failed"
  /** every line, whatever state its clip is in */
  | "all";

export type RunContribution = "new" | "replace" | "retry";

/** Shown to the user as written here. */
export type RunSkipReason =
  | "excluded"
  | "running"
  | "unscripted"
  | "nothing"
  | "pending"
  | "unknown";

export interface RunChapter {
  id: number;
  title: string;
  contribution: RunContribution;
  /** 0 for scripting */
  clips: number;
  requests: number;
  /** clips replacing a usable clip, which is kept until the replacement succeeds */
  replacing: number;
  /** lines with a retake waiting for a verdict, left out of the run */
  pending: number;
}

export interface RunSkip {
  id: number;
  title: string;
  reason: RunSkipReason;
}

export interface RunPlan {
  stage: "scripting" | "narration";
  /** null for scripting, which has one scope */
  scope: NarrationScope | null;
  chapters: RunChapter[];
  skipped: RunSkip[];
  fresh: number;
  replace: number;
  retry: number;
  clips: number;
  requests: number;
  /** across the run */
  replacing: number;
  /** lines left alone because a retake is waiting on them */
  pending: number;
  /** Lines not read aloud (site text, unread notes), which no scope renders. 0 for scripting. */
  skippedLines: number;
}

/** The shorthand the picker's selection summary counts. */
export type ChapterState = "new" | "done" | "failed" | "stale" | "running" | "excluded";

/** For the line above the run button. */
export interface SelectionSummary {
  selected: number;
  counts: Record<ChapterState, number>;
  /** e.g. "8 chapters selected: 3 new, 5 already scripted" */
  text: string;
}
