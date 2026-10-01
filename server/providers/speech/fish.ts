// A line spoken by Fish Audio, as its own API takes it, and the voices Fish can list.
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
// The `model` header is held to the models Fish documents before a request, because Fish does not
// refuse one it does not know: it answers it with the paid `s2.1-pro`. An endpoint priced as the
// free `s2.1-pro-free` with a typo in its model would otherwise be billed at s2.1-pro's rate while
// the ledger said nothing.
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
//
// A voice is cloned with `POST /model` on the API's host
// (https://docs.fish.audio/api-reference/endpoint/model/create-model), as multipart, with
// `type=tts`, a title, `train_mode=fast` — the model is usable at once — and 1 to 20 samples under
// `voices`. `texts` are the samples' transcripts, one per sample in the same order, and go only
// when every sample has one: with no `texts` Fish transcribes the samples itself, and a sample
// with an empty text in its place would be read as saying nothing. The voice is made private: only
// the account that made it can use it. The answer is the new model, whose `_id` is the
// `reference_id` a line is spoken with.
//
// Voices come from two catalogues, because Fish has two: the account's own library (`self=true`),
// which is what "Fetch from server" merges in, and the public catalogue anyone's voice can be
// picked from, which the Voices tab searches a page at a time. A Fish voice's id is the model's
// `_id` — the `reference_id` a line is spoken with — so a voice found either way is ready to use.
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

/** What Fish's `GET /model` answers; see `fish-models` in the docs. */
interface FishModelList {
  total: number;
  items: FishModel[];
  has_more?: boolean | null;
}

/** Fish takes up to 100 a page. A library is read whole, up to this many pages. */
const LIBRARY_PAGE = 100;
const LIBRARY_PAGES = 10;
/** A page of public results: enough to scroll, few enough to read. */
export const PUBLIC_PAGE = 30;

/** A Fish model id: 32 hex characters. Pasted into the search, it asks for that one voice. */
const FISH_ID = /^[0-9a-f]{32}$/i;

/** Fish serves TTS at `/v1/tts` on the API's host, whatever path the base URL was saved with. */
export function fishTtsUrl(target: ProviderTarget): string {
  return `${new URL(target.baseUrl).origin}/v1${fish.requestPath(target.model)}`;
}

/** Why the endpoint's model would not be the one Fish speaks with; empty when it would be. */
function unknownModel(target: ProviderTarget): string {
  if ((FISH_MODELS as readonly string[]).includes(target.model)) return "";
  return (
    `“${target.model}” is not a model Fish Audio documents (${FISH_MODELS.join(", ")}), ` +
    "and Fish answers any other with its paid s2.1-pro. Change the model on the Endpoints page."
  );
}

/** Public voices, each with Fish's own recording of it where there is one — free to play. */
const publicVoices = (models: FishModel[]): FoundVoice[] => {
  const byId = new Map(models.map((m) => [m._id, m]));
  return voicesFromFishModels(models, fishVoiceLabel).map((v) => {
    const sample = fishSampleOf(byId.get(v.id)!);
    return sample ? { ...v, sample } : v;
  });
};

export const fishWire: SpeechWire = {
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
          normalize: true,
        }),
      },
      format,
      text: input.text,
      // Fish takes no instructions beside the words (see the header), so none are billed
      instructions: "",
    };
  },

  /**
   * The user's own voice library, which needs the key and costs nothing, where a spoken word would
   * spend credit. It proves the key and the host; the model header is held to Fish's list here.
   */
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
        `${root}/model?${q}`,
        jsonHeaders(target),
        signal,
        options,
      );
      const items = body.items ?? [];
      models.push(...items);
      // `has_more` may be null; then a full page is the only hint that another follows
      more = (body.has_more ?? items.length === LIBRARY_PAGE) && items.length > 0;
    }
    const voices = voicesFromFishModels(models, fishVoiceLabel);
    // `hasMore` here means the cap was reached with the library still going
    return { voices, total: voices.length, page: 1, hasMore: more };
  },

  async recording(target, voice, signal, options) {
    // a Fish voice is a model, asked for by its id; anything else cannot be one
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
      // gone, or someone else's private voice: no recording, and the endpoint renders one
      if (e instanceof ProviderError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  },

  async search(target, query, signal, options) {
    const root = fishApiRoot(target.baseUrl);
    const words = query.query?.trim() ?? "";
    if (FISH_ID.test(words)) {
      // An id is not a title, and the search would not find it; ask for the model itself.
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
      `${root}/model?${q}`,
      jsonHeaders(target),
      signal,
      options,
    );
    const items = body.items ?? [];
    return {
      // Fish cannot be asked for TTS models only, so the others are dropped from each page
      voices: publicVoices(items),
      total: body.total ?? items.length,
      page,
      hasMore: body.has_more ?? page * PUBLIC_PAGE < (body.total ?? 0),
    };
  },
};
