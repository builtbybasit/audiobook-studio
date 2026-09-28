// A line spoken by Cartesia, through `POST /tts/bytes`.
//
// Cartesia is its own shape (https://docs.cartesia.ai/api-reference/tts/bytes): a bearer key, a
// `Cartesia-Version` header naming the API version the request is written against, and a JSON
// body of `model_id`, `transcript`, `voice: {id}` and an `output_format` that names the container,
// the sample encoding and the rate — and, for an MP3, the bitrate in bits a second. The answer is
// the audio itself, read as every other body of audio is (`audioAnswer`). Cartesia reports no
// usage, so the ledger counts the characters that were sent, which is what it bills on — and only
// for a request that succeeded: its pricing page says errors consume no credits.
//
// Only the words are sent. Sonic takes delivery as tags in the transcript — `<break time="1s"/>`,
// `<emotion value="calm"/>` — which is what the endpoint's Expressions tab is for.
//
// Voices are Cartesia's own and the account's, `GET /voices` a hundred a page, each page after
// the last voice of the one before. Cartesia's own run to several hundred, so a list cut off at the
// cap is followed by the account's alone (`is_owner=true`): a voice cloned here is never lost behind
// the catalogue.
//
// A voice is cloned with `POST /voices/clone` (https://docs.cartesia.ai/api-reference/voices/clone),
// as multipart under the same key and version: one `clip`, a `name`, the `language` it was recorded
// in — English, the only language this app's books are in — and `access=private`, the default, set
// so it cannot drift. The answer is the new voice, whose `id` is what a line is spoken with; it
// says nothing of gender.
import type { Voice } from "@/types";
import { authHeaders, call, jsonHeaders, ProviderError } from "~/providers/http";
import type { SpeechCallOptions } from "~/providers/send";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import type { SpeechWire } from "~/providers/speech/wire";

/** The API version every request is written against, the one Cartesia's reference names. */
export const CARTESIA_VERSION = "2026-08-14";

/** What this app asks for when the endpoint names no rate: the rate Cartesia's example uses. */
const DEFAULT_RATE = 44100;
const DEFAULT_MP3_KBPS = 128;

/** A voice list is read a hundred a page, up to this many pages. */
const VOICE_PAGE = 100;
const VOICE_PAGES = 10;

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

/** One page of voices from `GET /voices`: Cartesia's own and the account's. */
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

/** Its gender is `masculine`, `feminine` or `gender_neutral`. */
const genderOf = (gender: string): Voice["gender"] =>
  gender === "masculine"
    ? "m"
    : gender === "feminine"
      ? "f"
      : gender === "gender_neutral"
        ? "n"
        : "?";

/** Every voice `GET /voices` answers, page after page up to the cap; `more` when it was reached. */
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
  async clone(target, request, signal, options) {
    const form = new FormData();
    form.set("name", request.title);
    form.set("language", "en");
    form.set("access", "private");
    // one clip: the route holds a clone to `cloning.maxClips` before it gets here
    const [clip] = request.clips;
    form.set("clip", clip.blob, clip.name);
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
      url: `${cartesiaRoot(target.baseUrl)}/tts/bytes`,
      init: {
        method: "POST",
        headers: cartesiaHeaders(target),
        body: JSON.stringify(cartesiaBody(input, target.model, voice)),
      },
      format: input.encoding.format,
      text: input.text,
      // no instructions field (see the header), so none are billed
      instructions: "",
    };
  },

  /** One voice from its list, which needs the key and costs no credit. */
  async probe(target, signal, options) {
    const started = Date.now();
    await voicePage(target, signal, options, 1);
    const ms = Date.now() - started;
    return { ok: true, message: `Answered in ${ms} ms; the key was accepted`, ms };
  },

  async voices(target, signal, options) {
    const all = await voicesListed(target, signal, options, false);
    if (!all.more) return { voices: all.voices, total: all.voices.length, page: 1, hasMore: false };
    // cut off at the cap: the account's own, which is where a clone of this app's is, come too
    const listed = new Set(all.voices.map((v) => v.id));
    const own = await voicesListed(target, signal, options, true);
    const voices = [...all.voices, ...own.voices.filter((v) => !listed.has(v.id))];
    return { voices, total: voices.length, page: 1, hasMore: true };
  },
};
