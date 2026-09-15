// Bulk script corrections (Search). One correction applied to many lines at once. The action
// describes *what* to do; the preview says what it would actually change before anything is
// touched, and the result carries the batch undo.
import type { FlagKind } from "./segment";
import type { UndoEntry } from "./ui";

/** Re-attribute every selected line to one character of the book's cast. */
export interface BulkSpeakerAction {
  kind: "speaker";
  speaker: string;
}

/** Set one direction on every selected line, or remove the directions they already carry.
 *  `set` with an empty `direction` is never "clear" — clearing is its own explicit mode. */
export interface BulkDirectionAction {
  kind: "direction";
  mode: "set" | "clear";
  direction: string;
}

/** Flag the selected lines for review. Existing flags are kept unless `replace` is chosen. */
export interface BulkFlagAction {
  kind: "flag";
  flag: FlagKind;
  note: string;
  replace: boolean;
}

export type BulkAction = BulkSpeakerAction | BulkDirectionAction | BulkFlagAction;

/** One selected line, addressed the way the whole app addresses segments. */
export interface BulkTarget {
  chId: number;
  segId: number;
}

/** Why a selected line is not going to change. */
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

/** One row of the preview: what this line reads now and what it would read after. */
export interface BulkRow extends BulkTarget {
  chapter: string;
  speaker: string;
  color: string;
  text: string;
  before: string;
  after: string;
  changes: boolean;
  /** human reason this row is skipped; empty when it changes */
  skip: string;
  /** a rendered clip that this change would invalidate */
  stale: boolean;
}

/** Everything the preview panel shows. Computing it mutates nothing. */
export interface BulkPreview {
  /** "Change speaker to Ji Ning" */
  label: string;
  /** "Change 39 lines" — the final button */
  confirm: string;
  selected: number;
  chapters: number;
  changing: number;
  skipped: number;
  /** what the skipped lines have in common, e.g. "already read by Ji Ning" */
  skipReason: string;
  /** rendered clips that this change marks stale */
  stale: number;
  /** selected lines that no longer exist (the chapter was re-scripted under the selection) */
  missing: number;
  rows: BulkRow[];
  /** changes when the selected lines themselves change — an open preview goes out of date */
  signature: string;
}

export interface BulkResult {
  changed: number;
  chapters: number;
  skipped: number;
  stale: number;
  label: string;
  /** the batch's single undo, shared with the toast and ⌘Z so it can only be taken once */
  entry: UndoEntry | null;
}
