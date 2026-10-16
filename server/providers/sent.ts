// What a provider reports about each request that reached the wire, so the job can price it in the
// ledger (`~/usage/ledger`). A request refused or cancelled before it left reports nothing. One
// cancelled after it left is `cancelled`, with `billed` null: the provider may have charged for it.
import type { SpeechUsage, TokenUsage } from "@/types";

interface SentRequest {
  /** epoch ms when the first attempt went out, and when the last one ended */
  startedAt: number;
  finishedAt: number;
  /** 1 on a first-try answer */
  attempts: number;
  /** of `attempts`, those the clock cut off once out: each may have been charged for */
  timedOut?: number;
  rateLimited: boolean;
  status: "done" | "failed" | "cancelled";
  /** `code` 0 for no answer; `body` is a refused answer's content, for the Activity tab */
  error?: { code: number; message: string; body?: string };
  /** true for the fakes: nothing was really sent */
  simulated: boolean;
}

/** `usage` is null when the provider said nothing. */
export interface SentScript extends SentRequest {
  usage: TokenUsage | null;
}

/** `instructions` is what was actually sent: empty when the model takes none, so not billed. */
export interface SentSpeech extends SentRequest {
  text: string;
  instructions: string;
  /** seconds of audio that came back; 0 for a request that failed */
  audioSeconds: number;
  /** what the answer said it used, kept even when its audio proved unusable */
  reported: SpeechUsage | null;
  /**
   * True for any 2xx, even one this server then refused; false for a refusal or no answer unless
   * the provider bills those (`billsFailures` in `lib/providers/`); null when cancelled after send.
   */
  billed: boolean | null;
}

/** Priced by the audio sent; billed for any 2xx, even an unreadable transcript. */
export interface SentTranscription extends SentRequest {
  /** seconds of audio sent */
  audioSeconds: number;
  /** as `SentSpeech.billed`: null for a request cancelled after it went out */
  billed: boolean | null;
}
