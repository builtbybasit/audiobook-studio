// A line spoken by ElevenLabs, as its own API takes it.
//
// ElevenLabs is neither Fish- nor OpenAI-shaped
// (https://elevenlabs.io/docs/api-reference/text-to-speech/convert): the voice rides in the path —
// `POST /v1/text-to-speech/{voice_id}` — the model in the body as `model_id`, the key in an
// `xi-api-key` header, and the format in an `output_format` query that names the rate and, for an
// MP3, the bitrate in one word (`wav_24000`, `mp3_44100_128`). The answer is the audio itself, so it
// is read the way Fish's and OpenAI's are (`audioAnswer`).
//
// Only the words are sent. ElevenLabs has no instructions field: `eleven_v3` takes delivery as
// bracketed audio tags written into the text (`[whispers]`, `[laughs]`), which is what the
// endpoint's Expressions tab is for. It bills per character of that text, which the ledger counts
// from what was sent; when the answer carries ElevenLabs' own count (`character-cost`, which its
// request-stitching guide reads) that count is reported beside it.
import type { SpeechUsage } from "@/types";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { audioAnswer, refuseEncoding } from "~/providers/answer";
import { sendSpeech, type SpeechCallOptions } from "~/providers/fishSpeech";
import { call } from "~/providers/http";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

/** What this app asks for when the endpoint names no rate: 24 kHz, which every plan may ask for. */
const WAV_RATE = 24000;
const MP3_RATE = 44100;
const MP3_BITRATE = 128;

/** ElevenLabs serves its API under `/v1` on its host, whatever path the base URL was saved with. */
export const elevenLabsRoot = (baseUrl: string): string => `${new URL(baseUrl).origin}/v1`;

/** The headers every ElevenLabs request carries: its key goes in its own header. */
export function elevenLabsHeaders(target: ProviderTarget): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(target.apiKey ? { "xi-api-key": target.apiKey } : {}),
  };
}

/** The `output_format` a line is asked for, from the endpoint's format, rate and bitrate. */
export function elevenLabsOutputFormat(
  input: Pick<SpeechInput, "encoding" | "sampleRate">,
): string {
  const { format, bitrate } = input.encoding;
  if (format === "mp3") return `mp3_${input.sampleRate ?? MP3_RATE}_${bitrate ?? MP3_BITRATE}`;
  return `wav_${input.sampleRate ?? WAV_RATE}`;
}

export async function elevenLabsSpeak(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  options: SpeechCallOptions,
): Promise<RenderedClip> {
  refuseEncoding(target, input);
  const { format } = input.encoding;
  const query = new URLSearchParams({ output_format: elevenLabsOutputFormat(input) });
  const started = Date.now();
  const audio = await sendSpeech(
    input,
    target,
    {
      url: `${elevenLabsRoot(target.baseUrl)}/text-to-speech/${encodeURIComponent(voice)}?${query}`,
      init: {
        method: "POST",
        headers: elevenLabsHeaders(target),
        body: JSON.stringify({ text: input.text, model_id: target.model }),
      },
      format,
      text: input.text,
      // no instructions field (see the header), so none are billed
      instructions: "",
      read: async (res, signal) => {
        const characters = Number(res.headers.get("character-cost"));
        const reported: SpeechUsage | null =
          Number.isFinite(characters) && res.headers.has("character-cost")
            ? normalizeSpeechUsage({ characters }, "plain")
            : null;
        return { audio: await audioAnswer(target, res, signal, format), reported };
      },
    },
    options,
  );
  return { ...audio, ms: Date.now() - started, model: target.model, voice };
}

/**
 * The Test button for ElevenLabs: its model list, which needs the key and costs nothing, and says
 * when the configured model is not one this key can speak with.
 */
export async function elevenLabsProbe(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<ProbeResult> {
  const started = Date.now();
  const res = await call(
    target,
    `${elevenLabsRoot(target.baseUrl)}/models`,
    { method: "GET", headers: elevenLabsHeaders(target) },
    { signal, ...options },
  );
  const ms = Date.now() - started;
  const body = (await res.json().catch(() => null)) as
    | { model_id?: unknown; can_do_text_to_speech?: unknown }[]
    | null;
  const ids = Array.isArray(body)
    ? body
        .filter((m) => m?.can_do_text_to_speech !== false)
        .map((m) => m?.model_id)
        .filter((id): id is string => typeof id === "string")
    : [];
  if (ids.length && !ids.includes(target.model))
    return {
      ok: false,
      message: `Answered in ${ms} ms, but “${target.model}” is not among the ${ids.length} speech models it lists`,
      ms,
    };
  return {
    ok: true,
    message:
      `Answered in ${ms} ms; the key was accepted` +
      (ids.length ? ` and it lists “${target.model}”` : ""),
    ms,
  };
}
