// The port a speech model is reached through.
//
// A narration job hands a provider one line — the words, who says them, how — and gets back audio
// with a duration. That is the whole contract, the same shape of contract the scripting port
// keeps: what model, what request, what key and what it cost are the provider's business, and the
// job records only what the provider says about itself. A key, when there is one, is read by the
// provider from the server's own environment and never leaves the process — see `docs/backend.md`.
//
// Only the fake exists today, and it is selected explicitly. Nothing here can spend money.
import type { SegmentType, VoiceRef } from "@/types";

export interface SpeechInput {
  /** the line as it will be spoken */
  text: string;
  speaker: string;
  type: SegmentType;
  direction: string;
  /** `<endpointId>/<voiceId>` from the cast, or null when the speaker has no voice */
  voiceRef: VoiceRef | null;
  /**
   * The rate the endpoint asks every line for, in Hz, or null for the model's own. A provider
   * answers at it or fails; the job reads the rate the file actually came back at either way.
   */
  sampleRate: number | null;
  /** aborted when the job is cancelled; a provider that is mid-request should stop */
  signal: AbortSignal;
}

export interface RenderedClip {
  /** the audio, ready to be written to a file */
  bytes: Uint8Array;
  /** the media type of `bytes` */
  mime: "audio/wav";
  /** how long the audio plays, in seconds */
  duration: number;
  /** how long the request took, in milliseconds */
  ms: number;
  /** what the provider says rendered it, for the audit trail */
  model: string;
  voice: string | null;
}

export interface SpeechProvider {
  /** what the Queue page names, and the log */
  readonly name: string;
  speak(input: SpeechInput): Promise<RenderedClip>;
}

/** Which provider a server is started with. Only `fake` is implemented; see `env.ts`. */
export type SpeechProviderName = "fake";
