// Google's Gemini API (https://ai.google.dev/gemini-api/docs/speech-generation): speech is a
// `generateContent` call on the model, answered as JSON.
import { fixedPauses, type SpeechProviderShape } from "@/lib/providers/types";

/** An id pasted as `models/gemini-…` would otherwise make `/models/models/gemini-…`. */
export const geminiModelId = (model: string): string => model.trim().replace(/^models\//i, "");

/** The previews before 3.8: no `responseFormat`, no `speechMetadata`, no inline tags, raw PCM back. */
export const isLegacyGeminiSpeech = (model: string): boolean =>
  /^gemini-(1|2|3\.0|3\.1)[.-]/i.test(geminiModelId(model));

export const gemini: SpeechProviderShape = {
  id: "gemini",
  label: "Gemini",
  matches: (baseUrl) => /(^|\/\/)generativelanguage\.googleapis\.com(\/|:|$)/i.test(baseUrl),
  requestPath: (model) => `/models/${geminiModelId(model) || "<model>"}:generateContent`,
  /**
   * `responseFormat` (3.8): only WAV is documented in the speech guide. The legacy previews answer
   * raw 24 kHz PCM, which the server wraps in a WAV header.
   */
  formats: [
    {
      format: "wav",
      label: "WAV · 16-bit PCM, mono",
      rates: [16000, 24000],
      defaultRate: 24000,
      bitrates: [],
      defaultBitrate: null,
    },
  ],
  // 3.8: angle-bracket tags for vocal events only, delivery in speech_metadata.style; two pauses
  // with no length (https://ai.google.dev/gemini-api/docs/speech-generation)
  tags: (model) =>
    isLegacyGeminiSpeech(model)
      ? null
      : {
          brackets: ["angle"],
          open: true,
          kinds: ["sound"],
          example: "<laugh>",
          hint: "Gemini 3.8 takes vocal sounds and pauses in angle brackets; delivery goes in the line's direction.",
          pause: fixedPauses("<short pause>", "<long pause>"),
        },
  billsFailures: false,
  // pace only through the style prompt
  speed: () => null,
  cloning: null,
  models: [
    "gemini-3.8-flash-tts",
    "gemini-3.8-flash-lite-tts",
    "gemini-3.1-flash-tts-preview",
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-pro-preview-tts",
  ],
};
