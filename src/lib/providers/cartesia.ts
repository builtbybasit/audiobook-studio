// Cartesia (https://docs.cartesia.ai/api-reference/tts/bytes): `POST /tts/bytes` at the host root,
// with a `Cartesia-Version` header.
import type { SpeechProviderShape } from "@/lib/providers/types";

/**
 * Its SSML guide's self-closing tags — a pause, and the emotion, speed and volume a stretch of the
 * transcript is spoken with — and `[laughter]`, which that guide's title still names.
 */
const SSML = [
  /^<break time="\d+(\.\d+)?m?s"\s*\/>$/,
  /^<emotion value="[a-z_]+"\s*\/>$/,
  /^<(speed|volume) ratio="\d(\.\d+)?"\s*\/>$/,
  /^\[laughter\]$/,
];

export const cartesia: SpeechProviderShape = {
  id: "cartesia",
  label: "Cartesia",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*cartesia\.ai(\/|:|$)/i.test(baseUrl),
  requestPath: () => "/tts/bytes",
  /**
   * `output_format`: WAV as 16-bit PCM at any of its rates, 44.1 kHz when none is set (the rate its
   * own example uses); MP3 offered at 44.1 kHz and 64 to 192 kbps. It has no Opus.
   */
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
  tags: () => ({
    forms: SSML,
    kinds: ["sound", "delivery"],
    example: '<break time="1s"/>',
    hint: 'Sonic takes SSML-like tags: <break time="1s"/>, <emotion value="calm"/>, <speed ratio="0.8"/>, and [laughter].',
  }),
  // Its pricing page: "Credits are only used by successful requests; errors will not consume credits."
  billsFailures: false,
  // https://docs.cartesia.ai/api-reference/voices/clone: one `clip` of at most 16 MB, in FLAC, MP3,
  // Ogg, WAV or WebM — of which the sniffer knows all but WebM, and Opus as Ogg's. No M4A. The
  // advice is https://docs.cartesia.ai/build-with-cartesia/capability-guides/clone-voices. The
  // pricing page (https://cartesia.ai/pricing, read 2026-09-28) charges no credits for an instant
  // clone but leaves it off the Free plan: it starts with Pro, $5 a month.
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 16 * 1024 * 1024,
    formats: ["wav", "mp3", "flac", "opus"],
    advice:
      "Cartesia makes a voice from one clip: 10 seconds is enough, and up to 60 keeps more of the " +
      "accent. One speaker, no background noise, spoken naturally in the mood the voice should have.",
    cost: "No credits per voice, but instant cloning needs Cartesia's Pro plan or above.",
    fee: null,
  },
  models: ["sonic-3.6", "sonic-3.5", "sonic-3", "sonic-latest"],
};
