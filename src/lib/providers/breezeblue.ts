// BreezeBlue's hosted API (https://docs.breezeblue.ai), which copies ElevenLabs' shape — path, key
// header, `output_format` — and adds an `instructions` field for delivery.
import { ROUND, SQUARE, type SpeechProviderShape } from "@/lib/providers/types";

/** Its instructions guide: "Keep `instructions` within 1,000 characters." */
export const BREEZE_INSTRUCTION_CHARS = 1000;

export const breezeblue: SpeechProviderShape = {
  id: "breezeblue",
  label: "BreezeBlue",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*breeze\.blue(\/|:|$)/i.test(baseUrl),
  requestPath: (_model, voice = "<voice>") => `/text-to-speech/${voice}`,
  /**
   * `output_format`: the same `<format>_<rate>[_<kbps>]` as ElevenLabs, WAV as 16-bit mono at any
   * of its rates, 24 kHz being the model's own. Its MP3 is offered at 44.1 kHz and 128 kbps, the
   * combination its docs show; its Opus is left out until its container is known to be Ogg.
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
  // Its audio-tags guide: 34 vocal events at points in the text; "English tags use parentheses;
  // every other supported language uses square brackets". Whispering and shouting are among the
  // events, so both kinds are taken; a longer delivery goes in `instructions`.
  tags: () => ({
    forms: [ROUND, SQUARE],
    kinds: ["sound", "delivery"],
    example: "(sighs)",
    hint: "BreezeBlue's English audio tags are in parentheses; other languages use square brackets.",
  }),
  // Its pricing page: "Failed requests release their reservation."
  billsFailures: false,
  // Its voice-clone guide (https://docs.breezeblue.ai/guides/voice-clone) and the create-clone-preview
  // reference: "exactly one sample file", "MP3 or WAV", "at least 3 seconds", "up to 5 MB". Its
  // pricing page (https://docs.breezeblue.ai/concepts/pricing): "Voice cloning: 100 credits per
  // clone generation, regardless of sample or preview text length"; saving the voice costs no more,
  // but "saving consumes a voice slot".
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 5 * 1024 * 1024,
    formats: ["wav", "mp3"],
    // its guide: "custom scripts, performance instructions, and language hints are not accepted"
    transcript: "none",
    advice:
      "BreezeBlue makes a voice from one clip of at least 3 seconds: one speaker, no music or " +
      "background noise. It listens to the first minute and keeps up to 30 seconds of it, so put " +
      "the voice you want at the start.",
    cost: "100 credits a voice, however long the sample; the voice takes one of the plan's voice slots.",
    // charged for the preview, as it is made; credits are priced by the plan, not in dollars
    fee: { usd: null, when: "made", said: "100 credits a voice" },
  },
  models: ["breeze-tts-2", "breeze-tts-2-multilingual"],
};
