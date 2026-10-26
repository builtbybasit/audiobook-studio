// Dependency-free primitives any module in `types/` can import without a cycle.

export type Gender = "m" | "f" | "n" | "?";
export type Age = "child" | "teen" | "young adult" | "middle-aged" | "elderly";

/** Pitch within the voice's gender: a low woman's voice is still higher than most men's. */
export type Pitch = "low" | "mid" | "high";
/** husky = breathy or gravelly (much air or rasp), clear = little of either */
export type Texture = "husky" | "clear";
export type Delivery =
  | "calm"
  | "warm"
  | "cold"
  | "gentle"
  | "playful"
  | "cheerful"
  | "energetic"
  | "shy"
  | "sly"
  | "haughty"
  | "stern"
  | "menacing"
  | "weary"
  | "theatrical"
  | "seductive"
  | "deadpan";

/** How someone sounds, in the words a voice profile and a cast note share; absent = unknown. */
export interface VoiceType {
  pitch?: Pitch;
  texture?: Texture;
  delivery?: Delivery[];
}

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
