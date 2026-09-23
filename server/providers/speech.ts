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
// calls the endpoint a line's voice belongs to (`SPEECH_PROVIDER=endpoints`) — Fish Audio when its
// base URL is Fish's, OpenAI's `/audio/speech` shape otherwise.
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

export interface SpeechProvider {
  /** what the Queue page names, and the log */
  readonly name: string;
  speak(input: SpeechInput): Promise<RenderedClip>;
  /** one small request to see the endpoint answers — the Test button; absent, it cannot be tested */
  probe?(target: ProviderTarget, signal: AbortSignal): Promise<ProbeResult>;
}

/** Which provider a server is started with; see `env.ts`. */
export type SpeechProviderName = "fake" | "endpoints";
