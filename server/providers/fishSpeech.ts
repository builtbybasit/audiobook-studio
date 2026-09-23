// A line spoken by Fish Audio, as its own API takes it.
//
// Fish is not OpenAI-shaped: the request goes to `POST /v1/tts` on the API's host, the model rides
// in a `model` header rather than the body, and the voice is a `reference_id` — the id of a model in
// the user's Fish library — rather than a name (https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech).
// The body is JSON, which the endpoint takes alongside msgpack; msgpack is only needed for
// uploading reference audio inline, which nothing here does.
//
// What goes in the body beyond the words is chosen for an audiobook. `format: "wav"` because the
// job, the join and the export read PCM; `normalize: true` (Fish's default, set so it cannot drift)
// because it is what makes "1997" and "£3.50" read as words in English; `sample_rate` only when the
// endpoint names one, and only a rate Fish says WAV comes in — anything else fails before a request
// rather than being answered at a rate nobody asked for, which the job would then read as drift on
// every run.
//
// The line's `direction` is not sent. Fish has no instructions field: an S2 model takes delivery as
// bracketed cues written into the text itself (https://docs.fish.audio/developer-guide/core-features/emotions),
// and the job already writes in the tags configured on the endpoint's Expressions tab, where their
// spelling is explicit and a change to them is tracked as drift. Writing the free-text direction in
// as another cue would put words into the text the person never configured — and read them aloud on
// a model that spells cues differently.
import type { CallOptions } from "~/providers/http";
import { call, jsonHeaders, ProviderError } from "~/providers/http";
import { fishModelsUrl } from "@/lib/endpointShapes";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";
import { wavAnswer } from "~/providers/wav";

/** The rates Fish renders WAV at, in Hz; with none asked for it answers at 44.1 kHz. */
export const FISH_WAV_RATES = [8000, 16000, 24000, 32000, 44100] as const;

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
  if (sampleRate != null && !(FISH_WAV_RATES as readonly number[]).includes(sampleRate))
    throw new ProviderError(
      `${target.name} cannot render WAV at ${sampleRate} Hz — Fish Audio offers ` +
        `${FISH_WAV_RATES.join(", ")} Hz. Pick one of those on the Endpoints page, or clear it for 44100.`,
      0,
      false,
    );
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
        format: "wav",
        ...(sampleRate != null ? { sample_rate: sampleRate } : {}),
        normalize: true,
      }),
    },
    { signal, ...options },
  );
  const wav = await wavAnswer(target, res, signal);
  return {
    bytes: wav.bytes,
    mime: "audio/wav",
    duration: wav.duration,
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
