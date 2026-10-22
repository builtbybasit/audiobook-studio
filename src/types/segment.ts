// One line of the script and its clip, addressed by `${bookId}:${chId}` plus its own id.
import type { SplitMode, VoiceRef } from "@/types/common";
import type { ReqError } from "@/types/endpoint";
import type { SpeechCharge } from "@/types/pricing";
import type { ExpressionAnnotation } from "@/types/expression";

/**
 * `watermark` (site boilerplate, never read) and `note` (translator's or author's note, read only
 * with `Book.readNotes`) mark non-story text rather than removing it; see `src/lib/siteText.ts`.
 */
export type SegmentType = "dialogue" | "narration" | "thought" | "watermark" | "note";

/**
 * The site-text detector disagrees with the model about this line's type. It only suggests;
 * changing the type or dismissing it clears it.
 */
export interface SiteCheck {
  /** the type the detector thinks the line should have */
  suggest: "watermark" | "narration";
  /** in a few words: "names a web address", "repeated in 14 chapters" */
  why: string;
}

/** moved: put back in the book's order; words: words copied in from the book; model: a repair's */
export type MendKind = "moved" | "words" | "model";

/** How a scripting run changed this line after the word check refused the model's answer. */
export interface Mend {
  kinds: MendKind[];
  /** for "words", in a few words: put back “…”, took out “…” */
  detail?: string;
}

export type AudioStatus = "none" | "queued" | "generating" | "done" | "failed" | "stale";

/** One piece of a segment that had to be split to fit an endpoint's limit. */
export interface Cut {
  text?: string;
  from: number;
  to: number;
  /** boundary actually used for the cut after this part; null on the last part */
  at: SplitMode | null;
  /** true when the preferred boundary didn't exist and the chain fell back */
  fallback: boolean;
}

/**
 * `heard` is raised by a check by ear (`HeardLine`) that heard something other than the line. It
 * never replaces a person's flag, and a check that hears the line right takes it down.
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
  /** the rate in force when this take landed, and why */
  charge?: SpeechCharge;
  endpoint: string | null;
  voiceRef?: VoiceRef;
  voice?: string;
  model?: string;
  direction?: string;
  style?: string;
  instructions?: string;
  type?: SegmentType;
  /** the text this clip was rendered from; a later split/join/edit shows up as drift */
  text?: string;
  /** what was sent after the dictionary, when it differed */
  said?: string;
  pronounced?: string;
  expressionSignature?: string;
  expressions?: string[];
  /** Hz, read from the file rather than the request */
  sampleRate?: number;
  /** the speed sent with the request (`speedSplit`); absent or null = none */
  speed?: number | null;
  /**
   * What the effects baked into the file do (`soundOf`); absent = the voice's own. "ffmpeg" is the
   * stand-in where Pedalboard could not run. A clip with no `raw` cannot be Re-applied.
   */
  sound?: string;
  /** the voice's own file, kept beside `url` when that is one the effects made from it */
  raw?: string;
  /** the user listened to it and chose the other take */
  rejected?: boolean;
  /** absent in the demo, which has no files */
  url?: string;
}

export interface SegmentAudio {
  status: AudioStatus;
  endpoint: string | null;
  ms: number;
  duration: number;
  /**
   * absent in the demo, which renders no files; the player times the clip in silence (`usePlayer`)
   */
  url?: string;

  // split, when the segment exceeded the endpoint's maxChars
  parts?: number;
  splitAt?: SplitMode;
  cuts?: Cut[];

  /** set when the request goes out, for the in-flight elapsed readout */
  startedAt?: number;

  // audit trail: what was actually sent
  voiceRef?: VoiceRef;
  voice?: string;
  model?: string;
  direction?: string;
  style?: string;
  /** Composed from `style` and `direction`; kept because providers meter these too. */
  instructions?: string;
  type?: SegmentType;
  at?: number;
  cost?: number;
  /** The receipt, written once when the render settles and never recalculated. */
  charge?: SpeechCharge;
  /** so drift can tell "the script changed" from "the delivery changed" */
  text?: string;
  /** the text after the pronunciation dictionary, when it differed from `text` */
  said?: string;
  /** how many dictionary substitutions this clip carried */
  lex?: number;
  pronounced?: string;
  expressionSignature?: string;
  expressions?: string[];
  /** Hz, read from the file rather than the request */
  sampleRate?: number;
  /** the speed sent with the request (`speedSplit`); absent or null = none */
  speed?: number | null;
  /** As on `Take.sound`. */
  sound?: string;
  /** the voice's own file, kept beside `url` when that is one the effects made from it */
  raw?: string;

  // retakes
  /** absent until the segment has been retaken at least once */
  n?: number;
  /**
   * A replacement queued by a bulk run, not a hand retake. The old clip plays while it renders; on
   * success it takes over at once (old clip into `takes`, so 300 lines don't ask for 300 verdicts).
   * On failure the old clip stays and this remains as a failed take.
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
  /** the LLM failed verification and the chunk was kept whole as narration */
  fallback?: boolean;
  fallbackCount?: number;
  fallbackMismatch?: string;
  /** a re-split of this fallback chunk is in flight */
  fallbackRetrying?: boolean;
  /** changed by hand */
  edited?: boolean;
  /** the site-text detector disagrees with this line's type; see `SiteCheck` */
  siteCheck?: SiteCheck;
  /** changed by the run, not the model, until a person edits the line or says it looks right */
  mended?: Mend;
  /** the user flagged the *audio* */
  flag?: SegmentFlag;
  /** seconds of silence after this line, overriding the book's pacing; 0 = run straight on */
  pause?: number;
  /**
   * A retake rendering beside `audio`; the chapter plays and exports `audio` until it is accepted.
   */
  candidate?: SegmentAudio;
  /** whitespace after this segment in the source, when not a single space; a join restores it */
  sep?: string;
  expressions?: ExpressionAnnotation[];
  /**
   * Line effects, by id, after the speaker's own (a phone, telepathy, a mask). Run in the library's
   * order, not this one (`chainsFor`); unknown ids are passed over.
   */
  effects?: string[];
}

/** Keyed `${bookId}:${chapterId}`. */
export type SegmentMap = Record<string, Segment[]>;

/** The `check` job's finding for one clip, kept by its audio file (`GET …/chapters/:ch/heard`). */
export interface HeardLine {
  /** The line's text as checked. If the line was edited since, the word marks no longer fit. */
  text: string;
  /** what the endpoint heard, as it wrote it */
  heard: string;
  /**
   * `[from, to, start, end]` per word heard: UTF-16 offsets into `text` (`to` exclusive) and
   * seconds into the clip. An unheard word has no mark. Null when the endpoint gave no word times;
   * never estimated.
   */
  words: [number, number, number, number][] | null;
  /** words missing plus words added, over the line's words; 0 is a clip that says the line */
  score: number;
  /** past what the check lets by; the line was flagged (unless a person had) */
  mismatch: boolean;
  /** epoch ms */
  at: number;
}

/** A chapter's checked lines, by segment id; a line not checked yet is not in it. */
export type ChapterHeard = Record<number, HeardLine>;
