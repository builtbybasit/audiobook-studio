// What a provider says about each request it sent, so the ledger can price it.
//
// A provider knows what went on the wire and what came back; the job knows which book and chapter
// the work was for; the ledger knows the endpoint's rates. None of them knows all three, so the
// provider reports each request through `input.sent` and the job settles it (`~/usage/ledger`).
//
// **One report per request that reached the wire**, whether it succeeded or not — an answer the
// provider then refuses (cut off at the length limit, a line that is not the chapter's) was still
// billed. A request refused before anything was sent (no key, no voice, an unsupported format)
// reports nothing, because it cost nothing and never happened as far as the provider is concerned.
// A cancel mid-request reports nothing either: what the provider did with it is not knowable.
import type { SpeechUsage, TokenUsage } from "@/types";

interface SentRequest {
  /** epoch ms when the first attempt went out, and when the last one ended */
  startedAt: number;
  finishedAt: number;
  /** from `CallStats`: 1 on a first-try answer */
  attempts: number;
  rateLimited: boolean;
  status: "done" | "failed";
  /** for a failed request: what went wrong, and the status it answered with (0 for none) */
  error?: { code: number; message: string };
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
  reported: SpeechUsage | null;
}
