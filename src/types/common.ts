// Primitives shared across the domain. Everything here is a plain alias with no dependencies, so
// any other module in `types/` can import it without creating a cycle worth thinking about.

export type Gender = "m" | "f" | "n" | "?";

/** Where a too-long segment may be cut, in fallback order. */
export type SplitMode = "sentence" | "clause" | "word" | "char";

/** `<endpointId>/<voiceId>` — a character stores this, not a bare voice id. */
export type VoiceRef = string;
