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
//
// Batches: a compatible server may also speak the batch speech API this app wrote down for local
// servers (`docs/speech-batch-api.md`), and then a run sends it many lines per request (`batch.ts`).
// OpenAI itself has no such route, so its wire has neither member. The Test button asks a
// compatible server's capabilities too and says when it takes batches; a server that cannot say
// has still passed the test, which was about the address and the key.
//
// Voices made from a recording: the same API's `POST /audio/voices`, for an endpoint that says its
// server makes voices (`makesVoices`) — nothing else tells a server that does from one that does
// not. OpenAI's own voice creation is another API this app does not speak.
import type { Gender, MadeVoice, Voice } from "@/types";
import { compatible, openai } from "@/lib/providers/openai";
import { authHeaders, call, jsonHeaders, ProviderError } from "~/providers/http";
import type { CloneRequest } from "~/providers/clone";
import type { SpeechCallOptions } from "~/providers/send";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { batchCapabilities, sendBatch, takesBatches } from "~/providers/speech/batch";
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
    // the batch speech API's list says `f` or `m` where it knows
    const gender = rec?.gender === "f" || rec?.gender === "m" ? rec.gender : genderOfName(id);
    voices.push({ id: id.trim(), label: name, gender });
  }
  return voices;
}

/**
 * A voice made from one recording (`cloning.maxSamples`) at `POST /audio/voices`, as the batch
 * speech API gives it: `name`, the recording as `samples`, and `transcript` when there is one,
 * answered with the voice as the list shows it. A server that makes no voices answers 404 or 405.
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
  // the spec's voice names its id; a list entry may go by its name, but a made voice may not
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

/** The shape both share; `hosted` is OpenAI's own API, and differs where OpenAI documents more. */
function openaiShaped(hosted: boolean): SpeechWire {
  const shape = hosted ? openai : compatible;
  return {
    request(input, target, voice) {
      // what is actually sent beside the words, and so what the ledger counts: nothing for a model
      // that takes none
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
