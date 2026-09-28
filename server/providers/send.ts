// One line sent to a speech provider and read back, reported to the ledger however it ends.
//
// Every provider's request is different — its path, its key header, its body, whether the answer
// is the audio or JSON around it — and each provider's wire module (`speech/`) says what its is as
// a `SpeechRequest`. What happens around it is the same for all of them, so it is here once: the
// request goes out through `call`, with the endpoint's timeout and retries; a 2xx is turned into a
// clip, by the provider's own `read` or as a body of audio (`audioAnswer`); and the request is
// reported through `input.sent` (`sent.ts`) with how many attempts it took, what the provider said
// it used, and whether it was billed.
//
// Billed is decided here, by one rule. A request that got a 2xx was generated, so it is billed even
// when what came back then proved unusable — cut off, empty, not the format asked for — and the
// usage the answer reported is kept for the row, because `read` hands it over (`counted`) before it
// decodes anything. A request that never got a 2xx — a refusal after the retries, no answer at all,
// a refusal inside a 200 that the provider's `check` found — was not, unless the provider's docs say
// it bills those (`billsFailures`). A cancel reports nothing: what the provider did with a request
// it was mid-way through is not knowable.
import type { AudioFormat, SpeechUsage } from "@/types";
import { audioAnswer, type AnsweredAudio } from "~/providers/answer";
import { call, ProviderError, type CallOptions, type CallStats } from "~/providers/http";
import type { SentSpeech } from "~/providers/sent";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";

/** What a caller may inject around every request: the tests' `fetch`, and their backoff. */
export type SpeechCallOptions = Pick<CallOptions, "fetch" | "backoffMs">;

/** What a `read` is handed beside the answer. */
export interface ReadContext {
  signal: AbortSignal;
  /**
   * What the answer says the request used, as soon as it has been read — before anything that
   * might fail — so a failure after it still reports it to the ledger.
   */
  counted(reported: SpeechUsage | null): void;
  /**
   * A further request that is part of this one — Qwen's download of the audio it links to — sent
   * with the same injected `fetch` and backoff, its attempts counted as this request's.
   */
  call(target: ProviderTarget, url: string, init: RequestInit): Promise<Response>;
}

/** What goes on the wire for one line, as the ledger counts it: the words and the instructions. */
export interface SpeechRequest {
  url: string;
  init: RequestInit;
  format: AudioFormat;
  /** exactly as it is in the body */
  text: string;
  /** exactly as it is in the body; empty when none was sent */
  instructions: string;
  /** a refusal inside a 2xx, found before the answer is accepted (`CallOptions.check`) */
  check?(res: Response): Promise<ProviderError | null>;
  /**
   * How a 2xx becomes audio, when it is not the audio itself — Gemini answers JSON carrying base64
   * audio and what it counted. Absent, the answer's body is the audio (`audioAnswer`).
   */
  read?(res: Response, context: ReadContext): Promise<AnsweredAudio>;
}

/**
 * Send one line and read the audio back, reporting the request through `input.sent` however it
 * ends; see the header for what is billed. Throws what went wrong, or the signal's reason.
 */
export async function sendSpeech(
  input: SpeechInput,
  target: ProviderTarget,
  request: SpeechRequest,
  options: SpeechCallOptions & { billsFailures: boolean },
): Promise<AnsweredAudio> {
  const { signal } = input;
  const { billsFailures, ...inject } = options;
  const stats: CallStats = { attempts: 0, rateLimited: false };
  // the further requests a `read` makes, added to the first's
  const more: CallStats = { attempts: 0, rateLimited: false };
  const startedAt = Date.now();
  let reported: SpeechUsage | null = null;
  const report = (rest: Pick<SentSpeech, "status" | "audioSeconds" | "error" | "billed">): void =>
    input.sent?.({
      startedAt,
      finishedAt: Date.now(),
      attempts: Math.max(1, stats.attempts) + more.attempts,
      rateLimited: stats.rateLimited || more.rateLimited,
      simulated: false,
      text: request.text,
      instructions: request.instructions,
      reported,
      ...rest,
    });
  const failed = (e: unknown, billed: boolean): never => {
    if (signal.aborted) throw e;
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
        // Not told to the gate: a further request goes to wherever the answer pointed — Qwen's
        // download from its storage host — and that host's limits are not the endpoint's.
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
    // answered with a 2xx: generated, and so billed, whatever became of it here
    return failed(e, true);
  }
  report({ status: "done", audioSeconds: audio.duration, billed: true });
  return audio;
}
