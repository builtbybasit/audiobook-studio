// Cartesia (https://docs.cartesia.ai/api-reference/tts/bytes): `POST /tts/bytes` at the host root,
// with a `Cartesia-Version` header.
import { pauseSecs, type SpeechProviderShape } from "@/lib/providers/types";

export const cartesia: SpeechProviderShape = {
  id: "cartesia",
  label: "Cartesia",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*cartesia\.ai(\/|:|$)/i.test(baseUrl),
  requestPath: () => "/tts/bytes",
  /** `output_format`; 44.1 kHz default, as Cartesia's own example uses. No Opus. */
  formats: [
    {
      format: "wav",
      label: "WAV · 16-bit PCM, mono",
      rates: [16000, 22050, 24000, 44100, 48000],
      defaultRate: 44100,
      bitrates: [],
      defaultBitrate: null,
    },
    {
      format: "mp3",
      label: "MP3 · mono",
      rates: [44100],
      defaultRate: 44100,
      bitrates: [64, 128, 192].map((value) => ({ value, label: `${value} kbps` })),
      defaultBitrate: 128,
    },
  ],
  // SSML self-closing tags and `[laughter]`; a break has no documented maximum
  // (https://docs.cartesia.ai/build-with-cartesia/sonic-3/ssml-tags)
  tags: () => ({
    brackets: ["angle", "square"],
    open: false,
    kinds: ["sound", "delivery"],
    example: '<break time="1s"/>',
    hint: 'Sonic takes SSML-like tags: <break time="1s"/>, <emotion value="calm"/>, <speed ratio="0.8"/>, and [laughter].',
    pause: (s) => `<break time="${pauseSecs(s)}s"/>`,
  }),
  // "errors will not consume credits"
  billsFailures: false,
  // https://docs.cartesia.ai/api-reference/voices/clone (WebM is not sniffed); advice from
  // https://docs.cartesia.ai/build-with-cartesia/capability-guides/clone-voices; not on the Free
  // plan (https://cartesia.ai/pricing)
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 16 * 1024 * 1024,
    formats: ["wav", "mp3", "flac", "opus"],
    transcript: "none",
    advice:
      "Cartesia makes a voice from one clip: 10 seconds is enough, and up to 60 keeps more of the " +
      "accent. One speaker, no background noise, spoken naturally in the mood the voice should have.",
    cost: "No credits per voice, but instant cloning needs Cartesia's Pro plan or above.",
    fee: null,
  },
  // https://docs.cartesia.ai/api-reference/tts/bytes: generation_config.speed, sonic-3 and newer;
  // Cartesia calls it guidance rather than an exact multiplier
  speed: () => ({ min: 0.6, max: 1.5 }),
  models: ["sonic-3.6", "sonic-3.5", "sonic-3", "sonic-latest"],
};
