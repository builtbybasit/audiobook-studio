// One line of the script and the clip rendered from it. A segment is addressed by `${bookId}:${chId}`
// plus its own id; the store mutates these in place and nothing here is persisted.
import type { SplitMode, VoiceRef } from "@/types/common";
import type { ReqError } from "@/types/endpoint";
import type { ExpressionAnnotation } from "@/types/expression";

export type SegmentType = "dialogue" | "narration" | "thought";

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

/** What a listener complained about after hearing a clip. */
export type FlagKind = "pronunciation" | "delivery" | "pause" | "other";

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
  endpoint: string | null;
  voiceRef?: VoiceRef;
  voice?: string;
  model?: string;
  direction?: string;
  style?: string;
  type?: SegmentType;
  /** the text this clip was rendered from — a later split/join/edit shows up as drift */
  text?: string;
  /** what was sent after the dictionary, when it differed */
  said?: string;
  pronounced?: string;
  expressionSignature?: string;
  expressions?: string[];
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
  type?: SegmentType;
  at?: number;
  cost?: number;
  /** the exact text sent, so drift can tell "the script changed" from "the delivery changed" */
  text?: string;
  /** the text after the pronunciation dictionary, when it differed from `text` */
  said?: string;
  /** how many dictionary substitutions this clip carried */
  lex?: number;
  pronounced?: string;
  expressionSignature?: string;
  expressions?: string[];

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
  /** changed by hand; survives a re-script when "keep my edits" is on */
  edited?: boolean;
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
