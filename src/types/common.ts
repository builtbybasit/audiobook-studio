// Dependency-free primitives any module in `types/` can import without a cycle.

export type Gender = "m" | "f" | "n" | "?";

/** Where a too-long segment may be cut, in fallback order. */
export type SplitMode = "paragraph" | "sentence" | "clause" | "word" | "char";

/** `<endpointId>/<voiceId>` — a character stores this, not a bare voice id. */
export type VoiceRef = string;

/** The server's stable error names, shared with it as a contract; see `server/lib/errors.ts`. */
export type ApiErrorCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "unsupported_media"
  | "range_not_satisfiable"
  /** a provider this server called refused or failed; the message is what it said */
  | "upstream"
  /** something this server needs is not on this machine; the message says what */
  | "unavailable"
  | "internal";
