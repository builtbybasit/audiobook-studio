// The port a speech model is reached through: one line in, audio with a duration out. Each request
// sent is reported through `sent`, which the job prices into the ledger (`sent.ts`). The server
// runs `endpointSpeech.ts`; tests use `fakeSpeech.ts`. A clip says the format it really came back
// in, which is what it is kept and served as.
import type {
  AudioEncoding,
  AudioFormat,
  BatchLimits,
  EndpointProbe,
  SegmentType,
  VoiceRef,
} from "@/types";
import { ProviderError } from "~/providers/http";
import type { SentSpeech } from "~/providers/sent";
import type { ProviderTarget } from "~/providers/target";

export interface SpeechInput {
  /** the line as it will be spoken */
  text: string;
  speaker: string;
  type: SegmentType;
  direction: string;
  /** the speaker's style and the line's direction together; empty when there is neither */
  instructions: string;
  /** null when the speaker has no voice */
  voiceRef: VoiceRef | null;
  /** Hz, or null for the model's own; the job reads the rate the file actually came back at */
  sampleRate: number | null;
  /**
   * `encodingOf` the endpoint, WAV when there is none. A real provider refuses a combination its
   * API cannot take before any request (`encodingProblems`).
   */
  encoding: AudioEncoding;
  /**
   * null when the speaker has no voice or its endpoint is gone. A real provider then fails the line
   * rather than sending it somewhere nobody chose.
   */
  target: ProviderTarget | null;
  signal: AbortSignal;
  /** called once for every request that reached the wire, answered or not; see `sent.ts` */
  sent?: (request: SentSpeech) => void;
  /** called on each rate-limit refusal with the wait, so the job can hold other lines (`gate.ts`) */
  rateLimited?: (waitMs: number) => void;
}

export interface RenderedClip {
  bytes: Uint8Array;
  format: AudioFormat;
  /** `AUDIO_MIME[format]` */
  mime: string;
  /** seconds */
  duration: number;
  /** how long the request took, in milliseconds */
  ms: number;
  /** what the provider says rendered it, for the audit trail */
  model: string;
  voice: string | null;
}

export type { BatchLimits };

export type BatchOutcome = { clip: RenderedClip } | { error: Error };

/**
 * A batch whose answer stopped part-way after it was accepted. Unlike a whole-batch refusal (already
 * retried by `call`), its unanswered lines were never retried, so they may go again in a later
 * batch (`server/narration/batch.ts`).
 */
export class BatchCut extends ProviderError {
  constructor(message: string) {
    super(message, 0, true);
    this.name = "BatchCut";
  }
}

/** Several lines for one endpoint in one request; each item reports through its own `sent`. */
export interface SpeechBatch {
  target: ProviderTarget;
  items: SpeechInput[];
  /** a cancel closes the request, and the items not yet answered are not reported */
  signal: AbortSignal;
  /** once per item, in whatever order the server finishes them */
  answered: (index: number, outcome: BatchOutcome) => void;
  /** as `SpeechInput.rateLimited`, for a refusal of the whole batch */
  rateLimited?: (waitMs: number) => void;
}

export interface SpeechProvider {
  readonly name: string;
  speak(input: SpeechInput): Promise<RenderedClip>;
  /** the Test button; absent, it cannot be tested */
  probe?(target: ProviderTarget, signal: AbortSignal): Promise<EndpointProbe>;
  /**
   * How many lines the endpoint takes per batch; null for one at a time. Cached for a while;
   * `fresh` asks the server again. Absent, a provider never batches.
   */
  batchLimits?(
    target: ProviderTarget,
    signal: AbortSignal,
    fresh?: boolean,
  ): Promise<BatchLimits | null>;
  /**
   * Resolves once every item is `answered`. Throws when the whole batch went wrong (refused, or a
   * `BatchCut`); the unanswered items are then the caller's. Present exactly when `batchLimits` is.
   */
  speakBatch?(batch: SpeechBatch): Promise<void>;
}
