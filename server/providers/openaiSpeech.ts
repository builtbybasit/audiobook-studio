// A line spoken through OpenAI's `/audio/speech` shape — OpenAI itself, or any server that copies
// it (Kokoro-FastAPI, an Orpheus or Piper bridge).
//
// The request is the one OpenAI documents (https://platform.openai.com/docs/api-reference/audio/createSpeech):
// `model`, `input`, `voice` and `response_format`: the endpoint's format, WAV unless it chose MP3
// or Opus, which are kept as they come. The API takes no bitrate, so an endpoint naming one fails
// before a request, as a rate does below (`encodingProblems`). The line's `direction` goes as `instructions` when there is one — OpenAI documents it
// for its newer models and says it "does not work with tts-1 or tts-1-hd", so it is left off for
// those two; a compatible server that does not know the field ignores it, as the servers this app
// names do with fields they do not model.
//
// There is no sample-rate field in that API: OpenAI answers at 24 kHz and a local server at its
// model's own rate. An endpoint that names a rate therefore fails before any request, saying to
// clear it. Sending the line anyway would not be honest either way — a clip at another rate than
// the endpoint names is drift to the job, so every run would render the line again and spend again.
import { refuseEncoding } from "~/providers/answer";
import { sendSpeech, type SpeechCallOptions } from "~/providers/fishSpeech";
import { call, jsonHeaders } from "~/providers/http";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

/** The models OpenAI says take no `instructions`. */
const NO_INSTRUCTIONS = /^tts-1(-hd)?$/;

export async function openaiSpeak(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  options: SpeechCallOptions,
): Promise<RenderedClip> {
  const { format } = input.encoding;
  refuseEncoding(target, input);
  // what is actually sent beside the words, and so what the ledger counts: nothing for a model
  // that takes none
  const instructions = NO_INSTRUCTIONS.test(target.model) ? "" : input.instructions.trim();
  const started = Date.now();
  const audio = await sendSpeech(
    input,
    target,
    {
      url: `${target.baseUrl}/audio/speech`,
      init: {
        method: "POST",
        headers: jsonHeaders(target),
        body: JSON.stringify({
          model: target.model,
          input: input.text,
          voice,
          response_format: format,
          ...(instructions ? { instructions } : {}),
        }),
      },
      format,
      text: input.text,
      instructions,
    },
    options,
  );
  return {
    ...audio,
    ms: Date.now() - started,
    model: target.model,
    voice,
  };
}

/**
 * The Test button for an OpenAI-shaped server: its model list, which proves the address and the
 * key without rendering (and paying for) a word, and says so when the configured model is not on it.
 */
export async function openaiProbe(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<ProbeResult> {
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
}
