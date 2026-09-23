// A line spoken by Fish Audio, as its own API takes it.
//
// Fish is not OpenAI-shaped: the request goes to `POST /v1/tts` on the API's host, the model rides
// in a `model` header rather than the body, and the voice is a `reference_id` — the id of a model in
// the user's Fish library — rather than a name (https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech).
// The body is JSON, which the endpoint takes alongside msgpack; msgpack is only needed for
// uploading reference audio inline, which nothing here does.
//
// What goes in the body beyond the words is chosen for an audiobook. `format` is the endpoint's —
// WAV unless it chose MP3 or Opus, which are kept as they come and are a tenth of the size — with
// `mp3_bitrate` or `opus_bitrate` only when it names one; `normalize: true` (Fish's default, set so
// it cannot drift) because it is what makes "1997" and "£3.50" read as words in English;
// `sample_rate` only when the endpoint names one. A rate, bitrate or format Fish does not offer
// together (`speechFormats`) fails before a request rather than being answered at something
// nobody asked for, which the job would then read as drift on every run.
//
// Fish's MP3 is a bare LAME frame stream — no ID3 tag, no Xing frame — at a constant bitrate, and
// its Opus is Ogg, served as `audio/opus`. Both are read by `probeClip`, which does not need either
// to carry a length.
//
// The line's `direction` is not sent. Fish has no instructions field: an S2 model takes delivery as
// bracketed cues written into the text itself (https://docs.fish.audio/developer-guide/core-features/emotions),
// and the job already writes in the tags configured on the endpoint's Expressions tab, where their
// spelling is explicit and a change to them is tracked as drift. Writing the free-text direction in
// as another cue would put words into the text the person never configured — and read them aloud on
// a model that spells cues differently.
import type { AudioFormat } from "@/types";
import { fishModelsUrl } from "@/lib/endpointShapes";
import { audioAnswer, type AnsweredAudio, refuseEncoding } from "~/providers/answer";
import type { CallOptions, CallStats } from "~/providers/http";
import { call, jsonHeaders, ProviderError } from "~/providers/http";
import type { SentSpeech } from "~/providers/sent";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

export type SpeechCallOptions = Pick<CallOptions, "fetch" | "backoffMs">;

/** What went on the wire for one line, as the ledger counts it: the words and the instructions. */
export interface SpeechRequest {
  url: string;
  init: RequestInit;
  format: AudioFormat;
  /** exactly as it is in the body */
  text: string;
  /** exactly as it is in the body; empty when none was sent */
  instructions: string;
}

/**
 * Send one line and read the audio back, reporting the request through `input.sent` however it
 * ends — both wire shapes end the same way, so the rule is kept once, here.
 *
 * A request that got an answer is reported: a success with the audio's length, a refusal after the
 * endpoint's retries with the status it last answered, and a 200 that was not usable audio as
 * failed, because the provider was asked and will bill for it. A cancel reports nothing, since what
 * the provider did with a request it was mid-way through is not knowable. Neither API says what a
 * line used, so `reported` is null and the ledger counts what was sent.
 */
export async function sendSpeech(
  input: SpeechInput,
  target: ProviderTarget,
  request: SpeechRequest,
  options: SpeechCallOptions,
): Promise<AnsweredAudio> {
  const { signal } = input;
  const stats: CallStats = { attempts: 0, rateLimited: false };
  const startedAt = Date.now();
  const report = (rest: Pick<SentSpeech, "status" | "audioSeconds" | "error">): void =>
    input.sent?.({
      startedAt,
      finishedAt: Date.now(),
      attempts: Math.max(1, stats.attempts),
      rateLimited: stats.rateLimited,
      simulated: false,
      text: request.text,
      instructions: request.instructions,
      reported: null,
      ...rest,
    });
  const failed = (e: unknown): never => {
    if (signal.aborted) throw e;
    report({
      status: "failed",
      audioSeconds: 0,
      error: {
        code: e instanceof ProviderError ? e.status : 0,
        message: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  };
  let res: Response;
  try {
    res = await call(target, request.url, request.init, { signal, stats, ...options });
  } catch (e) {
    return failed(e);
  }
  let audio: AnsweredAudio;
  try {
    audio = await audioAnswer(target, res, signal, request.format);
  } catch (e) {
    return failed(e);
  }
  report({ status: "done", audioSeconds: audio.duration });
  return audio;
}

/** Fish serves TTS at `/v1/tts` on the API's host, whatever path the base URL was saved with. */
export function fishTtsUrl(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/v1/tts`;
}

export async function fishSpeak(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  options: SpeechCallOptions,
): Promise<RenderedClip> {
  const { sampleRate } = input;
  const { format, bitrate } = input.encoding;
  refuseEncoding(target, input);
  const started = Date.now();
  const audio = await sendSpeech(
    input,
    target,
    {
      url: fishTtsUrl(target.baseUrl),
      init: {
        method: "POST",
        headers: { ...jsonHeaders(target), model: target.model },
        body: JSON.stringify({
          text: input.text,
          reference_id: voice,
          format,
          ...(bitrate != null && format !== "wav" ? { [`${format}_bitrate`]: bitrate } : {}),
          ...(sampleRate != null ? { sample_rate: sampleRate } : {}),
          normalize: true,
        }),
      },
      format,
      text: input.text,
      // Fish takes no instructions beside the words (see the header), so none are billed
      instructions: "",
    },
    options,
  );
  return {
    ...audio,
    ms: Date.now() - started,
    model: target.model,
    voice,
  };
}

/**
 * The Test button for Fish: the user's own voice library, which needs the key and costs nothing,
 * where a spoken word would spend credit. It proves the key and the host, not the model header.
 */
export async function fishProbe(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<ProbeResult> {
  const started = Date.now();
  const res = await call(
    target,
    fishModelsUrl(target.baseUrl),
    { method: "GET", headers: jsonHeaders(target) },
    { signal, ...options },
  );
  const ms = Date.now() - started;
  const body = (await res.json().catch(() => null)) as { total?: unknown } | null;
  const total = typeof body?.total === "number" ? body.total : null;
  return {
    ok: true,
    message:
      `Answered in ${ms} ms; the key was accepted` +
      (total == null ? "" : ` and your library holds ${total} voice${total === 1 ? "" : "s"}`),
    ms,
  };
}
