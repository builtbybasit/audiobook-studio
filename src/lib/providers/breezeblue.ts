// BreezeBlue's hosted API (https://docs.breezeblue.ai), which copies ElevenLabs' shape — path, key
// header, `output_format` — and adds an `instructions` field for delivery.
import { ROUND, SQUARE, type SpeechProviderShape } from "@/lib/providers/types";

/** Its instructions guide: "Keep `instructions` within 1,000 characters." */
export const BREEZE_INSTRUCTION_CHARS = 1000;

export const breezeblue: SpeechProviderShape = {
  id: "breezeblue",
  label: "BreezeBlue",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*breeze\.blue(\/|:|$)/i.test(baseUrl),
  requestPath: () => "/text-to-speech/<voice>",
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
  models: ["breeze-tts-2", "breeze-tts-2-multilingual"],
};
