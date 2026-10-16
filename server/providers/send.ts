// One line sent to a speech provider and read back, reported to the ledger however it ends. Each
// wire module (`speech/`) describes its request as a `SpeechRequest`. Billing rule: a 2xx is billed
// even if its audio proves unusable; no 2xx is billed only under `billsFailures`. A cancel after
// send is `cancelled` with unknown cost; one before send reports nothing.
import type { AudioFormat, SpeechUsage } from "@/types";
import { audioAnswer, type AnsweredAudio } from "~/providers/answer";
import { call, ProviderError, type CallOptions, type CallStats } from "~/providers/http";
import type { SentSpeech } from "~/providers/sent";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";

/** For tests. */
export type SpeechCallOptions = Pick<CallOptions, "fetch" | "backoffMs">;

export interface ReadContext {
  signal: AbortSignal;
  /** call before anything that might fail, so a later failure still reports the usage */
  counted: (reported: SpeechUsage | null) => void;
  /** a further request counted as part of this one (Qwen's audio download) */
  call(target: ProviderTarget, url: string, init: RequestInit): Promise<Response>;
}

export interface SpeechRequest {
  url: string;
  init: RequestInit;
  format: AudioFormat;
  /** exactly as it is in the body */
  text: string;
  /** exactly as it is in the body; empty when none was sent */
  instructions: string;
  /** `CallOptions.check` */
  check?: (res: Response) => Promise<ProviderError | null>;
  /** `CallOptions.retryable` */
  retryable?: (status: number) => boolean;
  /** for a 2xx that is not the audio itself (Gemini's JSON); absent, `audioAnswer` */
  read?(res: Response, context: ReadContext): Promise<AnsweredAudio>;
}

/** Throws what went wrong, or the signal's reason. */
export async function sendSpeech(
  input: SpeechInput,
  target: ProviderTarget,
  request: SpeechRequest,
  options: SpeechCallOptions & { billsFailures: boolean },
): Promise<AnsweredAudio> {
  const { signal } = input;
  const { billsFailures, ...inject } = options;
  const stats: CallStats = { attempts: 0, rateLimited: false };
  // a `read`'s further requests
  const more: CallStats = { attempts: 0, rateLimited: false };
  const startedAt = Date.now();
  let reported: SpeechUsage | null = null;
  const report = (rest: Pick<SentSpeech, "status" | "audioSeconds" | "error" | "billed">): void =>
    input.sent?.({
      startedAt,
      finishedAt: Date.now(),
      attempts: Math.max(1, stats.attempts) + more.attempts,
      timedOut: stats.timedOut,
      rateLimited: stats.rateLimited || more.rateLimited,
      simulated: false,
      text: request.text,
      instructions: request.instructions,
      reported,
      ...rest,
    });
  const failed = (e: unknown, billed: boolean): never => {
    if (signal.aborted) {
      if (stats.attempts) report({ status: "cancelled", audioSeconds: 0, billed: null });
      throw e;
    }
    report({
      status: "failed",
      audioSeconds: 0,
      billed,
      error: {
        code: e instanceof ProviderError ? e.status : 0,
        message: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  };
  let res: Response;
  try {
    res = await call(target, request.url, request.init, {
      signal,
      stats,
      rateLimited: input.rateLimited,
      ...inject,
      ...(request.check ? { check: request.check } : {}),
      ...(request.retryable ? { retryable: request.retryable } : {}),
    });
  } catch (e) {
    return failed(e, billsFailures);
  }
  const context: ReadContext = {
    signal,
    counted: (usage) => void (reported = usage),
    async call(further, url, init) {
      const counted: CallStats = { attempts: 0, rateLimited: false };
      try {
        // Not told to the gate: the storage host's limits are not the endpoint's.
        return await call(further, url, init, { signal, stats: counted, ...inject });
      } finally {
        more.attempts += counted.attempts;
        more.rateLimited ||= counted.rateLimited;
      }
    },
  };
  let audio: AnsweredAudio;
  try {
    audio = request.read
      ? await request.read(res, context)
      : await audioAnswer(target, res, signal, request.format);
  } catch (e) {
    // a 2xx is billed, whatever became of it here
    return failed(e, true);
  }
  report({ status: "done", audioSeconds: audio.duration, billed: true });
  return audio;
}
