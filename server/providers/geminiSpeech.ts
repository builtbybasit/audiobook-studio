// A line spoken by a Gemini speech model, through the Gemini API's `generateContent`.
//
// Gemini is neither Fish- nor OpenAI-shaped (https://ai.google.dev/gemini-api/docs/speech-generation):
// the request is `POST {base}/models/{model}:generateContent` keyed by `x-goog-api-key`, asking
// for the AUDIO modality in one voice, and the answer is JSON — the audio base64 in the first
// candidate's `inlineData`, beside a `usageMetadata` that counts the text tokens that went in and
// the audio tokens that came out. Those counts are what Google bills, so they are reported to the
// ledger (`normalizeSpeechUsage(…, "gemini")`) rather than estimated from the audio's length.
//
// The 3.8 models and the legacy previews before them differ in three ways, and the request follows
// the model:
//   - 3.8 reads `text` as a verbatim transcript, so a direction written into it may be spoken
//     aloud. The line's instructions — the speaker's style and the line's direction — go in the
//     part's `speechMetadata.style` instead. A preview has no such field and gets none.
//   - 3.8 is asked for WAV, at the endpoint's rate when it names one, through `responseFormat`; a
//     preview takes neither and answers raw 24 kHz PCM, which is put under a WAV header here.
//   - 3.8 names the voice as `voiceConfig.voice`; a preview as `prebuiltVoiceConfig.voiceName`.
//
// Either way the clip kept is a plain WAV (`plainWav`), and its duration is counted from its samples.
import type { SpeechUsage } from "@/types";
import { AUDIO_MIME } from "@/lib/endpointShapes";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { refuseEncoding, type AnsweredAudio } from "~/providers/answer";
import { sendSpeech, type SpeechCallOptions } from "~/providers/fishSpeech";
import { call, ProviderError } from "~/providers/http";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";
import { plainWav } from "~/providers/wav";
import { wavHeader } from "~/providers/wavEncoder";

/** The previews before 3.8: no `responseFormat`, no `speechMetadata`, raw PCM back. */
export const isLegacyGeminiSpeech = (model: string): boolean =>
  /^gemini-(1|2|3\.0|3\.1)[.-]/i.test(model.trim());

/** What a preview answers when it says nothing about its rate. */
const LEGACY_RATE = 24000;

/** The headers every Gemini request carries: its key goes in its own header, not `authorization`. */
export function geminiHeaders(target: ProviderTarget): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(target.apiKey ? { "x-goog-api-key": target.apiKey } : {}),
  };
}

const modelUrl = (target: ProviderTarget): string =>
  `${target.baseUrl}/models/${encodeURIComponent(target.model)}`;

/** The request body for one line. Exported for the tests, which check it against the docs. */
export function geminiSpeechBody(
  input: Pick<SpeechInput, "text" | "sampleRate">,
  model: string,
  voice: string,
  style: string,
): Record<string, unknown> {
  if (isLegacyGeminiSpeech(model))
    return {
      contents: [{ role: "user", parts: [{ text: input.text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    };
  return {
    contents: [
      {
        role: "user",
        parts: [{ text: input.text, ...(style ? { speechMetadata: { style } } : {}) }],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      responseFormat: {
        audio: {
          mimeType: "AUDIO_WAV",
          ...(input.sampleRate != null ? { sampleRate: input.sampleRate } : {}),
        },
      },
      speechConfig: { voiceConfig: { voice } },
    },
  };
}

interface GeminiAnswer {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: unknown;
}

/**
 * The audio in a successful answer, as a plain WAV, and what Google counted for it. An answer with
 * no audio in it — a blocked prompt, a finish for another reason — says why, and is not retried:
 * the same line would be answered the same way.
 */
export async function geminiAnswer(
  target: ProviderTarget,
  res: Response,
  signal: AbortSignal,
): Promise<{ audio: AnsweredAudio; reported: SpeechUsage | null }> {
  let body: GeminiAnswer;
  try {
    body = (await res.json()) as GeminiAnswer;
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new ProviderError(
      `${target.name} answered ${res.status} with something that is not JSON`,
      res.status,
      false,
    );
  }
  const candidate = body.candidates?.[0];
  const inline = candidate?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    const why = body.promptFeedback?.blockReason
      ? `the prompt was blocked (${body.promptFeedback.blockReason})`
      : candidate?.finishReason
        ? `it finished with ${candidate.finishReason}`
        : "the answer held none";
    throw new ProviderError(`${target.name} sent no audio: ${why}`, res.status, false);
  }
  const raw = new Uint8Array(Buffer.from(inline.data, "base64"));
  const mime = (inline.mimeType ?? "").toLowerCase();
  const isWav = mime.includes("wav") || String.fromCharCode(...raw.subarray(0, 4)) === "RIFF";
  let wav: ReturnType<typeof plainWav>;
  try {
    if (isWav) wav = plainWav(raw);
    else {
      // raw 16-bit little-endian PCM, mono, at the rate the mime type names
      const rate = Number(/rate=(\d+)/.exec(mime)?.[1]) || LEGACY_RATE;
      const pcm = raw.subarray(0, raw.byteLength - (raw.byteLength % 2));
      const file = new Uint8Array(44 + pcm.byteLength);
      file.set(wavHeader({ channels: 1, sampleRate: rate, bits: 16 }, pcm.byteLength));
      file.set(pcm, 44);
      wav = plainWav(file);
    }
  } catch (e) {
    throw new ProviderError(
      `${target.name} answered with audio this server cannot read (${mime || "no type"}): ${(e as Error).message}`,
      res.status,
      false,
    );
  }
  return {
    audio: { bytes: wav.bytes, format: "wav", mime: AUDIO_MIME.wav, duration: wav.duration },
    reported: normalizeSpeechUsage(body as Record<string, unknown>, "gemini"),
  };
}

export async function geminiSpeak(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  options: SpeechCallOptions,
): Promise<RenderedClip> {
  refuseEncoding(target, input);
  const legacy = isLegacyGeminiSpeech(target.model);
  if (legacy && input.sampleRate != null && input.sampleRate !== LEGACY_RATE)
    throw new ProviderError(
      `${target.name} (${target.model}) answers at 24 kHz and cannot be asked for another rate. ` +
        "Clear the endpoint's sample rate, or use a Gemini 3.8 speech model.",
      0,
      false,
    );
  // what is sent beside the words, and so what the ledger counts: nothing to a preview
  const style = legacy ? "" : input.instructions.trim();
  const started = Date.now();
  const audio = await sendSpeech(
    input,
    target,
    {
      url: `${modelUrl(target)}:generateContent`,
      init: {
        method: "POST",
        headers: geminiHeaders(target),
        body: JSON.stringify(geminiSpeechBody(input, target.model, voice, style)),
      },
      format: "wav",
      text: input.text,
      instructions: style,
      read: (res, signal) => geminiAnswer(target, res, signal),
    },
    options,
  );
  return { ...audio, ms: Date.now() - started, model: target.model, voice };
}

/**
 * The Test button for Gemini: the model's own description, which needs the key and costs nothing,
 * and says whether this key can see the configured model at all.
 */
export async function geminiProbe(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<ProbeResult> {
  const started = Date.now();
  const res = await call(
    target,
    modelUrl(target),
    { method: "GET", headers: geminiHeaders(target) },
    { signal, ...options },
  );
  const ms = Date.now() - started;
  const body = (await res.json().catch(() => null)) as { displayName?: unknown } | null;
  const name = typeof body?.displayName === "string" ? body.displayName : target.model;
  return {
    ok: true,
    message: `Answered in ${ms} ms; the key was accepted and it knows ${name}`,
    ms,
  };
}

/**
 * Gemini's prebuilt voices, from the speech guide. The 3.8 models also take voices from Google's
 * extended library (`GET /v1beta/voices`) and designed ones; those can be added by id. Google
 * gives the prebuilt voices no gender.
 */
export const GEMINI_VOICES: readonly string[] = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
];
