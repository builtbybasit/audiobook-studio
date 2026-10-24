// API answers that wrap more than one domain type. Shared by the server (routes reply with
// `satisfies`) and the page's services, so a renamed field is a type error, not an `undefined`.
import type { Book, Chapter, Character, LexEntry } from "@/types/book";
import type { ExportItem } from "@/types/export";
import type { ChapterHistory } from "@/types/history";
import type { Job } from "@/types/job";
import type { SpeakerSamples } from "@/types/scriptFile";
import type { Segment, SegmentFlag } from "@/types/segment";
import type { FoundVoice, SpeedRange } from "@/types/voice";

// ---------- books ----------

/** A book and its chapters: what reading, importing, updating or reordering a book answers. */
export interface ImportedBook {
  book: Book;
  chapters: Chapter[];
}

export interface StartedOver extends ImportedBook {
  cleared: {
    /** chapters that had a script; each is kept in its chapter's history */
    scripts: number;
    /** clip files removed: current clips, candidates and takes */
    clips: number;
    /** speakers taken off the cast; 0 unless the cast was asked to go too */
    speakers: number;
  };
}

// ---------- scripts ----------

/** The revision is what a later write has to name. */
export interface ChapterScript {
  segments: Segment[];
  revision: number;
}

export interface EditedScript extends ChapterScript {
  history: ChapterHistory;
}

export interface Flagged {
  flag: SegmentFlag | null;
  revision: number;
}

// ---------- the cast ----------

export interface Cast {
  characters: Character[];
  lexicon: LexEntry[];
}

export interface ChapterLines {
  chapterId: number;
  ids: number[];
}

/** Lines a change reached, and the chapter's script revision after it. */
export interface RevisedLines extends ChapterLines {
  revision: number;
}

/** `stale`: clips holding a pause whose length the pacing moved. */
export interface BookUpdated extends ImportedBook {
  stale: RevisedLines[];
}

/** Lines that changed hands on a rename, and the cast after it. */
export interface MovedLines {
  characters: Character[];
  moved: RevisedLines[];
}

/**
 * The cast after a merge, removal or its Undo, and each named speaker's lines that moved; `samples`:
 * the voice-sample rows that left them, for the Undo to give back.
 */
export interface MovedSpeakers {
  characters: Character[];
  speakers: { name: string; moved: RevisedLines[]; samples?: number[] }[];
}

/**
 * `stale`: clips the new pronunciation no longer matches; `restored`: clips an Undo named that
 * match again.
 */
export interface LexiconSaved {
  entries: LexEntry[];
  stale: RevisedLines[];
  restored: RevisedLines[];
}

/** `replaced`: rows put aside for an Undo. */
export interface StoredSamples {
  stored: SpeakerSamples[];
  replaced: number[];
}

// ---------- the queue ----------

export interface ScriptingQueued {
  jobs: Job[];
  skipped: { id: number; why: "excluded" | "busy" | "missing" }[];
  runId: number;
  /** with the queued ones marked */
  chapters: Chapter[];
}

export interface NarrationQueued {
  jobs: Job[];
  skipped: { id: number; why: "excluded" | "busy" | "missing" | "unscripted" | "nothing" }[];
  runId: number;
  chapters: Chapter[];
}

/** One book's lines at a voice's old speed. */
export interface VoiceSpeedBook {
  bookId: string;
  title: string;
  /** sent at the old speed: re-narrated, at a price */
  reNarrate: number;
  /** worst-case dollars for them; null when any is unpriced */
  cost: number | null;
  /** made here at the old speed: Re-applied, free */
  reApply: number;
  /** of `reApply`, lines no Re-apply can redo */
  unavailable: number;
}

export interface VoiceSpeedLines {
  books: VoiceSpeedBook[];
  /** false when effects can't run here, so nothing is Re-applied */
  ready: boolean;
}

export interface VoiceSpeedRedone {
  /** books with something queued or refused */
  books: {
    bookId: string;
    /** narration jobs queued */
    jobs: number;
    /** with the queued ones marked, when any were */
    chapters?: Chapter[];
    reapplied: boolean;
    /** what the book refused, said as is */
    refused?: string[];
  }[];
}

export interface RetakesQueued {
  /** null when nothing was queued */
  job: Job | null;
  queued: number[];
  /** `unspoken`: site text, or a note the book skips */
  skipped: { id: number; why: "missing" | "pending" | "unspoken" }[];
  /** the retaken one reads as queued */
  chapters: Chapter[];
}

/**
 * One job a chapter, as one run. `unnarrated` has no clip to hear, `nothing` only clips already
 * heard, `busy` a narration or transcription already queued.
 */
export interface TranscribeQueued {
  jobs: Job[];
  skipped: { id: number; why: "excluded" | "busy" | "missing" | "unnarrated" | "nothing" }[];
  runId: number;
  chapters: Chapter[];
}

export interface Judged {
  segment: Segment;
  revision: number;
  /** status and duration follow the clip that plays */
  chapter: Chapter;
}

export interface BuildQueued {
  job: Job;
  /** building, with its files, version and what it replaces */
  export: ExportItem;
}

// ---------- endpoints ----------

/**
 * The Test button: one small real request. `ok: false` (a refused key, a wrong model) is an answer.
 */
export interface EndpointProbe {
  ok: boolean;
  /** e.g. "Answered in 840 ms with 2 lines" or "401: key refused" */
  message: string;
  /** 0 when no request was made */
  ms: number;
}

/** Batch limits as the server says (`docs/speech-batch-api.md`); null is no limit of that kind. */
export interface BatchLimits {
  /** lines in one request */
  maxItems: number | null;
  /** characters of text across every line of one request */
  maxInputChars: number | null;
  /** a longer line is sent as parts, each its own item */
  maxItemChars: number | null;
}

/** What a speech server's capabilities say of its model; `limits` null = no batches. */
export interface EndpointBatches {
  limits: BatchLimits | null;
  /** the speed it takes (`Endpoint.speedRange`); null = it declares none */
  speed: SpeedRange | null;
}

/** Nothing is added to the endpoint until the page adds it. */
export interface VoiceListPage {
  /** a public Fish voice carries Fish's own recording, when it has one */
  voices: FoundVoice[];
  /** as the provider counts, which may include non-voices */
  total: number;
  page: number;
  hasMore: boolean;
}
