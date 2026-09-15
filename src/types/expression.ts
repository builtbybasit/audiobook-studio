// Model-specific narration expressions. A tag is configured on an endpoint; an annotation is one
// tag placed at a position in a line, and the source text is never rewritten to hold it.

export interface ExpressionTag {
  /** Shared name used to match the same expression across manually configured models. */
  id: string;
  label: string;
  token: string;
  kind: "sound" | "delivery";
}

export interface ExpressionConfig {
  status: "unknown" | "unsupported" | "supported";
  /** Capabilities belong to this exact model and base URL, not every model at this endpoint. */
  model: string;
  baseUrl: string;
  tags: ExpressionTag[];
}

export interface ExpressionAnnotation extends ExpressionTag {
  annotationId: number;
  /** UTF-16 insertion position in the unchanged source text. */
  at: number;
  omitted?: boolean;
  needsReview?: boolean;
}
