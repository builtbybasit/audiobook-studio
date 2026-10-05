// One line of the script and the clip rendered from it. A segment is addressed by `${bookId}:${chId}`
// plus its own id; the store mutates these in place and nothing here is persisted.
import type { SplitMode, VoiceRef } from "@/types/common";
import type { ReqError } from "@/types/endpoint";
import type { SpeechCharge } from "@/types/pricing";
import type { ExpressionAnnotation } from "@/types/expression";

/**
 * What a line is. The first three are read aloud; the last two are words the chapter's text carries
 * that are not the story, marked rather than removed so the script still holds every word of the
 * prose (see `src/lib/siteText.ts`):
 *
 *   watermark  a site's boilerplate or anti-scraping text woven into the chapter — never read
 *   note       a translator's or author's note — read only when the book says so (`Book.readNotes`)
 */
export type SegmentType = "dialogue" | "narration" | "thought" | "watermark" | "note";

/**
 * A second opinion on whether a line is site text, from the detector beside the model rather than
 * the model itself: a line typed as story that looks like site text, or one marked as site text that
 * reads like story. It suggests; changing the line's type, or dismissing it, clears it.
 */
export interface SiteCheck {
  /** the type the detector thinks the line should have */
  suggest: "watermark" | "narration";
  /** what gave it away, in a few words: "names a web address", "repeated in 14 chapters" */
  why: string;
}

export type AudioStatus = "none" | "queued" | "generating" | "done" | "failed" | "stale";

/** One piece of a segment that had to be split to fit an endpoint's limit. */
export interface Cut {
  text?: string;
  from: number;
  to: number;
  /** boundary actually used for the cut after this part; null on the last part */
  at: SplitMode | null;
  /** true when the preferred boundary didn't exist and we fell down the chain */
  fallback: boolean;
}

/**
 * What a listener complained about after hearing a clip. `heard` is the one the app raises itself:
 * a check by ear (`HeardLine`) heard the clip say something other than the line. It never replaces
 * a flag a person set, and a check that hears the line right takes it down again.
 */
export type FlagKind = "pronunciation" | "delivery" | "pause" | "other" | "heard";

export interface SegmentFlag {
  kind: FlagKind;
  note: string;
  at: number;
}

/** A clip that was rendered and then superseded — kept so two takes can be compared. */
export interface Take {
  /** 1-based take number, stable for the life of the segment */
  n: number;
  at: number;
  ms: number;
  duration: number;
  cost?: number;
  /** what that cost was: the rate in force when this take landed, and why it was that rate */
  charge?: SpeechCharge;
  endpoint: string | null;
  voiceRef?: VoiceRef;
  voice?: string;
  model?: string;
  direction?: string;
  style?: string;
  /** the voice instructions submitted beside the line when this take was rendered */
  instructions?: string;
  type?: SegmentType;
  /** the text this clip was rendered from — a later split/join/edit shows up as drift */
  text?: string;
  /** what was sent after the dictionary, when it differed */
  said?: string;
  pronounced?: string;
  expressionSignature?: string;
  expressions?: string[];
  /** the rate the file actually came back at, in Hz, read from the file rather than the request */
  sampleRate?: number;
  /** the user listened to it and chose the other take */
  rejected?: boolean;
  /** where the rendered audio can be fetched; absent in the prototype, which has no files */
  url?: string;
}

export interface SegmentAudio {
  status: AudioStatus;
  endpoint: string | null;
  ms: number;
  duration: number;
  /** where the rendered audio can be fetched. The prototype renders no files, so this is absent and
   *  the player times the clip in silence instead — see `usePlayer`. */
  url?: string;

  // split, when the segment exceeded the endpoint's maxChars
  parts?: number;
  splitAt?: SplitMode;
  cuts?: Cut[];

  /** set when the request goes out, for the in-flight elapsed readout */
  startedAt?: number;

  // audit trail — what was actually sent, captured at render time
  voiceRef?: VoiceRef;
  voice?: string;
  model?: string;
  direction?: string;
  style?: string;
  /** the voice instructions actually submitted beside the line, composed from `style` and
   *  `direction`. Kept because a provider that meters what it receives meters these too, so the
   *  billable count and the audit trail have to be the same string. */
  instructions?: string;
  type?: SegmentType;
  at?: number;
  cost?: number;
  /**
   * The receipt for this clip: the rate in force when it landed, what moved that rate off the card,
   * and what it was charged on. Written once, when the render settles, and never recalculated —
   * editing the endpoint's rate or letting a promotion expire leaves every clip already rendered at
   * the price it was actually charged.
   */
  charge?: SpeechCharge;
  /** the exact text sent, so drift can tell "the script changed" from "the delivery changed" */
  text?: string;
  /** the text after the pronunciation dictionary, when it differed from `text` */
  said?: string;
  /** how many dictionary substitutions this clip carried */
  lex?: number;
  pronounced?: string;
  expressionSignature?: string;
  expressions?: string[];
  /** the rate the file actually came back at, in Hz, read from the file rather than the request */
  sampleRate?: number;

  // retakes
  /** take number of this clip; absent until the segment has been retaken at least once */
  n?: number;
  /**
   * A replacement queued by a bulk run rather than a retake asked for by hand. The clip in the book
   * keeps playing while it renders, exactly as a retake does; the difference is what happens when it
   * lands — a replacement that succeeds takes over at once and pushes the old clip into the take
   * list, so a run over 300 lines does not ask for 300 verdicts. One that fails leaves the old clip
   * alone and stays as a failed take for the listener to see.
   */
  auto?: boolean;
  /** every superseded clip, oldest first */
  takes?: Take[];

  error?: ReqError;
}

export interface Segment {
  id: number;
  type: SegmentType;
  speaker: string;
  text: string;
  direction: string;
  audio: SegmentAudio;
  /** the LLM failed verification on this run and it was kept whole as narration */
  fallback?: boolean;
  fallbackCount?: number;
  fallbackMismatch?: string;
  /** a re-split of this fallback chunk is in flight */
  fallbackRetrying?: boolean;
  /** changed by hand */
  edited?: boolean;
  /** the site-text detector disagrees with this line's type; see `SiteCheck` */
  siteCheck?: SiteCheck;
  /** the user flagged the *audio* — wrong pronunciation, bad delivery, awkward pause */
  flag?: SegmentFlag;
  /** seconds of silence stitched in after this line, overriding the book's pacing; 0 = run straight on */
  pause?: number;
  /** A retake rendering *beside* `audio`, waiting to be kept or dropped. Nothing reads it as the
   *  book's clip: the chapter plays, times and exports `audio` until the listener accepts this one. */
  candidate?: SegmentAudio;
  /** the exact whitespace that followed this segment in the source, when it isn't a single space —
   *  a hand split records it so the join that undoes it restores the paragraph break */
  sep?: string;
  expressions?: ExpressionAnnotation[];
}

/** Keyed `${bookId}:${chapterId}`. */
export type SegmentMap = Record<string, Segment[]>;

/**
 * What a transcription endpoint heard of one line's current clip: the `check` job's finding, kept
 * by the clip's audio file, which never changes once rendered (`GET …/chapters/:ch/heard`).
 */
export interface HeardLine {
  /**
   * The line's text as it was checked. A line edited since is no longer this, and its word marks
   * no longer point at its words: compare before using them.
   */
  text: string;
  /** what the endpoint heard, as it wrote it */
  heard: string;
  /**
   * Each word of `text` the endpoint was heard to say, in order: `[from, to, start, end]` — UTF-16
   * offsets into `text` (`to` exclusive) and seconds into the clip. A word it did not hear has no
   * mark. Null when the endpoint gave no word times; never estimated.
   */
  words: [number, number, number, number][] | null;
  /** words missing plus words added, over the line's words; 0 is a clip that says the line */
  score: number;
  /** the score is past what the check lets by, and the line was flagged (unless a person had) */
  mismatch: boolean;
  /** when it was checked, epoch ms */
  at: number;
}

/** A chapter's checked lines, by segment id; a line not checked yet is not in it. */
export type ChapterHeard = Record<number, HeardLine>;
