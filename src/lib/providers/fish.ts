// Fish Audio (https://docs.fish.audio): `POST /v1/tts` on the API's host, the model in a `model`
// header and the voice as `reference_id`, so the path everyone else uses does not apply.
import type { SpeechProviderShape } from "@/lib/providers/types";

/**
 * The models Fish's text-to-speech reference names. It also says what happens to any other: "If
 * omitted or set to an unrecognized value, the request falls back to `s2.1-pro`" — the paid model,
 * whatever the endpoint was priced as. So the server refuses a model not on this list before any
 * request rather than let a typo in `s2.1-pro-free` bill at s2.1-pro's rate.
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
   * From https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech. Its WAV also
   * goes to 8 kHz, below the 16 kHz this app keeps speech at, and its `pcm` is WAV without the
   * header, so neither is offered. The Opus default is the schema's `-1000` (automatic); the prose
   * note on the same page says 32 kbps, and the schema is what the server is sent.
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
      // Only automatic. The API lists 24, 32, 48 and 64 kbps, but on 2026-09-23 asking for 24 or 32
      // kbps came back at about 272 kbps — five times the size of automatic, which ran near 60 — so
      // offering them would make "smaller" the larger file. Add them back when Fish honours them.
      bitrates: [{ value: -1000, label: "Automatic" }],
      defaultBitrate: -1000,
    },
  ],
  // Fish's models page: the S2 family takes free-form cues in square brackets (`[whispers
  // sweetly]`, `[laughing nervously]`), S1 its emotions in parentheses. `drama-3-preview` is not
  // described there; it is served beside the S2 family, so it is given theirs.
  tags: (model) =>
    model.trim().toLowerCase() === "s1"
      ? {
          brackets: ["round"],
          open: false,
          kinds: ["sound", "delivery"],
          example: "(laughing)",
          hint: "Fish's S1 takes its emotions and sounds in parentheses.",
        }
      : {
          brackets: ["square"],
          open: true,
          kinds: ["sound", "delivery"],
          example: "[laughing nervously]",
          hint: "Fish's S2 models take cues in square brackets, in words of your choosing.",
        },
  // Fish's pricing and API docs say nothing of charging for a refused request.
  billsFailures: false,
  models: FISH_MODELS,
  // https://docs.fish.audio/features/voice-cloning and the create-model reference: 1 to 20 samples
  // under `voices`, WAV, MP3, M4A or Opus for a model — and FLAC, which the speech reference takes
  // as reference audio and a model upload has taken too. `texts`, "corresponding to the voices",
  // is optional: "if unspecified, ASR will be performed on the voices".
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
