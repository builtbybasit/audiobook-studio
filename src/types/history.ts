// A chapter's script versions, how each came to be, and what the history panel works out from a
// pair: the changes between them and what a restore would do. A version holds script content only;
// cast, voices, lexicon and endpoint settings are the book's and never roll back with a chapter.
import type { NarrationStatus } from "@/types/book";
import type { Segment } from "@/types/segment";
import type { PromptOrigin } from "@/types/scripting";

/** A version is labelled by the operation that produced its content. */
export type VersionOrigin =
  /** `again`: a re-script of a chapter that already had a script */
  | {
      kind: "scripted";
      profile?: string;
      model?: string;
      again?: boolean;
      /** the model's own order, kept when this many lines were put back in the book's */
      moved?: number;
      /** absent on older versions */
      prompt?: PromptOrigin;
    }
  | { kind: "edited"; edits: number }
  | { kind: "bulk"; label: string; lines: number }
  | { kind: "restored"; from: number; fromAt: number }
  /** `chapters`: how many the import applied */
  | { kind: "imported"; file?: string; chapters?: number }
  /** `was`: how the content came to be before it was named */
  | { kind: "checkpoint"; name: string; was?: VersionOrigin };

export interface ScriptVersion {
  /** 1-based, stable for the life of the chapter ("v3") */
  id: number;
  /** when this content was last changed; 0 for a script that predates the session */
  at: number;
  origin: VersionOrigin;
  /** an independent copy: nothing that happens later may reach into it */
  segments: Segment[];
}

export interface HistoryHead {
  at: number;
  origin: VersionOrigin;
  /** later edits still join this session until it goes quiet */
  open?: boolean;
}

export interface ChapterHistory {
  /** oldest first */
  versions: ScriptVersion[];
  head: HistoryHead;
  nextId: number;
}

// ---------- comparison ----------

export type ChangeField =
  | "text"
  | "speaker"
  | "direction"
  | "type"
  | "expressions"
  | "pause"
  | "effects";
export type ChangeKind = "changed" | "added" | "removed" | "split" | "joined";
/** How the panel groups changes for its filters: the fields, plus everything structural. */
export type ChangeGroup = ChangeField | "structure";

export interface FieldChange {
  field: ChangeField;
  from: string;
  to: string;
  /** what moved when both sides read the same, e.g. expressions that only moved */
  detail?: string;
}

export interface DiffRun {
  text: string;
  kind: "same" | "add" | "remove";
}

export interface LineChange {
  kind: ChangeKind;
  /** a split or join has two ids on one side */
  fromIds: number[];
  toIds: number[];
  fromText: string;
  toText: string;
  /** kept apart so a split or a join shows where the cut falls */
  fromParts: string[];
  toParts: string[];
  /** whom the line belongs to now (or belonged to, if removed) */
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
  effects: number;
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
  /** the script as it would stand, with every clip that still belongs carried across */
  segments: Segment[];
  comparison: ScriptComparison;
  /** rendered clips that still match the restored line */
  kept: number;
  /** carried across, but the restored line no longer agrees with them */
  stale: number;
  /** rendered clips whose line this version does not have; they go with it */
  dropped: number;
  /** restored lines with no clip, in a chapter that has audio */
  unrendered: number;
  /** superseded takes and pending retakes travel with their clips */
  takes: number;
  candidates: number;
  narration: NarrationStatus;
  /** null when it doesn't change */
  scripting: "done" | "fallback" | null;
  /** speakers this version uses that the book's cast no longer has */
  missingSpeakers: { name: string; lines: number }[];
}
