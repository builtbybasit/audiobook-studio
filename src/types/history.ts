// Chapter script history: the versions one chapter's script has been through, what made each one,
// and the two things the panel works out from a pair of them — what changed between them, and what
// restoring one would do.
//
// A version holds *script* content only. The cast, the voices, the pronunciation dictionary and the
// endpoint settings belong to the book and are never rolled back with a chapter; neither is the
// audio, which is carried across a restore clip by clip rather than stored twice.
import type { NarrationStatus } from "@/types/book";
import type { Segment } from "@/types/segment";

/** How one script came to be. A version is labelled by the operation that produced its content. */
export type VersionOrigin =
  /** `again` is a run over a chapter that already had a script — a re-script rather than the first */
  | { kind: "scripted"; profile?: string; model?: string; again?: boolean }
  | { kind: "edited"; edits: number }
  | { kind: "bulk"; label: string; lines: number }
  | { kind: "restored"; from: number; fromAt: number }
  /** `was` is how the content came to be before it was given a name */
  | { kind: "checkpoint"; name: string; was?: VersionOrigin };

export interface ScriptVersion {
  /** 1-based, stable for the life of the chapter — what the panel calls "v3" */
  id: number;
  /** when this content was last changed; 0 for a script that predates the session */
  at: number;
  origin: VersionOrigin;
  /** an independent copy: nothing that happens later may reach into it */
  segments: Segment[];
}

/** How the working script came to be, and whether an editing session is still collecting edits. */
export interface HistoryHead {
  at: number;
  origin: VersionOrigin;
  /** an editing session later edits still join, until it goes quiet */
  open?: boolean;
}

export interface ChapterHistory {
  /** oldest first */
  versions: ScriptVersion[];
  head: HistoryHead;
  nextId: number;
}

// ---------- comparison ----------

/** One thing about a line that two versions disagree on. */
export type ChangeField = "text" | "speaker" | "direction" | "type" | "expressions" | "pause";
/** What happened to a line between two versions. */
export type ChangeKind = "changed" | "added" | "removed" | "split" | "joined";
/** How the panel groups changes for its filters: the fields, plus everything structural. */
export type ChangeGroup = ChangeField | "structure";

export interface FieldChange {
  field: ChangeField;
  from: string;
  to: string;
  /** a word for what moved when both sides read the same, e.g. expressions that only moved */
  detail?: string;
}

/** One run of a word-level text comparison. */
export interface DiffRun {
  text: string;
  kind: "same" | "add" | "remove";
}

export interface LineChange {
  kind: ChangeKind;
  /** the line's ids on the older side and on the newer side; a split or join has two on one */
  fromIds: number[];
  toIds: number[];
  fromText: string;
  toText: string;
  /** the lines each side reads as, kept apart so a split or a join shows where the cut falls */
  fromParts: string[];
  toParts: string[];
  /** whom the line belongs to now (or belonged to, for one that is gone) */
  speaker: string;
  fields: FieldChange[];
  groups: ChangeGroup[];
  /** word-level runs for a rewritten line; empty for everything else */
  runs: DiffRun[];
  /** reading position on the newer side, so changes list in chapter order */
  at: number;
}

export interface ComparisonCounts {
  text: number;
  speaker: number;
  direction: number;
  type: number;
  expressions: number;
  pause: number;
  added: number;
  removed: number;
  split: number;
  joined: number;
}

export interface ScriptComparison {
  /** in reading order */
  changes: LineChange[];
  counts: ComparisonCounts;
  /** how many lines differ at all */
  lines: number;
  fromCount: number;
  toCount: number;
  identical: boolean;
}

// ---------- restoring ----------

/** What restoring a version would do, worked out without touching anything. */
export interface RestorePlan {
  /** the script as it would stand, with every clip that still belongs to it carried across */
  segments: Segment[];
  /** the current script compared with the one being restored */
  comparison: ScriptComparison;
  /** rendered clips that still match the restored line */
  kept: number;
  /** rendered clips carried across that the restored line no longer agrees with */
  stale: number;
  /** rendered clips whose line this version does not have; they go with it */
  dropped: number;
  /** restored lines with no clip at all, in a chapter that has audio */
  unrendered: number;
  /** superseded takes and pending retakes that travel with the clips they belong to */
  takes: number;
  candidates: number;
  /** what the chapter's narration becomes */
  narration: NarrationStatus;
  /** what the chapter's scripting status becomes, when it changes */
  scripting: "done" | "fallback" | null;
  /** speakers this version uses that the book's cast no longer has */
  missingSpeakers: { name: string; lines: number }[];
}
