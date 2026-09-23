// What voices a speech endpoint offers, asked of the endpoint itself.
//
// Two catalogues, because Fish Audio has two: the account's own library (`self=true`), which is
// what "Fetch from server" merges in, and the public catalogue anyone's voice can be picked from,
// which the Voices tab searches a page at a time. A Fish voice's id is the model's `_id` — the
// `reference_id` a line is spoken with — so a voice found either way is ready to use.
//
// An OpenAI-shaped endpoint has no standard way to say what voices it has. OpenAI itself lists its
// built-in voices only in its documentation, so for `api.openai.com` the list is that one, written
// down here. The local servers that copy OpenAI's API mostly answer `GET /audio/voices`
// (Kokoro-FastAPI does), so anything else is asked that, and a server that does not answer it is
// said to have no list rather than to have none.
//
// Listing spends nothing and changes nothing, which is why the route calls this whatever
// `SPEECH_PROVIDER` says: the fakes stand in for requests that cost money, and this is not one.
import {
  fishApiRoot,
  fishVoiceLabel,
  isFishAudio,
  voicesFromFishModels,
  type FishModel,
} from "@/lib/endpointShapes";
import type { Gender, Voice } from "@/types";
import { call, jsonHeaders, ProviderError, requireKey, type CallOptions } from "~/providers/http";
import type { ProviderTarget } from "~/providers/target";

/** Which catalogue to read, and for the public one what to look for. */
export interface VoiceQuery {
  /** `library`: the account's own voices, all of them; `public`: one page of a search */
  source: "library" | "public";
  /** words in the title; a 32-character Fish id finds that one voice */
  query?: string;
  /** a language code the voices must speak, e.g. `en` */
  language?: string;
  /** 1-based */
  page?: number;
}

/** One answer: the voices, and where they sit in the whole list. */
export interface VoicePage {
  voices: Voice[];
  /** how many the provider says match, which may count some that are not voices */
  total: number;
  page: number;
  hasMore: boolean;
}

/** The port the route lists through; a test hands over one that answers from memory. */
export interface VoiceLister {
  list(target: ProviderTarget, query: VoiceQuery, signal: AbortSignal): Promise<VoicePage>;
}

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

/**
 * OpenAI's built-in voices, from the `voice` parameter of
 * https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create —
 * there is no endpoint that lists them. OpenAI gives none of them a gender.
 */
export const OPENAI_VOICES: readonly string[] = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
];

const isOpenAi = (t: ProviderTarget): boolean =>
  /(^|\/\/)api\.openai\.com(\/|:|$)/i.test(t.baseUrl);

export function endpointVoiceLister(options: Omit<CallOptions, "signal"> = {}): VoiceLister {
  const get = async <T>(target: ProviderTarget, url: string, signal: AbortSignal): Promise<T> => {
    const res = await call(
      target,
      url,
      { method: "GET", headers: jsonHeaders(target) },
      { signal, ...options },
    );
    try {
      return (await res.json()) as T;
    } catch {
      throw new ProviderError(
        `${target.name} answered ${url} with something that is not JSON`,
        res.status,
        false,
      );
    }
  };

  async function fishLibrary(target: ProviderTarget, signal: AbortSignal): Promise<VoicePage> {
    const root = fishApiRoot(target.baseUrl);
    const models: FishModel[] = [];
    let more = true;
    for (let page = 1; more && page <= LIBRARY_PAGES; page++) {
      const q = new URLSearchParams({
        self: "true",
        page_size: String(LIBRARY_PAGE),
        page_number: String(page),
      });
      const body = await get<FishModelList>(target, `${root}/model?${q}`, signal);
      const items = body.items ?? [];
      models.push(...items);
      // `has_more` may be null; then a full page is the only hint that another follows
      more = (body.has_more ?? items.length === LIBRARY_PAGE) && items.length > 0;
    }
    const voices = voicesFromFishModels(models, fishVoiceLabel);
    // `hasMore` here means the cap was reached with the library still going
    return { voices, total: voices.length, page: 1, hasMore: more };
  }

  async function fishPublic(
    target: ProviderTarget,
    query: VoiceQuery,
    signal: AbortSignal,
  ): Promise<VoicePage> {
    const root = fishApiRoot(target.baseUrl);
    const words = query.query?.trim() ?? "";
    if (FISH_ID.test(words)) {
      // An id is not a title, and the search would not find it; ask for the model itself.
      try {
        const model = await get<FishModel>(target, `${root}/model/${words.toLowerCase()}`, signal);
        const voices = voicesFromFishModels([model], fishVoiceLabel);
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
    const body = await get<FishModelList>(target, `${root}/model?${q}`, signal);
    const items = body.items ?? [];
    return {
      // Fish cannot be asked for TTS models only, so the others are dropped from each page
      voices: voicesFromFishModels(items, fishVoiceLabel),
      total: body.total ?? items.length,
      page,
      hasMore: body.has_more ?? page * PUBLIC_PAGE < (body.total ?? 0),
    };
  }

  async function openAiShaped(target: ProviderTarget, signal: AbortSignal): Promise<VoicePage> {
    if (isOpenAi(target)) {
      const voices = OPENAI_VOICES.map((id) => ({
        id,
        label: titleCase(id),
        gender: "?" as const,
      }));
      return { voices, total: voices.length, page: 1, hasMore: false };
    }
    const url = `${target.baseUrl}/audio/voices`;
    let body: unknown;
    try {
      body = await get<unknown>(target, url, signal);
    } catch (e) {
      if (e instanceof ProviderError && [404, 405, 501].includes(e.status))
        throw new ProviderError(
          `${target.name} has no voice list: GET ${url} answered ${e.status}. ` +
            "Add its voices by id instead.",
          e.status,
          false,
        );
      throw e;
    }
    const voices = voicesFromList(body);
    if (!voices)
      throw new ProviderError(
        `${target.name} answered GET ${url}, but not with a list of voices this app can read. ` +
          "Add its voices by id instead.",
        200,
        false,
      );
    return { voices, total: voices.length, page: 1, hasMore: false };
  }

  return {
    async list(target, query, signal) {
      requireKey(target);
      const fish = isFishAudio(target);
      if (query.source === "public") {
        if (!fish)
          throw new ProviderError(
            `${target.name} has no public voice catalogue to search; only Fish Audio has one.`,
            0,
            false,
          );
        return fishPublic(target, query, signal);
      }
      return fish ? fishLibrary(target, signal) : openAiShaped(target, signal);
    },
  };
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Kokoro names a voice by accent and gender, `af_bella` being an American woman, and that second
 * letter is the only gender these servers give. A name in any other form says nothing.
 */
function genderOfName(id: string): Gender {
  const m = /^[a-z]([fm])_/i.exec(id);
  return m ? (m[1].toLowerCase() as Gender) : "?";
}

/**
 * A voice list in the shapes the OpenAI-compatible servers answer with: `{voices: [...]}` or a bare
 * array, of names or of objects naming themselves `id`, `voice_id` or `name`. Null when it is none
 * of those.
 */
function voicesFromList(body: unknown): Voice[] | null {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { voices?: unknown }).voices)
      ? (body as { voices: unknown[] }).voices
      : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : null;
  if (!list) return null;
  const voices: Voice[] = [];
  for (const entry of list) {
    const rec = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const id = typeof entry === "string" ? entry : (rec?.id ?? rec?.voice_id ?? rec?.name);
    if (typeof id !== "string" || !id.trim()) continue;
    const name = typeof rec?.name === "string" && rec.name.trim() ? rec.name.trim() : id;
    voices.push({ id: id.trim(), label: name, gender: genderOfName(id) });
  }
  return voices;
}
