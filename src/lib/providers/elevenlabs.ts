// ElevenLabs (https://elevenlabs.io/docs/api-reference/text-to-speech/convert): the voice in the
// path, the model in the body, keyed by `xi-api-key`.
import { pauseSecs, type SpeechProviderShape } from "@/lib/providers/types";

/** The models that take audio tags. */
const isV3 = (model: string): boolean => /^eleven_v3/i.test(model.trim());

export const elevenlabs: SpeechProviderShape = {
  id: "elevenlabs",
  label: "ElevenLabs",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*elevenlabs\.io(\/|:|$)/i.test(baseUrl),
  requestPath: (_model, voice = "<voice>") => `/text-to-speech/${voice}`,
  /**
   * `output_format`. 44.1 kHz WAV needs Pro and 192 kbps MP3 Creator. Opus is left out until its
   * container is known to be Ogg; MP3 at 22.05/24 kHz comes at one fixed low bitrate.
   */
  formats: [
    {
      format: "wav",
      label: "WAV · 16-bit PCM, mono",
      rates: [16000, 22050, 24000, 32000, 44100, 48000],
      // not the API's own default (an MP3): what this app asks for
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
  // v3: square-bracket audio tags, no SSML breaks; earlier models only `<break time="1.5s" />`, up
  // to 3 s (https://elevenlabs.io/docs/best-practices/prompting/controls)
  tags: (model) =>
    isV3(model)
      ? {
          brackets: ["square"],
          open: true,
          kinds: ["sound", "delivery"],
          example: "[whispers]",
          hint: "Eleven v3 takes audio tags in square brackets.",
        }
      : {
          brackets: ["angle"],
          open: false,
          kinds: ["sound"],
          example: '<break time="1.5s" />',
          hint: "ElevenLabs' models before v3 take only pauses, as a break tag of up to 3 seconds.",
          pause: (s) => `<break time="${pauseSecs(Math.min(s, 3))}s" />`,
        },
  billsFailures: false,
  // Instant Voice Cloning (https://elevenlabs.io/docs/api-reference/voices/ivc/create). The docs
  // set no sample count, so it is ours; 10 MB is the upload box's. Formats from
  // https://elevenlabs.io/docs/help-center/product/core-capabilities/voice-changer/which-formats-can-be-used-as-the-input-audio-for-voice-changer;
  // their "OGG" may mean Vorbis, so no Opus.
  cloning: {
    maxSamples: 20,
    maxSampleBytes: 10 * 1024 * 1024,
    formats: ["mp3", "wav", "m4a", "flac"],
    transcript: "none",
    advice:
      "ElevenLabs recommends 1–2 minutes of audio in all, and no more than 3 — how many clips does " +
      "not matter: one speaker, no background noise or reverb, an even tone and volume. It advises " +
      "MP3 at 128 kbps or more; WAV usually makes no better a clone.",
    cost: "Needs a Starter plan or above, and each voice takes one of the plan's custom voice slots.",
    fee: null,
  },
  models: ["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"],
};
