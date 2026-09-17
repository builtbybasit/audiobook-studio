// A bulk run over several chapters: what it was asked to do, what it will actually do, and what it
// left alone.
//
// Both stages answer the same three questions before anything is queued — how much of this
// selection is work that does not exist yet, how much of it replaces work that is finished, and
// what is not in the run at all and why. `lib/runPlan.ts` works the answers out; the store queues
// exactly what the plan counted, and the panels render exactly what the plan counted.
import type { NarrationStatus, ScriptingStatus } from "@/types/book";

/** What a narration run is asked to do with the clips in the chapters it was given. */
export type NarrationScope =
  /** lines with no usable clip (never rendered, or the request failed) and lines whose clip no longer matches the script */
  | "fill"
  /** only the lines whose last request failed */
  | "failed"
  /** every line in the selected chapters, whatever state its clip is in */
  | "all";

/** What a chapter contributes to a run. */
export type RunContribution =
  /** work that does not exist yet */
  | "new"
  /** finished work this run replaces */
  | "replace"
  /** work that failed and is being tried again */
  | "retry";

/** Why a selected chapter is not in the run. Each reason is shown to the user as written here. */
export type RunSkipReason =
  | "excluded"
  | "running"
  | "unscripted"
  | "nothing"
  | "pending"
  | "unknown";

/** One chapter the run will act on. */
export interface RunChapter {
  id: number;
  title: string;
  contribution: RunContribution;
  /** clips this chapter will render (narration); 0 for scripting */
  clips: number;
  /** endpoint requests this chapter will send */
  requests: number;
  /** clips that stand in for a usable clip, which is kept until the replacement succeeds */
  replacing: number;
  /** lines with a retake waiting for a verdict, left out of the run */
  pending: number;
}

/** One chapter that was selected but is not in the run. */
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
  /** chapters producing work that did not exist */
  fresh: number;
  /** chapters whose finished work this run replaces */
  replace: number;
  /** chapters being tried again after a failure */
  retry: number;
  clips: number;
  requests: number;
  /** clips that replace a usable clip, across the run */
  replacing: number;
  /** lines left alone because a retake is waiting on them */
  pending: number;
}

/** How a chapter reads to the picker: the shorthand the selection summary counts. */
export type ChapterState = "new" | "done" | "failed" | "stale" | "running" | "excluded";

/** What the current selection contains, for the line above the run button. */
export interface SelectionSummary {
  selected: number;
  counts: Record<ChapterState, number>;
  /** the sentence the picker prints, e.g. "8 chapters selected: 3 new, 5 already scripted" */
  text: string;
}

/** The status a chapter goes back to when a replacement run leaves it as it found it. */
export interface PreservedStatus {
  scripting?: ScriptingStatus;
  narration?: NarrationStatus;
}
