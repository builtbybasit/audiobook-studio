// Gemini's `generateContent` with the AUDIO modality (https://ai.google.dev/gemini-api/docs/speech-generation).
// `usageMetadata` tokens are billed, reported before the audio is checked. 3.8 models read `text`
// verbatim, so instructions go in `speechMetadata.style`; legacy previews take no style and answer
// raw 24 kHz PCM. A finish other than STOP (MAX_TOKENS cuts audio) is refused.
import { AUDIO_MIME } from "@/lib/endpointShapes";
import { geminiModelId, isLegacyGeminiSpeech } from "@/lib/providers/gemini";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { jsonAnswer } from "~/providers/answer";
import { call, ProviderError } from "~/providers/http";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { plainWav } from "~/providers/wav";
import { wavHeader } from "~/providers/wav";
import { onePage, type SpeechWire } from "~/providers/speech/wire";

/** A preview's rate when it names none. */
const LEGACY_RATE = 24000;

function geminiHeaders(target: ProviderTarget): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(target.apiKey ? { "x-goog-api-key": target.apiKey } : {}),
  };
}

const modelUrl = (target: ProviderTarget): string =>
  `${target.baseUrl}/models/${encodeURIComponent(geminiModelId(target.model))}`;

function geminiSpeechBody(
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
          // inline, not a link to fetch
          delivery: "INLINE",
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
 * From the speech guide; no gender given. 3.8 models also take extended-library
 * (`GET /v1beta/voices`) and designed voices, added by id.
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

export const geminiWire: SpeechWire = {
  request(input, target, voice) {
    const legacy = isLegacyGeminiSpeech(target.model);
    if (legacy && input.sampleRate != null && input.sampleRate !== LEGACY_RATE)
      throw new ProviderError(
        `${target.name} (${target.model}) answers at 24 kHz and cannot be asked for another rate. ` +
          "Clear the endpoint's sample rate, or use a Gemini 3.8 speech model.",
        0,
        false,
      );
    // as sent, and so as the ledger counts
    const style = legacy ? "" : input.instructions.trim();
    return {
      url: `${modelUrl(target)}:generateContent`,
      init: {
        method: "POST",
        headers: geminiHeaders(target),
        body: JSON.stringify(geminiSpeechBody(input, target.model, voice, style)),
      },
      format: "wav",
      text: input.text,
      instructions: style,
      /** None of these failures is retried: the same line would be answered the same way. */
      async read(res, { signal, counted }) {
        const body = await jsonAnswer<GeminiAnswer>(target, res, signal);
        counted(normalizeSpeechUsage(body as Record<string, unknown>, "gemini"));
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
        if (candidate?.finishReason && candidate.finishReason !== "STOP")
          throw new ProviderError(
            `${target.name} cut the line short: it finished with ${candidate.finishReason}`,
            res.status,
            false,
          );
        const raw = new Uint8Array(Buffer.from(inline.data, "base64"));
        const mime = (inline.mimeType ?? "").toLowerCase();
        const isWav = mime.includes("wav") || String.fromCharCode(...raw.subarray(0, 4)) === "RIFF";
        let wav: ReturnType<typeof plainWav>;
        try {
          if (isWav) wav = plainWav(raw);
          else {
            // raw 16-bit LE mono PCM, at the rate the mime type names
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
        if (input.sampleRate != null && wav.format.sampleRate !== input.sampleRate)
          throw new ProviderError(
            `${target.name} was asked for ${input.sampleRate / 1000} kHz and answered at ` +
              `${wav.format.sampleRate / 1000} kHz`,
            res.status,
            false,
          );
        return { bytes: wav.bytes, format: "wav", mime: AUDIO_MIME.wav, duration: wav.duration };
      },
    };
  },

  /** Fetches the model's description: proves the key can see it, for free. */
  async probe(target, signal, options) {
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
  },

  voices: async () => onePage(GEMINI_VOICES.map((id) => ({ id, label: id, gender: "?" as const }))),
};
