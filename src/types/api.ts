// What the API answers with, where the answer is more than one domain type in a wrapper.
//
// Declared once, here, for both sides: the server's operations return these and its routes reply
// with them (`satisfies`), and the page's services read them. A field the server adds or renames
// is then a type error on whichever side has not caught up, rather than an answer the page reads
// as `undefined`.
import type { Book, Chapter, Character, LexEntry } from "@/types/book";
import type { ExportItem } from "@/types/export";
import type { ChapterHistory } from "@/types/history";
import type { Job } from "@/types/job";
import type { SpeakerSamples } from "@/types/scriptFile";
import type { Segment, SegmentFlag } from "@/types/segment";
import type { FoundVoice } from "@/types/voice";

// ---------- books ----------

/** A book and its chapters: what reading, importing, updating or reordering a book answers. */
export interface ImportedBook {
  book: Book;
  chapters: Chapter[];
}

// ---------- scripts ----------

/** A chapter's script as the server holds it, and the revision a later write has to name. */
export interface ChapterScript {
  segments: Segment[];
  revision: number;
}

/** What an edit comes back with: the script, its new revision, and the history it added to. */
export interface EditedScript extends ChapterScript {
  history: ChapterHistory;
}

/** A line's flag as the server wrote it, and the revision the chapter's script is at now. */
export interface Flagged {
  flag: SegmentFlag | null;
  revision: number;
}

// ---------- the cast ----------

/** A book's cast and its pronunciation dictionary. */
export interface Cast {
  characters: Character[];
  lexicon: LexEntry[];
}

/** Lines of one chapter, named by number. */
export interface ChapterLines {
  chapterId: number;
  ids: number[];
}

/** Lines of one chapter that a change reached, and the revision its script is at now that it has. */
export interface RevisedLines extends ChapterLines {
  revision: number;
}

/**
 * Lines that changed hands when a speaker was renamed, merged or removed — by chapter, with the
 * revision each chapter's script is at now that they have — and the cast after it.
 */
export interface MovedLines {
  characters: Character[];
  moved: RevisedLines[];
}

/**
 * The dictionary as the server now holds it, and the clips the change reached: those whose
 * recorded pronunciation it no longer matches (`stale`), and those an Undo named that match it
 * again (`restored`).
 */
export interface LexiconSaved {
  entries: LexEntry[];
  stale: RevisedLines[];
  restored: RevisedLines[];
}

/** What keeping an import's voice samples did: the rows it made, and the ones it put aside. */
export interface StoredSamples {
  stored: SpeakerSamples[];
  replaced: number[];
}

// ---------- the queue ----------

/** What queueing a scripting run came to: the jobs, and the chapters it left out and why. */
export interface ScriptingQueued {
  jobs: Job[];
  skipped: { id: number; why: "excluded" | "busy" | "missing" }[];
  runId: number;
  /** the book's chapters as they now stand, with the queued ones marked */
  chapters: Chapter[];
}

/** What queueing a narration run came to: the same shape, with the reasons narration adds. */
export interface NarrationQueued {
  jobs: Job[];
  skipped: { id: number; why: "excluded" | "busy" | "missing" | "unscripted" | "nothing" }[];
  runId: number;
  chapters: Chapter[];
}

/** What asking for retakes came to: the one job, the lines in it, and the lines left out and why. */
export interface RetakesQueued {
  /** null when nothing was queued */
  job: Job | null;
  queued: number[];
  /** `unspoken`: a line the book does not read aloud — site text, or a note it skips */
  skipped: { id: number; why: "missing" | "pending" | "unspoken" }[];
  /** the book's chapters as they now stand: the one retaken reads as queued */
  chapters: Chapter[];
}

/**
 * What asking for chapters to be checked by ear came to: one job a chapter, as one run, and the
 * chapters left out and why — `unnarrated` has no clip to hear, `nothing` has only clips already
 * heard, `busy` has a narration or a check already queued.
 */
export interface CheckQueued {
  jobs: Job[];
  skipped: { id: number; why: "excluded" | "busy" | "missing" | "unnarrated" | "nothing" }[];
  runId: number;
  chapters: Chapter[];
}

/** A verdict on a retake: the line as it now stands, and the chapter whose clip changed. */
export interface Judged {
  segment: Segment;
  revision: number;
  /** the chapter as it now stands: status and duration follow the clip that plays */
  chapter: Chapter;
}

/** What starting a build came to: the job that will run it, and the audiobook it is writing. */
export interface BuildQueued {
  job: Job;
  /** the entry as the server created it — building, with its files, version and what it replaces */
  export: ExportItem;
}

// ---------- endpoints ----------

/**
 * What the server found when it sent one small real request to a saved endpoint: the Test button.
 * `ok: false` is an answer — a refused key, a wrong model — not a failed request.
 */
export interface EndpointProbe {
  ok: boolean;
  /** one sentence a person reads, e.g. "Answered in 840 ms with 2 lines" or "401: key refused" */
  message: string;
  /** how long the request took, in milliseconds; 0 when none was made */
  ms: number;
}

/**
 * How much one batch may carry, as a speech endpoint's server says (`docs/speech-batch-api.md`). A
 * null is no limit of that kind.
 */
export interface BatchLimits {
  /** lines in one request */
  maxItems: number | null;
  /** characters of text across every line of one request */
  maxInputChars: number | null;
  /** characters in one line; a longer one is sent as parts, each its own item */
  maxItemChars: number | null;
}

/** What a saved speech endpoint's server said about batches: `null` when it takes none. */
export interface EndpointBatches {
  limits: BatchLimits | null;
}

/** A page of voices the server found. Nothing is added to the endpoint until the page adds it. */
export interface VoiceListPage {
  /** a public Fish voice carries Fish's own recording of it, when it has one */
  voices: FoundVoice[];
  /** how many the provider says match, which may count some that are not voices */
  total: number;
  page: number;
  hasMore: boolean;
}
