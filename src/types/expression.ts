// Model-specific narration expressions. A tag is configured on an endpoint; an annotation is one
// tag placed at a position in a line, and the source text is never rewritten to hold it.

export interface ExpressionTag {
  /** Shared name used to match the same expression across manually configured models. */
  id: string;
  label: string;
  token: string;
  kind: "sound" | "delivery";
}

/** The brackets a model's tags are written in: `(laughs)`, `[laughs]`, `<laugh>`. */
export type TagBracket = "round" | "square" | "angle";

export interface ExpressionConfig {
  status: "unknown" | "unsupported" | "supported";
  /** what a tag may be written in; none for a model that takes no tags */
  brackets: TagBracket[];
  /** any words in those brackets, typed on the line, rather than only the listed tags */
  open: boolean;
  /** Capabilities belong to this exact model and base URL, not every model at this endpoint. */
  model: string;
  baseUrl: string;
  tags: ExpressionTag[];
}

/** An expression tag the scripting model wrote: its words, and where in the line's text it goes. */
export interface ScriptedTag {
  label: string;
  at: number;
}

/** The two pauses a line can hold by name, each as long as the book's pacing says (`Pacing`). */
export type PauseWord = "pause" | "long pause";

/**
 * One annotation on a line: a tag, or a pause (`kind: "pause"`, `id` a `PauseWord`). A pause is
 * sent as the voice's own pause tag where its provider has one, and otherwise as silence between
 * the parts the line is spoken in — it is never left out.
 */
export interface ExpressionAnnotation extends Omit<ExpressionTag, "kind"> {
  kind: ExpressionTag["kind"] | "pause";
  /** a pause's own length in seconds; absent, it is the book's length for its word */
  seconds?: number;
  annotationId: number;
  /** UTF-16 insertion position in the unchanged source text. */
  at: number;
  omitted?: boolean;
  needsReview?: boolean;
  /**
   * Written by the scripting model rather than placed by a person: plain words, put in the voice's
   * own bracket when sent, and left out quietly — never holding the line — where the voice cannot
   * take it.
   */
  scripted?: boolean;
}
