// A line spoken by ElevenLabs, as its own API takes it.
//
// ElevenLabs is neither Fish- nor OpenAI-shaped
// (https://elevenlabs.io/docs/api-reference/text-to-speech/convert): the voice rides in the path —
// `POST /v1/text-to-speech/{voice_id}` — the model in the body as `model_id`, the key in an
// `xi-api-key` header, and the format in an `output_format` query that names the rate and, for an
// MP3, the bitrate in one word (`wav_24000`, `mp3_44100_128`). The answer is the audio itself, so it
// is read the way Fish's and OpenAI's are (`audioAnswer`). BreezeBlue copies all of this, and its
// module (`breezeblue.ts`) is built from the pieces here.
//
// Only the words are sent. ElevenLabs has no instructions field: `eleven_v3` takes delivery as
// bracketed audio tags written into the text (`[whispers]`, `[laughs]`), which is what the
// endpoint's Expressions tab is for. It bills per character of that text, which the ledger counts
// from what was sent. An answer may also carry ElevenLabs' own count in a `character-cost` header —
// its request-stitching guide reads it, though the API reference does not list it for this
// endpoint — and when it is a count, it is reported beside what was sent; anything else in it is
// ignored, since a blank read as 0 would price the line at nothing.
//
// Voices are an account's own — premade, cloned, designed and saved from the library — at
// `GET /v2/voices`, a hundred a page.
import type { SpeechUsage, Voice } from "@/types";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { audioAnswer } from "~/providers/answer";
import { call } from "~/providers/http";
import type { SpeechCallOptions, SpeechRequest } from "~/providers/send";
import type { SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";
import type { SpeechWire } from "~/providers/speech/wire";

/** What this app asks for when the endpoint names no rate: 24 kHz, which every plan may ask for. */
const WAV_RATE = 24000;
const MP3_RATE = 44100;
const MP3_BITRATE = 128;

/** A voice list is read whole, a hundred a page where the page size can be asked for. */
const VOICE_PAGE = 100;
/** …up to this many pages. */
export const VOICE_PAGES = 10;

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

/** The characters an answer's `character-cost` header counts, when it holds a count. */
function characterCost(res: Response): SpeechUsage | null {
  const header = res.headers.get("character-cost")?.trim() ?? "";
  const characters = /^\d+$/.test(header) ? Number(header) : 0;
  return characters > 0 ? normalizeSpeechUsage({ characters }, "plain") : null;
}

/** One line as either API takes it; `instructions` is what goes beside the words, or nothing. */
export function elevenLabsRequest(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  instructions: string,
): SpeechRequest {
  const { format } = input.encoding;
  const query = new URLSearchParams({ output_format: elevenLabsOutputFormat(input) });
  return {
    url: `${elevenLabsRoot(target.baseUrl)}/text-to-speech/${encodeURIComponent(voice)}?${query}`,
    init: {
      method: "POST",
      headers: elevenLabsHeaders(target),
      body: JSON.stringify({
        text: input.text,
        model_id: target.model,
        ...(instructions ? { instructions } : {}),
      }),
    },
    format,
    text: input.text,
    // what was sent beside the words, and so what the ledger counts
    instructions,
    async read(res, { signal, counted }) {
      counted(characterCost(res));
      return audioAnswer(target, res, signal, format);
    },
  };
}

/**
 * The Test button for either API: its model list, `GET /v1/models`, a bare array — which needs the
 * key and costs nothing, and says when the configured model is not one this key can speak with.
 */
export async function modelsProbe(
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

export const elevenLabsWire: SpeechWire = {
  // ElevenLabs has no instructions field, so nothing is sent beside the words, and none is billed
  request: (input, target, voice) => elevenLabsRequest(input, target, voice, ""),
  probe: modelsProbe,

  /** Gender is one of a voice's free-form labels, when it has it. */
  async voices(target, signal, options) {
    const voices: Voice[] = [];
    let token: string | null = null;
    let more = true;
    for (let page = 1; more && page <= VOICE_PAGES; page++) {
      const q = new URLSearchParams({ page_size: String(VOICE_PAGE) });
      if (token) q.set("next_page_token", token);
      const res = await call(
        target,
        `${new URL(elevenLabsRoot(target.baseUrl)).origin}/v2/voices?${q}`,
        { method: "GET", headers: elevenLabsHeaders(target) },
        { signal, ...options },
      );
      const body = (await res.json().catch(() => null)) as {
        voices?: { voice_id?: unknown; name?: unknown; labels?: Record<string, unknown> }[];
        has_more?: unknown;
        next_page_token?: unknown;
      } | null;
      for (const v of body?.voices ?? []) {
        if (typeof v.voice_id !== "string" || !v.voice_id) continue;
        const gender = String(v.labels?.gender ?? "").toLowerCase();
        voices.push({
          id: v.voice_id,
          label: typeof v.name === "string" && v.name.trim() ? v.name.trim() : v.voice_id,
          gender: gender === "male" ? "m" : gender === "female" ? "f" : "?",
        });
      }
      token = typeof body?.next_page_token === "string" ? body.next_page_token : null;
      more = body?.has_more === true && !!token;
    }
    return { voices, total: voices.length, page: 1, hasMore: more };
  },
};
