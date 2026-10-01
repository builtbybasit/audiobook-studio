// What a provider says about each request it sent, so the ledger can price it.
//
// A provider knows what went on the wire and what came back; the job knows which book and chapter
// the work was for; the ledger knows the endpoint's rates. None of them knows all three, so the
// provider reports each request through `input.sent` and the job settles it (`~/usage/ledger`).
//
// **One report per request that reached the wire**, whether it succeeded or not. Whether it was
// billed is a separate question, and a speech request answers it itself (`billed`): an answer the
// provider sent and this server then refused — cut off, empty, not the audio asked for — was
// generated and is billed; a refusal, a request that never got an answer, or a refusal inside a
// 200 was not, unless that provider's docs say it bills failures (`billsFailures` in
// `lib/providers/`). A request refused before anything was sent (no key, no voice, an unsupported
// format) reports nothing, because it cost nothing and never happened as far as the provider is
// concerned. A cancel mid-request reports nothing either: what the provider did with it is not
// knowable.
import type { SpeechUsage, TokenUsage } from "@/types";

interface SentRequest {
  /** epoch ms when the first attempt went out, and when the last one ended */
  startedAt: number;
  finishedAt: number;
  /** from `CallStats`: 1 on a first-try answer */
  attempts: number;
  rateLimited: boolean;
  status: "done" | "failed";
  /**
   * for a failed request: what went wrong, the status it answered with (0 for none), and what the
   * answer said where it was refused for its content, so the endpoint's Activity can show it whole
   */
  error?: { code: number; message: string; body?: string };
  /** true for the fakes: nothing was really sent and nobody will bill for it */
  simulated: boolean;
}

/** One scripting request: the usage the provider reported, normalized; null when it said nothing. */
export interface SentScript extends SentRequest {
  usage: TokenUsage | null;
}

/**
 * One speech request: what was submitted, counted by the ledger against the endpoint's billing
 * unit, and whatever the provider said about it. `instructions` is what was actually sent beside
 * the text — empty when the model takes none — so a model that ignores them is not billed for them.
 */
export interface SentSpeech extends SentRequest {
  text: string;
  instructions: string;
  /** seconds of audio that came back; 0 for a request that failed */
  audioSeconds: number;
  /** what the answer said the request used, kept when what came with it proved unusable */
  reported: SpeechUsage | null;
  /**
   * Whether the provider charges for this request: always for one that succeeded or was answered
   * with a 2xx, never for a refusal or no answer unless the provider bills those (see the header).
   * The ledger keeps a row either way, and prices one that was not billed at nothing.
   */
  billed: boolean;
}
