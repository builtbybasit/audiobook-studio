// Fish Audio (https://docs.fish.audio): `POST /v1/tts` on the API's host, the model in a `model`
// header and the voice as `reference_id`, so the path everyone else uses does not apply.
import { fixedPauses, type SpeechProviderShape } from "@/lib/providers/types";

/**
 * Fish falls back to the paid `s2.1-pro` for an unrecognised model, so the server refuses any
 * model not listed rather than let a typo in `s2.1-pro-free` bill at the paid rate.
 */
export const FISH_MODELS = [
  "s1",
  "s2-pro",
  "s2.1-pro",
  "s2.1-pro-free",
  "drama-3-preview",
] as const;

export const fish: SpeechProviderShape = {
  id: "fish",
  label: "Fish Audio",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*fish\.audio(\/|$)/i.test(baseUrl),
  requestPath: () => "/tts",
  /**
   * From https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech. No 8 kHz (below
   * the app's 16 kHz floor) and no headerless `pcm`.
   */
  formats: [
    {
      format: "wav",
      label: "WAV · 16-bit PCM, mono",
      rates: [16000, 24000, 32000, 44100],
      defaultRate: 44100,
      bitrates: [],
      defaultBitrate: null,
    },
    {
      format: "mp3",
      label: "MP3 · mono",
      rates: [32000, 44100],
      defaultRate: 44100,
      bitrates: [
        { value: 64, label: "64 kbps" },
        { value: 128, label: "128 kbps" },
        { value: 192, label: "192 kbps" },
      ],
      defaultBitrate: 128,
    },
    {
      format: "opus",
      label: "Opus · mono, in Ogg",
      rates: [48000],
      defaultRate: 48000,
      // only automatic: asking for 24 or 32 kbps returned ~272 kbps, larger than automatic (~60).
      // Add them back when Fish honours them.
      bitrates: [{ value: -1000, label: "Automatic" }],
      defaultBitrate: -1000,
    },
  ],
  // S2 takes free-form cues in square brackets, S1 emotions in parentheses; `drama-3-preview` is
  // undocumented and given S2's. Two pauses with no length each
  // (https://docs.fish.audio/developer-guide/core-features/emotions).
  tags: (model) =>
    model.trim().toLowerCase() === "s1"
      ? {
          brackets: ["round"],
          open: false,
          kinds: ["sound", "delivery"],
          example: "(laughing)",
          hint: "Fish's S1 takes its emotions and sounds in parentheses.",
          pause: fixedPauses("(break)", "(long-break)"),
        }
      : {
          brackets: ["square"],
          open: true,
          kinds: ["sound", "delivery"],
          example: "[laughing nervously]",
          hint: "Fish's S2 models take cues in square brackets, in words of your choosing.",
          pause: fixedPauses("[break]", "[long-break]"),
        },
  billsFailures: false,
  models: FISH_MODELS,
  // https://docs.fish.audio/features/voice-cloning: FLAC is undocumented for models but accepted;
  // without `texts` Fish transcribes the samples itself
  cloning: {
    maxSamples: 20,
    maxSampleBytes: 20 * 1024 * 1024,
    formats: ["wav", "mp3", "m4a", "opus", "flac"],
    transcript: "optional",
    advice:
      "Fish recommends two or three clips of 15–20 seconds each, at least 10 seconds in all: " +
      "one speaker, a quiet room, an even tone. It transcribes a clip itself when no transcript " +
      "is given.",
    cost: null,
    fee: null,
  },
};
