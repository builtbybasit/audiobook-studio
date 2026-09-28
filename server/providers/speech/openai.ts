// A line spoken through OpenAI's `/audio/speech` shape — OpenAI itself, or any server that copies
// it (Kokoro-FastAPI, an Orpheus or Piper bridge, vLLM-Omni).
//
// The request is the one OpenAI documents (https://platform.openai.com/docs/api-reference/audio/createSpeech):
// `model`, `input`, `voice` and `response_format`: the endpoint's format, WAV unless it chose MP3
// or Opus, which are kept as they come. The API takes no bitrate, so an endpoint naming one fails
// before a request, as a rate does below (`encodingProblems`). The line's `direction` goes as
// `instructions` when there is one — OpenAI documents it for its newer models and says it "does
// not work with tts-1 or tts-1-hd", so it is left off for those two; a compatible server that does
// not know the field ignores it, as the servers this app names do with fields they do not model.
// A voice OpenAI made from the account's own recording has an id, `voice_…`, and the reference
// takes it as an object, `{ "id": "voice_…" }`, where a built-in voice is a bare name.
//
// There is no sample-rate field in that API: OpenAI answers at 24 kHz and a local server at its
// model's own rate. An endpoint that names a rate therefore fails before any request, saying to
// clear it. Sending the line anyway would not be honest either way — a clip at another rate than
// the endpoint names is drift to the job, so every run would render the line again and spend again.
//
// Voices: OpenAI has no endpoint that lists them — its built-in voices are written down in its
// reference, and answered from here. The local servers that copy its API mostly answer
// `GET /audio/voices` (Kokoro-FastAPI does), so any other server is asked that, and one that does
// not answer it is said to have no list rather than to have no voices.
import type { Gender, Voice } from "@/types";
import { call, jsonHeaders, ProviderError } from "~/providers/http";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { getJson, onePage, type SpeechWire } from "~/providers/speech/wire";

/** The models OpenAI says take no `instructions`. */
const NO_INSTRUCTIONS = /^tts-1(-hd)?$/i;

/** A custom voice's id, as OpenAI's voice-creation API hands one back. */
const CUSTOM_VOICE = /^voice_/;

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

/** The body for one line; OpenAI's own API is sent a custom voice as the object it asks for. */
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

/** The shape both share; `hosted` is OpenAI's own API, and differs where OpenAI documents more. */
function openaiShaped(hosted: boolean): SpeechWire {
  return {
    request(input, target, voice) {
      // what is actually sent beside the words, and so what the ledger counts: nothing for a model
      // that takes none
      const instructions = NO_INSTRUCTIONS.test(target.model.trim())
        ? ""
        : input.instructions.trim();
      return {
        url: `${target.baseUrl}/audio/speech`,
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

    /**
     * The server's model list, which proves the address and the key without rendering (and paying
     * for) a word, and says so when the configured model is not on it.
     */
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
      return {
        ok: true,
        message: `Answered in ${ms} ms` + (ids.length ? ` and lists “${target.model}”` : ""),
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
export const compatibleWire = openaiShaped(false);
