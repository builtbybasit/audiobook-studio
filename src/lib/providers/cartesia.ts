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
  cloning: null,
  models: ["sonic-3.6", "sonic-3.5", "sonic-3", "sonic-latest"],
};
