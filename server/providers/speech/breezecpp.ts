// Breeze-TTS-2.cpp's `breeze-server` (https://github.com/HoppouAI/Breeze-TTS-2.cpp/blob/main/docs/server.md):
// OpenAI-shaped `POST /audio/speech`, ignoring `model`. It renders one request at a time and answers
// a second with `409 busy` (its only 409), so a 409 is retried. No model list: the Test button reads
// `GET /voices`. Cloning takes WAV only, with a required exact transcript.
import type { MadeVoice } from "@/types";
import { breezecpp } from "@/lib/providers/breezecpp";
import { ffmpegWav } from "~/audio/ffmpeg";
import { env } from "~/env";
import { authHeaders, call, jsonHeaders, ProviderError } from "~/providers/http";
import { getJson, onePage, type SpeechWire } from "~/providers/speech/wire";

/** As `voice_json` in its `voices.cpp` writes it. */
interface BreezeVoice {
  id?: unknown;
  seconds?: unknown;
}

/** What Breeze's `valid_voice_name` takes: `[A-Za-z0-9_-]`, up to 64. */
export const breezeVoiceName = (title: string): string =>
  title
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "voice";

const voiceList = (body: unknown): BreezeVoice[] => (Array.isArray(body) ? body : []);

export const breezeCppWire: SpeechWire = {
  request(input, target, voice) {
    const instructions = input.instructions.trim();
    return {
      url: `${target.baseUrl}${breezecpp.requestPath(target.model)}`,
      init: {
        method: "POST",
        headers: jsonHeaders(target),
        body: JSON.stringify({
          model: target.model,
          input: input.text,
          voice,
          response_format: input.encoding.format,
          ...(instructions ? { instructions } : {}),
        }),
      },
      format: input.encoding.format,
      text: input.text,
      instructions,
      retryable: (status) => status === 409,
    };
  },

  async probe(target, signal, options) {
    const started = Date.now();
    const url = `${target.baseUrl}/voices`;
    const body = await getJson<unknown>(target, url, jsonHeaders(target), signal, options);
    const ms = Date.now() - started;
    if (!Array.isArray(body))
      return { ok: false, message: `Answered ${url} in ${ms} ms, but not with a voice list`, ms };
    return {
      ok: true,
      message: `Answered in ${ms} ms and holds ${body.length} voice${body.length === 1 ? "" : "s"}`,
      ms,
    };
  },

  async voices(target, signal, options) {
    const body = await getJson<unknown>(
      target,
      `${target.baseUrl}/voices`,
      jsonHeaders(target),
      signal,
      options,
    );
    return onePage(
      voiceList(body)
        .filter((v): v is { id: string } => typeof v?.id === "string" && !!v.id)
        .map((v) => ({ id: v.id, label: v.id, gender: "?" as const })),
    );
  },

  async clone(target, request, signal, options): Promise<MadeVoice> {
    const [sample] = request.samples;
    const bytes = await sample.blob.bytes();
    // one ffmpeg cannot read goes as it came, for the server to say what is wrong
    const wav = await ffmpegWav(env.FFMPEG_BIN, [], bytes, signal).catch((e) => {
      if (signal.aborted) throw e;
      return bytes;
    });
    const form = new FormData();
    form.set("ref_audio", new Blob([wav], { type: "audio/wav" }), "sample.wav");
    form.set("ref_text", sample.transcript ?? "");
    form.set("name", breezeVoiceName(request.title));
    // no content-type: the multipart boundary is the form's to write
    const res = await call(
      target,
      `${target.baseUrl}/voices`,
      { method: "POST", headers: authHeaders(target), body: form },
      { signal, ...options },
    );
    const body = (await res.json().catch(() => null)) as BreezeVoice | null;
    if (typeof body?.id !== "string" || !body.id)
      throw new ProviderError(
        `${target.name} answered ${res.status} without the new voice's id`,
        res.status,
        false,
      );
    return { id: body.id, label: request.title, gender: "?" };
  },
};
