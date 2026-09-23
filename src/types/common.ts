// Primitives shared across the domain. Everything here is a plain alias with no dependencies, so
// any other module in `types/` can import it without creating a cycle worth thinking about.

export type Gender = "m" | "f" | "n" | "?";

/** Where a too-long segment may be cut, in fallback order. */
export type SplitMode = "sentence" | "clause" | "word" | "char";

/** `<endpointId>/<voiceId>` — a character stores this, not a bare voice id. */
export type VoiceRef = string;

/**
 * The server's stable name for what went wrong with a request. Shared with the server, which is
 * what makes it a contract rather than two lists that agree by luck; see `server/lib/errors.ts`.
 */
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
  | "internal";
