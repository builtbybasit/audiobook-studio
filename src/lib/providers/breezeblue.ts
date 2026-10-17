// BreezeBlue's hosted API (https://docs.breezeblue.ai), which copies ElevenLabs' shape — path, key
// header, `output_format` — and adds an `instructions` field for delivery.
import { fixedPauses, type SpeechProviderShape } from "@/lib/providers/types";

/** Its instructions guide: "Keep `instructions` within 1,000 characters." */
export const BREEZE_INSTRUCTION_CHARS = 1000;

export const breezeblue: SpeechProviderShape = {
  id: "breezeblue",
  label: "BreezeBlue",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*breeze\.blue(\/|:|$)/i.test(baseUrl),
  requestPath: (_model, voice = "<voice>") => `/text-to-speech/${voice}`,
  /**
   * `output_format` as ElevenLabs'. MP3 only at the 44.1 kHz/128 kbps its docs show; Opus is left
   * out until its container is known to be Ogg.
   */
  formats: [
    {
      format: "wav",
      label: "WAV · 16-bit PCM, mono",
      rates: [16000, 22050, 24000, 32000, 44100, 48000],
      defaultRate: 24000,
      bitrates: [],
      defaultBitrate: null,
    },
    {
      format: "mp3",
      label: "MP3 · mono",
      rates: [44100],
      defaultRate: 44100,
      bitrates: [{ value: 128, label: "128 kbps" }],
      defaultBitrate: 128,
    },
  ],
  // English tags in parentheses, other languages square brackets. `(pause)` has no length, so a
  // long pause goes as silence.
  tags: () => ({
    brackets: ["round", "square"],
    open: false,
    kinds: ["sound", "delivery"],
    example: "(sighs)",
    hint: "BreezeBlue's English audio tags are in parentheses; other languages use square brackets.",
    pause: fixedPauses("(pause)", null),
  }),
  // Its pricing page: "Failed requests release their reservation."
  billsFailures: false,
  // https://docs.breezeblue.ai/guides/voice-clone and https://docs.breezeblue.ai/concepts/pricing
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 5 * 1024 * 1024,
    formats: ["wav", "mp3"],
    transcript: "none",
    advice:
      "BreezeBlue makes a voice from one clip of at least 3 seconds: one speaker, no music or " +
      "background noise. It listens to the first minute and keeps up to 30 seconds of it, so put " +
      "the voice you want at the start.",
    cost: "100 credits a voice, however long the sample; the voice takes one of the plan's voice slots.",
    // charged for the preview; credits are priced by the plan
    fee: { usd: null, when: "made", said: "100 credits a voice" },
  },
  // its docs name no speed field
  speed: () => null,
  models: ["breeze-tts-2", "breeze-tts-2-multilingual"],
};
