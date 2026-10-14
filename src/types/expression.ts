// Model-specific narration expressions. A tag is configured on an endpoint; an annotation places
// one in a line without rewriting the source text.

export interface ExpressionTag {
  /** Shared name matching the same expression across manually configured models. */
  id: string;
  label: string;
  token: string;
  kind: "sound" | "delivery";
}

/** The brackets a model's tags are written in: `(laughs)`, `[laughs]`, `<laugh>`. */
export type TagBracket = "round" | "square" | "angle";

export interface ExpressionConfig {
  status: "unknown" | "unsupported" | "supported";
  /** none for a model that takes no tags */
  brackets: TagBracket[];
  /** any words in those brackets may be typed on the line, not only the listed tags */
  open: boolean;
  /** Capabilities belong to this exact model and base URL. */
  model: string;
  baseUrl: string;
  tags: ExpressionTag[];
}

/** A tag the scripting model wrote, and where in the line's text it goes. */
export interface ScriptedTag {
  label: string;
  at: number;
}

/** Each as long as the book's pacing says (`Pacing`). */
export type PauseWord = "pause" | "long pause";

/**
 * A tag, or a pause (`kind: "pause"`, `id` a `PauseWord`). A pause is sent as the provider's pause
 * tag, or else as silence between split parts; it is never left out.
 */
export interface ExpressionAnnotation extends Omit<ExpressionTag, "kind"> {
  kind: ExpressionTag["kind"] | "pause";
  /** seconds; absent, the book's length for its word */
  seconds?: number;
  annotationId: number;
  /** UTF-16 insertion position in the unchanged source text. */
  at: number;
  omitted?: boolean;
  needsReview?: boolean;
  /**
   * Written by the scripting model: plain words, bracketed for the voice when sent, and quietly
   * dropped (never holding the line) where the voice cannot take it.
   */
  scripted?: boolean;
}
