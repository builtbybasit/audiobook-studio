// Bulk script corrections (Search): one action over many lines, previewed before anything is
// touched; the result carries the batch undo.
import type { FlagKind } from "@/types/segment";
import type { UndoEntry } from "@/types/ui";

export interface BulkSpeakerAction {
  kind: "speaker";
  speaker: string;
}

/** `set` with an empty `direction` is never "clear"; clearing is its own explicit mode. */
export interface BulkDirectionAction {
  kind: "direction";
  mode: "set" | "clear";
  direction: string;
}

/** Existing flags are kept unless `replace`. */
export interface BulkFlagAction {
  kind: "flag";
  flag: FlagKind;
  note: string;
  replace: boolean;
}

export type BulkAction = BulkSpeakerAction | BulkDirectionAction | BulkFlagAction;

export interface BulkTarget {
  chId: number;
  segId: number;
}

export type BulkSkip =
  | "same-speaker"
  | "same-direction"
  | "no-direction"
  | "already-flagged"
  | "same-flag";

export interface BulkOutcome {
  changes: boolean;
  skip: BulkSkip | null;
}

export interface BulkRow extends BulkTarget {
  speaker: string;
  color: string;
  text: string;
  before: string;
  after: string;
  changes: boolean;
  /** human reason this row is skipped; empty when it changes */
  skip: string;
  /** a rendered clip this change would invalidate */
  stale: boolean;
}

/** Computing it mutates nothing. */
export interface BulkPreview {
  /** "Change speaker to Ji Ning" */
  label: string;
  /** "Change 39 lines": the final button */
  confirm: string;
  selected: number;
  chapters: number;
  changing: number;
  skipped: number;
  /** what the skipped lines have in common, e.g. "already read by Ji Ning" */
  skipReason: string;
  stale: number;
  /** selected lines that no longer exist (re-scripted under the selection) */
  missing: number;
  rows: BulkRow[];
  /** changes when the selected lines change, so an open preview knows it is out of date */
  signature: string;
}

export interface BulkResult {
  changed: number;
  chapters: number;
  skipped: number;
  stale: number;
  label: string;
  /** shared with the toast and ⌘Z so it can only be taken once */
  entry: UndoEntry | null;
}
