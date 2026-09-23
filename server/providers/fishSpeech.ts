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
import { fishModelsUrl } from "@/lib/endpointShapes";
import { audioAnswer, refuseEncoding } from "~/providers/answer";
import type { CallOptions } from "~/providers/http";
import { call, jsonHeaders } from "~/providers/http";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

export type SpeechCallOptions = Pick<CallOptions, "fetch" | "backoffMs">;

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
  const { sampleRate, signal } = input;
  const { format, bitrate } = input.encoding;
  refuseEncoding(target, input);
  const started = Date.now();
  const res = await call(
    target,
    fishTtsUrl(target.baseUrl),
    {
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
    { signal, ...options },
  );
  const audio = await audioAnswer(target, res, signal, format);
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
