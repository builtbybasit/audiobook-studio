// ElevenLabs' API (https://elevenlabs.io/docs/api-reference/text-to-speech/convert): the voice in
// the path, `xi-api-key`, and `output_format` naming rate and bitrate (`mp3_44100_128`). No
// instructions field: `eleven_v3` takes inline `[whispers]` tags. BreezeBlue copies all of this
// (`breezeblue.ts`).
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

const VOICE_PAGE = 100;
export const VOICE_PAGES = 10;

/** `/v1` on the host, whatever path the base URL was saved with. */
export const elevenLabsRoot = (baseUrl: string): string => `${new URL(baseUrl).origin}/v1`;

/** Alone, for a body that sets its own content type (a form). */
export function elevenLabsKeyHeader(target: ProviderTarget): Record<string, string> {
  return target.apiKey ? { "xi-api-key": target.apiKey } : {};
}

export function elevenLabsHeaders(target: ProviderTarget): Record<string, string> {
  return { "content-type": "application/json", ...elevenLabsKeyHeader(target) };
}

/** For a clone that `requires_verification`, shown beside the voice. */
export const verifyFirst = (target: ProviderTarget): string =>
  `Verify this voice on ${target.name} before a line is spoken with it.`;

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

/**
 * `character-cost`: read by ElevenLabs' stitching guide, though the reference does not list it.
 * Only a real count is kept; a blank read as 0 would price the line at nothing.
 */
function characterCost(res: Response): SpeechUsage | null {
  const header = res.headers.get("character-cost")?.trim() ?? "";
  const characters = /^\d+$/.test(header) ? Number(header) : 0;
  return characters > 0 ? normalizeSpeechUsage({ characters }, "plain") : null;
}

/** For ElevenLabs or BreezeBlue, `shape` saying which. */
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
    url: `${elevenLabsRoot(target.baseUrl)}${path}?${query.toString()}`,
    init: {
      method: "POST",
      headers: elevenLabsHeaders(target),
      body: JSON.stringify({
        text: input.text,
        model_id: target.model,
        ...(instructions ? { instructions } : {}),
        ...(input.speed != null ? { voice_settings: { speed: input.speed } } : {}),
      }),
    },
    format,
    text: input.text,
    // as sent, and so as the ledger counts
    instructions,
    async read(res, { signal, counted }) {
      counted(characterCost(res));
      return audioAnswer(target, res, signal, format);
    },
  };
}

/** Test button for either API: `GET /v1/models` proves the key for free and checks the model. */
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
  // Instant Voice Cloning (https://elevenlabs.io/docs/api-reference/voices/ivc/create). Background
  // noise removal stays off (the docs: it "can make the quality worse" on clean samples). A voice
  // that `requires_verification` is still returned: failing would orphan it on the account.
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

  // no instructions field, so none are billed
  request: (input, target, voice) => elevenLabsRequest(elevenlabs, input, target, voice, ""),
  probe: modelsProbe,

  /**
   * `GET /v2/voices` answers every kind with no `voice_type`
   * (https://elevenlabs.io/docs/api-reference/voices/search). Gender is a free-form label.
   */
  async voices(target, signal, options) {
    const voices: Voice[] = [];
    let token: string | null = null;
    let more = true;
    for (let page = 1; more && page <= VOICE_PAGES; page++) {
      const q = new URLSearchParams({ page_size: String(VOICE_PAGE) });
      if (token) q.set("next_page_token", token);
      const res = await call(
        target,
        `${new URL(elevenLabsRoot(target.baseUrl)).origin}/v2/voices?${q.toString()}`,
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
        const gender = (typeof v.labels?.gender === "string" ? v.labels.gender : "").toLowerCase();
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
