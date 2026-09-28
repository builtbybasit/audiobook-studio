// A line spoken by Cartesia, through `POST /tts/bytes`.
//
// Cartesia is its own shape (https://docs.cartesia.ai/api-reference/tts/bytes): a bearer key, a
// `Cartesia-Version` header naming the API version the request is written against, and a JSON
// body of `model_id`, `transcript`, `voice: {id}` and an `output_format` that names the container,
// the sample encoding and the rate — and, for an MP3, the bitrate in bits a second. The answer is
// the audio itself, read as every other body of audio is (`audioAnswer`). Cartesia reports no
// usage, so the ledger counts the characters that were sent, which is what it bills on.
//
// Only the words are sent. Sonic takes delivery as tags in the transcript — `[laughter]`,
// `<break time="1s"/>`, `<emotion value="calm"/>` — which is what the endpoint's Expressions tab is
// for.
import { audioAnswer, refuseEncoding } from "~/providers/answer";
import { sendSpeech, type SpeechCallOptions } from "~/providers/fishSpeech";
import { call, jsonHeaders } from "~/providers/http";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

/** The API version every request is written against, the one Cartesia's reference names. */
export const CARTESIA_VERSION = "2026-08-14";

/** What this app asks for when the endpoint names no rate: the rate Cartesia's example uses. */
const DEFAULT_RATE = 44100;
const DEFAULT_MP3_KBPS = 128;

/** Cartesia serves its API at the host root, whatever path the base URL was saved with. */
export const cartesiaRoot = (baseUrl: string): string => new URL(baseUrl).origin;

export function cartesiaHeaders(target: ProviderTarget): Record<string, string> {
  return { ...jsonHeaders(target), "cartesia-version": CARTESIA_VERSION };
}

/** The request body for one line. Exported for the tests, which check it against the docs. */
export function cartesiaBody(
  input: Pick<SpeechInput, "text" | "sampleRate" | "encoding">,
  model: string,
  voice: string,
): Record<string, unknown> {
  const { format, bitrate } = input.encoding;
  const sample_rate = input.sampleRate ?? DEFAULT_RATE;
  return {
    model_id: model,
    transcript: input.text,
    voice: { id: voice },
    output_format:
      format === "mp3"
        ? { container: "mp3", sample_rate, bit_rate: (bitrate ?? DEFAULT_MP3_KBPS) * 1000 }
        : { container: "wav", encoding: "pcm_s16le", sample_rate },
  };
}

export async function cartesiaSpeak(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  options: SpeechCallOptions,
): Promise<RenderedClip> {
  refuseEncoding(target, input);
  const { format } = input.encoding;
  const started = Date.now();
  const audio = await sendSpeech(
    input,
    target,
    {
      url: `${cartesiaRoot(target.baseUrl)}/tts/bytes`,
      init: {
        method: "POST",
        headers: cartesiaHeaders(target),
        body: JSON.stringify(cartesiaBody(input, target.model, voice)),
      },
      format,
      text: input.text,
      // no instructions field (see the header), so none are billed
      instructions: "",
      read: async (res, signal) => ({
        audio: await audioAnswer(target, res, signal, format),
        reported: null,
      }),
    },
    options,
  );
  return { ...audio, ms: Date.now() - started, model: target.model, voice };
}

/** One page of voices from `GET /voices`: Cartesia's own and the account's, a hundred a page. */
export async function cartesiaVoicePage(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
  limit: number,
  after?: string,
): Promise<{
  voices: { id: string; name: string; gender: string }[];
  hasMore: boolean;
}> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (after) q.set("starting_after", after);
  const res = await call(
    target,
    `${cartesiaRoot(target.baseUrl)}/voices?${q}`,
    { method: "GET", headers: cartesiaHeaders(target) },
    { signal, ...options },
  );
  const body = (await res.json().catch(() => null)) as {
    data?: { id?: unknown; name?: unknown; gender?: unknown }[];
    has_more?: unknown;
  } | null;
  const voices = (body?.data ?? [])
    .filter((v): v is { id: string; name?: unknown; gender?: unknown } => typeof v?.id === "string")
    .map((v) => ({
      id: v.id,
      name: typeof v.name === "string" && v.name.trim() ? v.name.trim() : v.id,
      gender: String(v.gender ?? ""),
    }));
  return { voices, hasMore: body?.has_more === true };
}

/** The Test button for Cartesia: one voice from its list, which needs the key and costs no credit. */
export async function cartesiaProbe(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<ProbeResult> {
  const started = Date.now();
  await cartesiaVoicePage(target, signal, options, 1);
  const ms = Date.now() - started;
  return { ok: true, message: `Answered in ${ms} ms; the key was accepted`, ms };
}
