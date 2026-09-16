// The library: a book, the volumes it was assembled from, its chapters, its cast, and the two
// per-book settings — the pronunciation dictionary and the pacing — that change how it sounds
// without changing a word of it.
import type { Gender, VoiceRef } from "@/types/common";

/** One entry of a book's pronunciation dictionary. The book text is never rewritten: the term is
 *  swapped for `say` on the way to the endpoint, so the reader still shows the author's spelling. */
export interface LexEntry {
  id: number;
  /** as it is written in the book */
  term: string;
  /** what the endpoint is sent instead — respell it the way it should sound */
  say: string;
  /** reference spelling for humans; never sent anywhere */
  ipa?: string;
  note?: string;
  /** only match this capitalisation (for a term that is also an ordinary word) */
  matchCase?: boolean;
  /** off keeps the entry in the list without applying it */
  enabled: boolean;
}

/** Default silence between clips, in seconds. Per-line overrides live on the segment. */
export interface Pacing {
  /** after a line followed by the same speaker */
  line: number;
  /** after a line when the next one is someone else */
  turn: number;
}

export type ScriptingStatus = "none" | "queued" | "running" | "done" | "failed" | "fallback";

/** What a non-story chapter turned out to be. `mixed` and `title` are the two that need a person. */
export type NoticeKind =
  | "hiatus"
  | "health"
  | "return"
  | "schedule"
  | "progress"
  | "promo"
  | "donation"
  | "duplicate"
  | "sponsor"
  | "vote"
  | "afterword"
  | "translator"
  | "mixed"
  | "title";

/**
 * A suggestion attached to a chapter when the EPUB was read: this looks like a notice rather than
 * story. It never removes anything by itself — `Chapter.excluded` is the user's decision, and a
 * chapter the user looked at and kept records that in `Chapter.kept`.
 */
export interface ChapterNote {
  /** skip: the whole chapter reads as a notice; review: story and a note together, or a title that only looks like one */
  verdict: "skip" | "review";
  kind: NoticeKind;
  /** the one line shown beside the title, e.g. “Possible hiatus announcement” */
  reason: string;
  /** what was seen in the text, for the preview */
  evidence: string[];
  /** for a chapter that mixes a note with story: where the note sits */
  at?: "start" | "end";
  /** which wording of the notice this chapter reads with, so repeats differ (prototype text only) */
  variant?: number;
}
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
  /** skipped for the audiobook: left out of every stage, kept in the book, restorable */
  excluded?: boolean;
  /** what the import saw in this chapter, when it did not look like story */
  note?: ChapterNote;
  /** the user reviewed the note and chose to keep the chapter */
  kept?: boolean;
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
  /** added in this session and not yet confirmed from the contents review */
  importing?: boolean;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  /** two-stop gradient for the generated cover */
  cover: [string, string];
  addedAt: string;
  volumes: Volume[];
  /** imported in this session and not yet added to the library */
  importing?: boolean;
  /** prototype: the import sample this book's text is read from; a seeded book reads as itself */
  sample?: string;
  /** spend ceiling and the user's pause switch; absent until either is set */
  budget?: { cap: number | null; paused: boolean };
  scriptBudget?: number | null;
  /** default gaps between clips; absent = the built-in pacing */
  pacing?: Pacing;
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

/** How a chapter stands in the contents review. */
export type ContentState = "included" | "suggested" | "review" | "kept" | "skipped";

/** The counts the contents review keeps on screen. */
export interface ContentsSummary {
  total: number;
  included: number;
  skipped: number;
  /** suggested skips the user has not decided on */
  suggested: number;
  /** chapters that need a look and have not had one */
  review: number;
  /** chapters with a note the user chose to keep */
  kept: number;
  /** notes of any kind, decided or not */
  noted: number;
}

/** Chapters with the same kind of note, so one decision can cover them all. */
export interface NoticeGroup {
  kind: NoticeKind;
  verdict: "skip" | "review";
  label: string;
  /** every chapter with this note */
  ids: number[];
  /** the ones still to decide */
  pending: number[];
  skipped: number;
  kept: number;
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
