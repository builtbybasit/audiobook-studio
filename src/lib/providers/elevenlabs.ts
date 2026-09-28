// ElevenLabs (https://elevenlabs.io/docs/api-reference/text-to-speech/convert): the voice in the
// path, the model in the body, keyed by `xi-api-key`.
import { SQUARE, type SpeechProviderShape } from "@/lib/providers/types";

/** `<break time="1.5s" />`, the one tag ElevenLabs' models before v3 take. */
const BREAK = /^<break time="\d{1,2}(\.\d{1,2})?s"\s*\/>$/;

/** v3 and its conversational sibling: the models that take audio tags. */
const isV3 = (model: string): boolean => /^eleven_v3/i.test(model.trim());

export const elevenlabs: SpeechProviderShape = {
  id: "elevenlabs",
  label: "ElevenLabs",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*elevenlabs\.io(\/|:|$)/i.test(baseUrl),
  requestPath: () => "/text-to-speech/<voice>",
  /**
   * `output_format`, which names the rate and, for MP3, the bitrate. Its WAV at 44.1 kHz needs a
   * Pro plan and its 192 kbps MP3 a Creator plan; a plan without them is refused by ElevenLabs,
   * which says so. Its Opus is left out until its container is known to be the Ogg this app reads,
   * and so are the MP3s at 22.05 and 24 kHz, which come at one fixed low bitrate each.
   */
  formats: [
    {
      format: "wav",
      label: "WAV · 16-bit PCM, mono",
      rates: [16000, 22050, 24000, 32000, 44100, 48000],
      // not the API's own default (that is an MP3): what this app asks for when no rate is set
      defaultRate: 24000,
      bitrates: [],
      defaultBitrate: null,
    },
    {
      format: "mp3",
      label: "MP3 · mono",
      rates: [44100],
      defaultRate: 44100,
      bitrates: [32, 64, 96, 128, 192].map((value) => ({ value, label: `${value} kbps` })),
      defaultBitrate: 128,
    },
  ],
  // Eleven v3 takes audio tags in square brackets — emotions, delivery and reactions alike
  // (`[curious]`, `[whispers]`, `[laughs]`) — and "does not support SSML break tags"; the models
  // before it take only `<break time="1.5s" />`, a pause, which is a sound in this app's terms.
  tags: (model) =>
    isV3(model)
      ? {
          forms: [SQUARE],
          kinds: ["sound", "delivery"],
          example: "[whispers]",
          hint: "Eleven v3 takes audio tags in square brackets.",
        }
      : {
          forms: [BREAK],
          kinds: ["sound"],
          example: '<break time="1.5s" />',
          hint: "ElevenLabs' models before v3 take only pauses, as a break tag of up to 3 seconds.",
        },
  // ElevenLabs bills characters of text it spoke; its docs say nothing of charging a refusal.
  billsFailures: false,
  cloning: null,
  models: ["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"],
};
