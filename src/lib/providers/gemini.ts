// Google's Gemini API (https://ai.google.dev/gemini-api/docs/speech-generation): speech is a
// `generateContent` call on the model, answered as JSON.
import { ANGLE, type SpeechProviderShape } from "@/lib/providers/types";

/**
 * A model id as the API's path takes it. Google names its models `models/gemini-…` in its own
 * listings, and an id pasted from one would otherwise make `/models/models/gemini-…`.
 */
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
   * Asked through `responseFormat` (3.8) — WAV only here. Its reference also lists MP3 and Ogg
   * Opus, but only the WAV answer is documented in the speech guide, so that is the one offered
   * until the others are tried. A rate may be named; Google's examples give 24 and 16 kHz (and 8,
   * below what this app keeps speech at), with 24 kHz the default. The legacy 3.1 preview takes no
   * format at all and answers raw 24 kHz PCM, which the server puts under a WAV header.
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
  // The 3.8 guide: "Use angle-bracket inline tags only for point-in-time vocal events" — `<laugh>`,
  // `<sigh>`, `<short pause>` — "and put delivery styles in speech_metadata.style", which is where
  // the line's direction already goes. So a 3.8 model takes sounds inline and nothing else.
  tags: (model) =>
    isLegacyGeminiSpeech(model)
      ? null
      : {
          forms: [ANGLE],
          kinds: ["sound"],
          example: "<laugh>",
          hint: "Gemini 3.8 takes vocal sounds and pauses in angle brackets; delivery goes in the line's direction.",
        },
  // Google bills the tokens of what it generated; a refused request generated nothing.
  billsFailures: false,
  cloning: null,
  models: [
    "gemini-3.8-flash-tts",
    "gemini-3.8-flash-lite-tts",
    "gemini-3.1-flash-tts-preview",
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-pro-preview-tts",
  ],
};
