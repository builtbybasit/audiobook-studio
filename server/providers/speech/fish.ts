// Fish Audio's own API (https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech):
// `POST /v1/tts`, the model in a `model` header, the voice as a `reference_id`. No instructions
// field: S2 cues go inline in the text, written from the endpoint's Expressions tab
// (https://docs.fish.audio/developer-guide/core-features/emotions), so `direction` is not sent.
import type { FoundVoice } from "@/types";
import {
  fishApiRoot,
  fishModelsUrl,
  fishSampleOf,
  fishVoiceLabel,
  voicesFromFishModels,
  type FishModel,
} from "@/lib/endpointShapes";
import { fish, FISH_MODELS } from "@/lib/providers/fish";
import { authHeaders, call, jsonHeaders, ProviderError } from "~/providers/http";
import type { ProviderTarget } from "~/providers/target";
import { getJson, type SpeechWire } from "~/providers/speech/wire";

/** `GET /model`'s answer. */
interface FishModelList {
  total: number;
  items: FishModel[];
  has_more?: boolean | null;
}

/** Fish's maximum page size; a library is read up to LIBRARY_PAGES. */
const LIBRARY_PAGE = 100;
const LIBRARY_PAGES = 10;
export const PUBLIC_PAGE = 30;

/** Pasted into the search, it asks for that one voice. */
const FISH_ID = /^[0-9a-f]{32}$/i;

/** On the host, whatever path the base URL was saved with. */
export function fishTtsUrl(target: ProviderTarget): string {
  return `${new URL(target.baseUrl).origin}/v1${fish.requestPath(target.model)}`;
}

/**
 * Empty when Fish documents the model. Fish answers an unknown one with the paid `s2.1-pro`, which a
 * typo'd free endpoint would be silently billed at.
 */
function unknownModel(target: ProviderTarget): string {
  if ((FISH_MODELS as readonly string[]).includes(target.model)) return "";
  return (
    `“${target.model}” is not a model Fish Audio documents (${FISH_MODELS.join(", ")}), ` +
    "and Fish answers any other with its paid s2.1-pro. Change the model on the Endpoints page."
  );
}

/** Each with Fish's free recording of it, where there is one. */
const publicVoices = (models: FishModel[]): FoundVoice[] => {
  const byId = new Map(models.map((m) => [m._id, m]));
  return voicesFromFishModels(models, fishVoiceLabel).map((v) => {
    const sample = fishSampleOf(byId.get(v.id)!);
    return sample ? { ...v, sample } : v;
  });
};

export const fishWire: SpeechWire = {
  // https://docs.fish.audio/api-reference/endpoint/model/create-model. `texts` go only when every
  // sample has one: without them Fish transcribes, and an empty one would read as silence.
  async clone(target, request, signal, options) {
    const form = new FormData();
    form.set("type", "tts");
    form.set("title", request.title);
    form.set("train_mode", "fast");
    form.set("visibility", "private");
    for (const sample of request.samples) form.append("voices", sample.blob, sample.name);
    if (request.samples.every((s) => s.transcript))
      for (const sample of request.samples) form.append("texts", sample.transcript!);
    const res = await call(
      target,
      `${fishApiRoot(target.baseUrl)}/model`,
      // no content-type: the multipart boundary is the form's to write
      { method: "POST", headers: authHeaders(target), body: form },
      { signal, ...options },
    );
    const body = (await res.json().catch(() => null)) as {
      _id?: unknown;
      title?: unknown;
    } | null;
    if (typeof body?._id !== "string" || !body._id)
      throw new ProviderError(
        `${target.name} answered ${res.status} without the new voice's id`,
        res.status,
        false,
      );
    const title =
      typeof body.title === "string" && body.title.trim() ? body.title.trim() : request.title;
    return { id: body._id, label: title, gender: "?" };
  },

  request(input, target, voice) {
    const problem = unknownModel(target);
    if (problem) throw new ProviderError(`${target.name}: ${problem}`, 0, false);
    const { sampleRate } = input;
    const { format, bitrate } = input.encoding;
    return {
      url: fishTtsUrl(target),
      init: {
        method: "POST",
        headers: { ...jsonHeaders(target), model: target.model },
        body: JSON.stringify({
          text: input.text,
          reference_id: voice,
          format,
          ...(bitrate != null && format !== "wav" ? { [`${format}_bitrate`]: bitrate } : {}),
          ...(sampleRate != null ? { sample_rate: sampleRate } : {}),
          // Fish's default, pinned: it reads "1997" and "£3.50" as words
          normalize: true,
        }),
      },
      format,
      text: input.text,
      // no instructions field, so none are billed
      instructions: "",
    };
  },

  /** Lists the library: proves key and host for free, and checks the model. */
  async probe(target, signal, options) {
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
    const problem = unknownModel(target);
    if (problem)
      return {
        ok: false,
        message: `Answered in ${ms} ms and the key was accepted, but ${problem}`,
        ms,
      };
    return {
      ok: true,
      message:
        `Answered in ${ms} ms; the key was accepted` +
        (total == null ? "" : ` and your library holds ${total} voice${total === 1 ? "" : "s"}`),
      ms,
    };
  },

  async voices(target, signal, options) {
    const root = fishApiRoot(target.baseUrl);
    const models: FishModel[] = [];
    let more = true;
    for (let page = 1; more && page <= LIBRARY_PAGES; page++) {
      const q = new URLSearchParams({
        self: "true",
        page_size: String(LIBRARY_PAGE),
        page_number: String(page),
      });
      const body = await getJson<FishModelList>(
        target,
        `${root}/model?${q.toString()}`,
        jsonHeaders(target),
        signal,
        options,
      );
      const items = body.items ?? [];
      models.push(...items);
      // `has_more` may be null; then a full page hints another follows
      more = (body.has_more ?? items.length === LIBRARY_PAGE) && items.length > 0;
    }
    const voices = voicesFromFishModels(models, fishVoiceLabel);
    // `hasMore`: the cap was reached with the library still going
    return { voices, total: voices.length, page: 1, hasMore: more };
  },

  async recording(target, voice, signal, options) {
    if (!FISH_ID.test(voice)) return null;
    try {
      const model = await getJson<FishModel>(
        target,
        `${fishApiRoot(target.baseUrl)}/model/${voice.toLowerCase()}`,
        jsonHeaders(target),
        signal,
        options,
      );
      return fishSampleOf(model);
    } catch (e) {
      // gone, or someone else's private voice
      if (e instanceof ProviderError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  },

  async search(target, query, signal, options) {
    const root = fishApiRoot(target.baseUrl);
    const words = query.query?.trim() ?? "";
    if (FISH_ID.test(words)) {
      // the search matches titles, not ids
      try {
        const model = await getJson<FishModel>(
          target,
          `${root}/model/${words.toLowerCase()}`,
          jsonHeaders(target),
          signal,
          options,
        );
        const voices = publicVoices([model]);
        return { voices, total: voices.length, page: 1, hasMore: false };
      } catch (e) {
        if (e instanceof ProviderError && e.status === 404)
          return { voices: [], total: 0, page: 1, hasMore: false };
        throw e;
      }
    }
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const q = new URLSearchParams({
      page_size: String(PUBLIC_PAGE),
      page_number: String(page),
      sort_by: "score",
    });
    if (words) q.set("title", words);
    if (query.language?.trim()) q.set("language", query.language.trim());
    const body = await getJson<FishModelList>(
      target,
      `${root}/model?${q.toString()}`,
      jsonHeaders(target),
      signal,
      options,
    );
    const items = body.items ?? [];
    return {
      // Fish cannot filter to TTS models, so the others are dropped here
      voices: publicVoices(items),
      total: body.total ?? items.length,
      page,
      hasMore: body.has_more ?? page * PUBLIC_PAGE < (body.total ?? 0),
    };
  },
};
