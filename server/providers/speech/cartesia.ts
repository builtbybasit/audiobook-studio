// Cartesia's `POST /tts/bytes` (https://docs.cartesia.ai/api-reference/tts/bytes), with a
// `Cartesia-Version` header. It reports no usage, so the ledger counts the characters sent, billed
// only on success (errors consume no credits). No instructions field: Sonic takes inline tags.
import type { Voice } from "@/types";
import { cartesia } from "@/lib/providers/cartesia";
import { formatDefaults } from "@/lib/providers/types";
import { authHeaders, call, jsonHeaders, ProviderError } from "~/providers/http";
import type { SpeechCallOptions } from "~/providers/send";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import type { SpeechWire } from "~/providers/speech/wire";

/** The API version Cartesia's reference names. */
export const CARTESIA_VERSION = "2026-08-14";

const VOICE_PAGE = 100;
const VOICE_PAGES = 10;

/** The host root, whatever path the base URL was saved with. */
export const cartesiaRoot = (baseUrl: string): string => new URL(baseUrl).origin;

export function cartesiaHeaders(target: ProviderTarget): Record<string, string> {
  return { ...jsonHeaders(target), "cartesia-version": CARTESIA_VERSION };
}

/** Exported for the tests. An MP3's bitrate is in bits per second. */
export function cartesiaBody(
  input: Pick<SpeechInput, "text" | "sampleRate" | "encoding" | "speed">,
  model: string,
  voice: string,
): Record<string, unknown> {
  const { format, bitrate } = input.encoding;
  const defaults = formatDefaults(cartesia, format);
  const sample_rate = input.sampleRate ?? defaults.rate;
  return {
    model_id: model,
    transcript: input.text,
    voice: { id: voice },
    output_format:
      format === "mp3"
        ? { container: "mp3", sample_rate, bit_rate: (bitrate ?? defaults.bitrate!) * 1000 }
        : { container: "wav", encoding: "pcm_s16le", sample_rate },
    ...(input.speed != null ? { generation_config: { speed: input.speed } } : {}),
  };
}

async function voicePage(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
  limit: number,
  after?: string,
  owned = false,
): Promise<{
  voices: { id: string; name: string; gender: string }[];
  hasMore: boolean;
}> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (after) q.set("starting_after", after);
  if (owned) q.set("is_owner", "true");
  const res = await call(
    target,
    `${cartesiaRoot(target.baseUrl)}/voices?${q.toString()}`,
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
      gender: typeof v.gender === "string" ? v.gender : "",
    }));
  return { voices, hasMore: body?.has_more === true };
}

const genderOf = (gender: string): Voice["gender"] =>
  gender === "masculine"
    ? "m"
    : gender === "feminine"
      ? "f"
      : gender === "gender_neutral"
        ? "n"
        : "?";

/** Cursor-paged by the last id; `more` when the cap was reached. */
async function voicesListed(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
  owned: boolean,
): Promise<{ voices: Voice[]; more: boolean }> {
  const voices: Voice[] = [];
  let more = true;
  for (let page = 1; more && page <= VOICE_PAGES; page++) {
    const found = await voicePage(target, signal, options, VOICE_PAGE, voices.at(-1)?.id, owned);
    for (const v of found.voices)
      voices.push({ id: v.id, label: v.name, gender: genderOf(v.gender) });
    more = found.hasMore && found.voices.length > 0;
  }
  return { voices, more };
}

export const cartesiaWire: SpeechWire = {
  // https://docs.cartesia.ai/api-reference/voices/clone
  async clone(target, request, signal, options) {
    const form = new FormData();
    form.set("name", request.title);
    form.set("language", "en");
    form.set("access", "private");
    // the route enforces `cloning.maxSamples` (1)
    const [sample] = request.samples;
    form.set("clip", sample.blob, sample.name);
    const res = await call(
      target,
      `${cartesiaRoot(target.baseUrl)}/voices/clone`,
      // no content-type: the multipart boundary is the form's to write
      {
        method: "POST",
        headers: { ...authHeaders(target), "cartesia-version": CARTESIA_VERSION },
        body: form,
      },
      { signal, ...options },
    );
    const body = (await res.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
    if (typeof body?.id !== "string" || !body.id)
      throw new ProviderError(
        `${target.name} answered ${res.status} without the new voice's id`,
        res.status,
        false,
      );
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : request.title;
    return { id: body.id, label: name, gender: "?" };
  },

  request(input, target, voice) {
    return {
      url: `${cartesiaRoot(target.baseUrl)}${cartesia.requestPath(target.model)}`,
      init: {
        method: "POST",
        headers: cartesiaHeaders(target),
        body: JSON.stringify(cartesiaBody(input, target.model, voice)),
      },
      format: input.encoding.format,
      text: input.text,
      // no instructions field, so none are billed
      instructions: "",
    };
  },

  /** Lists one voice: needs the key, costs no credit. */
  async probe(target, signal, options) {
    const started = Date.now();
    await voicePage(target, signal, options, 1);
    const ms = Date.now() - started;
    return { ok: true, message: `Answered in ${ms} ms; the key was accepted`, ms };
  },

  async voices(target, signal, options) {
    const all = await voicesListed(target, signal, options, false);
    if (!all.more) return { voices: all.voices, total: all.voices.length, page: 1, hasMore: false };
    // Cartesia's own run to hundreds; past the cap, add the account's so a clone is never lost
    const listed = new Set(all.voices.map((v) => v.id));
    const own = await voicesListed(target, signal, options, true);
    const voices = [...all.voices, ...own.voices.filter((v) => !listed.has(v.id))];
    return { voices, total: voices.length, page: 1, hasMore: true };
  },
};
