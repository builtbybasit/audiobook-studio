// The library: a book, its volumes, chapters and cast, and the per-book settings (pronunciation
// dictionary, pacing) that change how it sounds without changing a word of it.
import type { Age, Gender, VoiceRef } from "@/types/common";
import type { ThoughtChoice } from "@/types/effect";
import type { BookPrompt } from "@/types/scripting";

/** The book text is never rewritten: the term is swapped for `say` on the way to the endpoint. */
export interface LexEntry {
  id: number;
  /** as it is written in the book */
  term: string;
  /** respelled the way it should sound */
  say: string;
  /** reference spelling for humans; never sent anywhere */
  ipa?: string;
  note?: string;
  /** only match this capitalisation (for a term that is also an ordinary word) */
  matchCase?: boolean;
  /** off keeps the entry in the list without applying it */
  enabled: boolean;
}

/** Seconds. Per-line overrides live on the segment; a pause with its own length keeps it. */
export interface Pacing {
  /** after a line followed by the same speaker */
  line: number;
  /** after a line when the next one is someone else */
  turn: number;
  /** a pause inside a line, `[[pause]]`, unless it has a length of its own */
  inlineShort: number;
  /** a long pause inside a line, `[[long pause]]` */
  inlineLong: number;
}

export type ScriptingStatus = "none" | "queued" | "running" | "done" | "failed" | "fallback";

/**
 * What a non-story chapter turned out to be. `mixed`, `title` and `unreadable` need a person;
 * `unreadable` is the import failing to read a listed chapter, shown in the same review.
 */
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
  | "title"
  | "empty"
  | "front"
  | "unreadable";

/** The kinds the demo has wording for: it reads no files, so nothing in it can be unreadable. */
export type DemoNoticeKind = Exclude<NoticeKind, "unreadable" | "empty" | "front">;

/**
 * An import-time suggestion that a chapter looks like a notice. It never removes anything:
 * `Chapter.excluded` is the user's decision, and `Chapter.kept` records a look-and-keep.
 */
export interface ChapterNote {
  /**
   * skip: the whole chapter is a notice, cover or empty page; review: story and a note together, or
   * a title that only looks like one
   */
  verdict: "skip" | "review";
  kind: NoticeKind;
  /** the one line shown beside the title, e.g. “Possible hiatus announcement” */
  reason: string;
  /** what was seen in the text, for the preview */
  evidence: string[];
  /** for a chapter that mixes a note with story: where the note sits */
  at?: "start" | "end";
  /** which wording of the notice this chapter reads with, so repeats differ (demo text only) */
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
  /** Line counts as the server last stored them, so a page needn't read the script. */
  lines?: LineCounts;
  /**
   * Set while a re-script is queued. `was` is the status to restore if the attempt produces
   * nothing; `token` is the job allowed to write the result, so a late callback can't overwrite a
   * newer run or a restore.
   */
  rescript?: { was?: ScriptingStatus; token?: number };
}

/**
 * Counts the lines the book reads aloud (`isSpoken` in `@/lib/siteText`); the rest are `skipped`.
 */
export interface LineCounts {
  total: number;
  done: number;
  generating: number;
  failed: number;
  /** lines that are not read aloud — site text, and notes unless the book reads them */
  skipped: number;
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

/**
 * Where a volume begins. A book's volumes are a list of these in reading order, the first at the
 * first chapter; writing the list cuts, joins or moves volumes.
 */
export interface VolumeStart {
  /** chapter number */
  chapter: number;
  name: string;
}

/** Stored chapter counts, so the shelf can show progress before a book's chapters are read. */
export interface ChapterCounts {
  total: number;
  /** not skipped for the audiobook */
  included: number;
  scripted: number;
  narrated: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  /** two-stop gradient for the generated cover */
  cover: [string, string];
  /**
   * Where the server serves the EPUB's cover (`/api/books/:id/covers/…`, or under `/demo/api`).
   * Absent when the book had none; the gradient stands in.
   */
  coverImage?: string;
  addedAt: string;
  volumes: Volume[];
  /** present on a book the server listed */
  chapters?: ChapterCounts;
  /** imported in this session and not yet added to the library */
  importing?: boolean;
  /** demo: the import sample this book's text is read from; a seeded book reads as itself */
  sample?: string;
  /** absent until either is set */
  budget?: { cap: number | null; paused: boolean };
  scriptBudget?: number | null;
  /** default gaps between clips; absent = the built-in pacing */
  pacing?: Pacing;
  /** notes for the scripter, and a prompt of its own it may switch on; absent = neither */
  prompt?: BookPrompt;
  /** read translator's and author's notes (`note` lines) aloud; absent = skip them */
  readNotes?: boolean;
  /**
   * After narration a `check` job hears each chapter on the first enabled transcriber.
   * Absent = only on request.
   */
  checkByEar?: boolean;
  /** the scripting model does not suggest dictionary terms; absent = it does */
  pronounceOff?: boolean;
  /** Effect for `thought` lines: an id or "none". Absent = the library's (`src/lib/effects.ts`). */
  thoughts?: ThoughtChoice;
  /** the voice a speaker with none of their own is read in; absent = the Narrator's */
  characterVoice?: CharacterVoice;
}

/**
 * The voice for speakers with none of their own, before the Narrator's: one voice, or one per
 * gender (neutral and unknown share `other`). Both shapes are kept so switching loses nothing; an
 * empty slot falls through to the Narrator.
 */
export interface CharacterVoice {
  by: "one" | "gender";
  one: VoiceRef | null;
  male: VoiceRef | null;
  female: VoiceRef | null;
  other: VoiceRef | null;
}

export interface Character {
  name: string;
  aliases: string[];
  gender: Gender;
  /** absent = unknown */
  age?: Age;
  description: string;
  voice: VoiceRef | null;
  /** free-text delivery note applied to every line */
  style: string;
  /** pace of every line, 1 = the voice's own pace; absent = their voice's `speed` (`speakerSpeed`) */
  speed?: number;
  color: string;
  major: boolean;
  /** first seen in a re-script, not in the original cast */
  isNew?: boolean;
  /** the user dismissed the merge suggestion for this name */
  keep?: boolean;
  /** the voice effect on all of their lines, by id; absent = none */
  effect?: string;
  /** their thought lines' effect: an effect's id or "none"; absent = the book's */
  thoughts?: ThoughtChoice;
  /**
   * The character this speaker is a disguise of, by name. A persona gets that character's effect,
   * then its own, in its own voice if picked and theirs otherwise. A name not in the cast (or its
   * own) links nobody.
   */
  personaOf?: string;
  /**
   * The scripting model found this speaker to be a disguise: unlinked, the wearer is still unknown;
   * linked, the link is the model's and shown behind a spoiler. Linking by hand clears it, so a
   * model's note never undoes a person's choice.
   */
  masked?: boolean;
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
  /** of `lines`, the thought lines: what the book's thought effect reaches */
  thoughts: number;
  chapters: Set<number>;
  first: number;
}

export interface MergeSuggestion {
  from: string;
  into: string;
  reason: string;
}
