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
// `GET /v2/voices`, a hundred a page. With no `voice_type` it answers every kind
// (https://elevenlabs.io/docs/api-reference/voices/search), so a voice cloned here is among them.
//
// A voice is cloned with Instant Voice Cloning, `POST /v1/voices/add`
// (https://elevenlabs.io/docs/api-reference/voices/ivc/create), as multipart: the voice's `name` and
// every sample under `files`. `remove_background_noise` is left at its default, off — the docs warn
// that on clean samples it "can make the quality worse" — and no `labels` are sent, since nothing
// here knows the speaker's gender or accent. The voice is usable at once and its `voice_id` is
// what a line is spoken with. The answer also says whether the voice `requires_verification`: then
// it exists on the account but ElevenLabs will not speak with it until the person has verified it
// on ElevenLabs' site. It is answered all the same, named so it says what is left to do — failing
// here would leave the voice made on the account and the recordings unkept, and a
// second try would make a second voice.
import type { EndpointProbe, SpeechUsage, Voice } from "@/types";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { elevenlabs } from "@/lib/providers/elevenlabs";
import { formatDefaults, type SpeechProviderShape } from "@/lib/providers/types";
import { audioAnswer } from "~/providers/answer";
import { call, ProviderError } from "~/providers/http";
import type { SpeechCallOptions, SpeechRequest } from "~/providers/send";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import type { SpeechWire } from "~/providers/speech/wire";

/** A voice list is read whole, a hundred a page where the page size can be asked for. */
const VOICE_PAGE = 100;
/** …up to this many pages. */
export const VOICE_PAGES = 10;

/** ElevenLabs serves its API under `/v1` on its host, whatever path the base URL was saved with. */
export const elevenLabsRoot = (baseUrl: string): string => `${new URL(baseUrl).origin}/v1`;

/** The key in ElevenLabs' own header, alone — for a body that types itself: a form. */
export function elevenLabsKeyHeader(target: ProviderTarget): Record<string, string> {
  return target.apiKey ? { "xi-api-key": target.apiKey } : {};
}

/** The headers every ElevenLabs JSON request carries: its key goes in its own header. */
export function elevenLabsHeaders(target: ProviderTarget): Record<string, string> {
  return { "content-type": "application/json", ...elevenLabsKeyHeader(target) };
}

/**
 * What the person must do before a cloned voice speaks, when the provider says it must be verified
 * first — said beside the voice rather than in its name, so a line that fails on it is no surprise.
 */
export const verifyFirst = (target: ProviderTarget): string =>
  `Verify this voice on ${target.name} before a line is spoken with it.`;

/**
 * The `output_format` a line is asked for, from the endpoint's format, rate and bitrate, and what
 * `shape` gives the rest: for WAV, 24 kHz, which every ElevenLabs plan may ask for.
 */
export function elevenLabsOutputFormat(
  input: Pick<SpeechInput, "encoding" | "sampleRate">,
  shape: SpeechProviderShape = elevenlabs,
): string {
  const { format, bitrate } = input.encoding;
  const defaults = formatDefaults(shape, format);
  const rate = input.sampleRate ?? defaults.rate;
  if (format === "mp3") return `mp3_${rate}_${bitrate ?? defaults.bitrate}`;
  return `wav_${rate}`;
}

/** The characters an answer's `character-cost` header counts, when it holds a count. */
function characterCost(res: Response): SpeechUsage | null {
  const header = res.headers.get("character-cost")?.trim() ?? "";
  const characters = /^\d+$/.test(header) ? Number(header) : 0;
  return characters > 0 ? normalizeSpeechUsage({ characters }, "plain") : null;
}

/**
 * One line as either API takes it, `shape` saying which; `instructions` is what goes beside the
 * words, or nothing.
 */
export function elevenLabsRequest(
  shape: SpeechProviderShape,
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  instructions: string,
): SpeechRequest {
  const { format } = input.encoding;
  const query = new URLSearchParams({ output_format: elevenLabsOutputFormat(input, shape) });
  const path = shape.requestPath(target.model, encodeURIComponent(voice));
  return {
    url: `${elevenLabsRoot(target.baseUrl)}${path}?${query}`,
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
): Promise<EndpointProbe> {
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
  async clone(target, request, signal, options) {
    const form = new FormData();
    form.set("name", request.title);
    for (const sample of request.samples) form.append("files", sample.blob, sample.name);
    const res = await call(
      target,
      `${elevenLabsRoot(target.baseUrl)}/voices/add`,
      // no content-type: the multipart boundary is the form's to write
      { method: "POST", headers: elevenLabsKeyHeader(target), body: form },
      { signal, ...options },
    );
    const body = (await res.json().catch(() => null)) as {
      voice_id?: unknown;
      requires_verification?: unknown;
    } | null;
    if (typeof body?.voice_id !== "string" || !body.voice_id)
      throw new ProviderError(
        `${target.name} answered ${res.status} without the new voice's id`,
        res.status,
        false,
      );
    return {
      id: body.voice_id,
      label: request.title,
      gender: "?",
      ...(body.requires_verification === true ? { warning: verifyFirst(target) } : {}),
    };
  },

  // ElevenLabs has no instructions field, so nothing is sent beside the words, and none is billed
  request: (input, target, voice) => elevenLabsRequest(elevenlabs, input, target, voice, ""),
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
