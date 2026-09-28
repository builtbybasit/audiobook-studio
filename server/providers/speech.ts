// The port a speech model is reached through.
//
// A narration job hands a provider one line — the words, who says them, how — and gets back audio
// with a duration. That is the whole contract, the same shape of contract the scripting port
// keeps: what model, what request and what key are the provider's business, and the job records
// only what the provider says about itself — each request it sent included, through `sent`, which
// the job prices into the ledger (`sent.ts`). A key, when there is one, is read by the
// provider from the server's own environment and never leaves the process — see `docs/backend.md`.
//
// Two implementations: the fake, which renders a tone and never the network, and the one that
// calls the endpoint a line's voice belongs to (`SPEECH_PROVIDER=endpoints`), in whichever
// provider's shape its base URL speaks (`endpointSpeech.ts`).
//
// A line is asked for in the endpoint's format — WAV, MP3 or Opus — and the clip says which format
// it really came back in, because that is what it is kept as and served as. The fake answers WAV
// whatever it is asked for, and says so.
import type { AudioEncoding, AudioFormat, SegmentType, VoiceRef } from "@/types";
import type { SentSpeech } from "~/providers/sent";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

export interface SpeechInput {
  /** the line as it will be spoken */
  text: string;
  speaker: string;
  type: SegmentType;
  direction: string;
  /**
   * What a model that takes spoken-delivery instructions is told: the speaker's style and the
   * line's direction together, as the clip records them. Empty when there is neither.
   */
  instructions: string;
  /** `<endpointId>/<voiceId>` from the cast, or null when the speaker has no voice */
  voiceRef: VoiceRef | null;
  /**
   * The rate the endpoint asks every line for, in Hz, or null for the model's own. A provider
   * answers at it or fails; the job reads the rate the file actually came back at either way.
   */
  sampleRate: number | null;
  /**
   * The format the endpoint asks every line for, and its bitrate: `encodingOf` the endpoint, WAV
   * when the line has none. A real provider refuses a combination its API cannot be asked for,
   * before any request (`encodingProblems`).
   */
  encoding: AudioEncoding;
  /**
   * The endpoint the voice belongs to, and its key; null when the speaker has no voice or the
   * voice names an endpoint that is no longer configured. The fake ignores it; a real provider
   * fails the line, naming why, rather than sending it somewhere nobody chose.
   */
  target: ProviderTarget | null;
  /** aborted when the job is cancelled; a provider that is mid-request should stop */
  signal: AbortSignal;
  /** called once for every request that reached the wire, answered or not; see `sent.ts` */
  sent?(request: SentSpeech): void;
  /**
   * Called each time the endpoint refuses a request as rate limited, with how long the request
   * will wait before trying again — so the job can hold its other lines for as long (`gate.ts`).
   */
  rateLimited?(waitMs: number): void;
}

export interface RenderedClip {
  /** the audio, ready to be written to a file */
  bytes: Uint8Array;
  /** what `bytes` is, and so the extension it is kept under */
  format: AudioFormat;
  /** the media type of `bytes`, `AUDIO_MIME[format]` */
  mime: string;
  /** how long the audio plays, in seconds */
  duration: number;
  /** how long the request took, in milliseconds */
  ms: number;
  /** what the provider says rendered it, for the audit trail */
  model: string;
  voice: string | null;
}

/**
 * How much one batch may carry, as the endpoint says (`docs/speech-batch-api.md`). A null is no
 * limit of that kind.
 */
export interface BatchLimits {
  /** lines in one request */
  maxItems: number | null;
  /** characters of text across every line of one request */
  maxInputChars: number | null;
  /** characters in one line; a longer one is sent as parts, each its own item */
  maxItemChars: number | null;
}

/** How one line of a batch ended: its clip, or why it has none. */
export type BatchOutcome = { clip: RenderedClip } | { error: Error };

/**
 * Several lines for one endpoint in one request. Every item is a whole `SpeechInput` — its own
 * text, voice, instructions and `sent`, which the provider reports it through as if it had gone
 * alone — and they share the endpoint, and so the format and the rate, the target and the signal.
 */
export interface SpeechBatch {
  target: ProviderTarget;
  items: SpeechInput[];
  /** the job's: a cancel closes the request, and the items not yet answered are not reported */
  signal: AbortSignal;
  /**
   * Told once for each item as it is answered, in whatever order the server finishes them. A
   * failure whose `ProviderError` is `retryable` may go differently in a later batch.
   */
  answered(index: number, outcome: BatchOutcome): void;
  /** as `SpeechInput.rateLimited`, for a refusal of the whole batch */
  rateLimited?(waitMs: number): void;
}

export interface SpeechProvider {
  /** what the Queue page names, and the log */
  readonly name: string;
  speak(input: SpeechInput): Promise<RenderedClip>;
  /** one small request to see the endpoint answers — the Test button; absent, it cannot be tested */
  probe?(target: ProviderTarget, signal: AbortSignal): Promise<ProbeResult>;
  /**
   * Whether the endpoint takes lines in batches, and how many; null when it takes one at a time.
   * Asked before a run sends to the endpoint, and cheap to ask again: a provider remembers the
   * answer for a while. Absent, a provider never batches.
   */
  batchLimits?(target: ProviderTarget, signal: AbortSignal): Promise<BatchLimits | null>;
  /**
   * Send a batch the endpoint said it takes. Resolves once every item has been `answered`; throws
   * when the batch as a whole went wrong — refused after the endpoint's retries, or cut off part
   * way — and the items not yet answered are then the caller's to fail or send again, with what
   * it threw. A cancel throws the signal's reason. Present exactly when `batchLimits` is.
   */
  speakBatch?(batch: SpeechBatch): Promise<void>;
}

/** Which provider a server is started with; see `env.ts`. */
export type SpeechProviderName = "fake" | "endpoints";
