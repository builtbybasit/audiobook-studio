// OpenAI's `/audio/speech` (https://platform.openai.com/docs/api-reference/audio/createSpeech), for
// OpenAI and the servers that copy it (Kokoro-FastAPI, Orpheus/Piper bridges, vLLM-Omni). It takes
// no bitrate or rate (`encodingProblems` refuses them). A compatible server may also list voices
// (`GET /audio/voices`), make them, and take batches (`batch.ts`); OpenAI itself does neither.
import type { Gender, MadeVoice, Voice } from "@/types";
import { compatible, openai } from "@/lib/providers/openai";
import { authHeaders, call, jsonHeaders, ProviderError } from "~/providers/http";
import type { CloneRequest } from "~/providers/clone";
import type { SpeechCallOptions } from "~/providers/send";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { batchCapabilities, sendBatch, takesBatches } from "~/providers/speech/batch";
import { getJson, onePage, type SpeechWire } from "~/providers/speech/wire";

/** OpenAI: instructions "do not work with tts-1 or tts-1-hd". */
const NO_INSTRUCTIONS = /^tts-1(-hd)?$/i;

/** OpenAI's custom voice ids, sent as `{ id }` where a built-in voice is a bare name. */
const CUSTOM_VOICE = /^voice_/;

/**
 * From the `voice` parameter of
 * https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create;
 * no endpoint lists them, and none has a gender.
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

function speechBody(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  instructions: string,
  hosted: boolean,
): Record<string, unknown> {
  return {
    model: target.model,
    input: input.text,
    voice: hosted && CUSTOM_VOICE.test(voice) ? { id: voice } : voice,
    response_format: input.encoding.format,
    ...(instructions ? { instructions } : {}),
    ...(input.speed != null ? { speed: input.speed } : {}),
  };
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Kokoro's second letter is the gender (`af_bella`); any other name says nothing. */
function genderOfName(id: string): Gender {
  const m = /^[a-z]([fm])_/i.exec(id);
  return m ? (m[1].toLowerCase() as Gender) : "?";
}

/**
 * `{voices}`, `{data}` or a bare array, of names or objects with `id`, `voice_id` or `name`. Null
 * when it is none of those.
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
    const gender = rec?.gender === "f" || rec?.gender === "m" ? rec.gender : genderOfName(id);
    voices.push({ id: id.trim(), label: name, gender });
  }
  return voices;
}

/**
 * `POST /audio/voices` per the batch speech API, for an endpoint that says its server makes voices
 * (`makesVoices`). OpenAI's own voice creation is another API, not spoken here.
 */
async function makeVoice(
  target: ProviderTarget,
  request: CloneRequest,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<MadeVoice> {
  const [sample] = request.samples;
  const form = new FormData();
  form.set("name", request.title);
  form.set("samples", sample.blob, sample.name);
  if (sample.transcript) form.set("transcript", sample.transcript);
  const url = `${target.baseUrl}/audio/voices`;
  let res: Response;
  try {
    // no content-type: the multipart boundary is the form's to write
    res = await call(
      target,
      url,
      { method: "POST", headers: authHeaders(target), body: form },
      { signal, ...options },
    );
  } catch (e) {
    if (e instanceof ProviderError && [404, 405, 501].includes(e.status))
      throw new ProviderError(
        `${target.name} makes no voices: POST ${url} answered ${e.status}. ` +
          "Turn off “Make voices on this server” on its Voices tab.",
        e.status,
        false,
      );
    throw e;
  }
  // a made voice must name its id, unlike a list entry
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
  const [voice] = typeof body?.id === "string" ? (voicesFromList([body]) ?? []) : [];
  if (!voice)
    throw new ProviderError(
      `${target.name} answered ${res.status} without the new voice's id`,
      res.status,
      false,
    );
  return voice;
}

/** `hosted` is OpenAI's own API. */
function openaiShaped(hosted: boolean): SpeechWire {
  const shape = hosted ? openai : compatible;
  return {
    request(input, target, voice) {
      // as sent, and so as the ledger counts; a compatible server ignores the field if unknown
      const instructions = NO_INSTRUCTIONS.test(target.model.trim())
        ? ""
        : input.instructions.trim();
      return {
        url: `${target.baseUrl}${shape.requestPath(target.model)}`,
        init: {
          method: "POST",
          headers: jsonHeaders(target),
          body: JSON.stringify(speechBody(input, target, voice, instructions, hosted)),
        },
        format: input.encoding.format,
        text: input.text,
        instructions,
      };
    },

    /** Lists models: proves address and key for free, and checks the model is listed. */
    async probe(target, signal, options) {
      const started = Date.now();
      const res = await call(
        target,
        `${target.baseUrl}/models`,
        { method: "GET", headers: jsonHeaders(target) },
        { signal, ...options },
      );
      const ms = Date.now() - started;
      const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
      const ids = Array.isArray(body?.data)
        ? body.data.map((m) => m?.id).filter((id): id is string => typeof id === "string")
        : [];
      if (ids.length && !ids.includes(target.model))
        return {
          ok: false,
          message: `Answered in ${ms} ms, but “${target.model}” is not among the ${ids.length} models it lists`,
          ms,
        };
      const batches = hosted
        ? null
        : await batchCapabilities(target, signal, options).catch(() => null);
      return {
        ok: true,
        message:
          `Answered in ${ms} ms` +
          (ids.length ? ` and lists “${target.model}”` : "") +
          (batches ? ` · ${takesBatches(batches)}` : ""),
        ms,
      };
    },

    async voices(target, signal, options) {
      if (hosted)
        return onePage(
          OPENAI_VOICES.map((id) => ({ id, label: titleCase(id), gender: "?" as const })),
        );
      const url = `${target.baseUrl}/audio/voices`;
      let body: unknown;
      try {
        body = await getJson<unknown>(target, url, jsonHeaders(target), signal, options);
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
      return onePage(voices);
    },
  };
}

export const openaiWire = openaiShaped(true);
export const compatibleWire: SpeechWire = {
  ...openaiShaped(false),
  clone: makeVoice,
  batchLimits: batchCapabilities,
  speakBatch: sendBatch,
};
