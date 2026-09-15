// The library: a book, the volumes it was assembled from, its chapters, its cast, and the two
// per-book settings — the pronunciation dictionary and the pacing — that change how it sounds
// without changing a word of it.
import type { Gender, VoiceRef } from "./common";

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
  /** front/back matter the user chose to skip */
  excluded?: boolean;
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
}

export interface Book {
  id: string;
  title: string;
  author: string;
  /** two-stop gradient for the generated cover */
  cover: [string, string];
  addedAt: string;
  volumes: Volume[];
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
