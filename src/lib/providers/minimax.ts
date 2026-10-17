// MiniMax (https://platform.minimax.io/docs/api-reference/speech-t2a-http): `POST /v1/t2a_v2`,
// answered with JSON carrying the audio as hex.
import { pauseSecs, type SpeechProviderShape } from "@/lib/providers/types";

const RATES = [16000, 22050, 24000, 32000, 44100] as const;

/** `<#x#>`, clamped to the documented 0.01–99.99 s */
const pause = (s: number): string => `<#${pauseSecs(Math.min(Math.max(s, 0.01), 99.99))}#>`;

export const minimax: SpeechProviderShape = {
  id: "minimax",
  label: "MiniMax",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*minimax\.(io|chat|cn)(\/|:|$)/i.test(baseUrl),
  requestPath: () => "/t2a_v2",
  /**
   * `audio_setting`: up to 44.1 kHz, MP3 bitrate in bps on the wire. Ogg Opus is left out until its
   * rates are known. 32 kHz default, as MiniMax's own example uses.
   */
  formats: [
    {
      format: "wav",
      label: "WAV · 16-bit PCM, mono",
      rates: RATES,
      defaultRate: 32000,
      bitrates: [],
      defaultBitrate: null,
    },
    {
      format: "mp3",
      label: "MP3 · mono",
      rates: RATES,
      defaultRate: 32000,
      bitrates: [32, 64, 128, 256].map((value) => ({ value, label: `${value} kbps` })),
      defaultBitrate: 128,
    },
  ],
  // pauses on every model, between speakable text only; interjections only on speech-2.8
  // (https://platform.minimax.io/docs/api-reference/speech-t2a-http)
  tags: (model) =>
    /^speech-2\.8-/i.test(model.trim())
      ? {
          brackets: ["round", "angle"],
          open: false,
          kinds: ["sound"],
          example: "(laughs)",
          hint: "MiniMax's 2.8 models take the interjections its reference lists, such as (sighs), and pauses as <#0.5#>.",
          pause,
          pauseInside: true,
        }
      : {
          brackets: ["angle"],
          open: false,
          kinds: ["sound"],
          example: "<#0.5#>",
          hint: "MiniMax's models before 2.8 take only pauses, in seconds, as <#0.5#>.",
          pause,
          pauseInside: true,
        },
  billsFailures: false,
  // https://platform.minimax.io/docs/api-reference/voice-cloning-clone; fee on
  // https://platform.minimax.io/docs/guides/pricing-paygo. `get_voice` lists a clone only after
  // first use (https://platform.minimax.io/docs/api-reference/voice-management-get).
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 20 * 1024 * 1024,
    formats: ["wav", "mp3", "m4a"],
    // `text_validation` is a check that refuses the clone (1043) on a mismatch, not a transcript
    transcript: "none",
    advice:
      "MiniMax makes a voice from one clip of 10 seconds to 5 minutes. " +
      "It shows under Fetch from server once a line has been spoken with it.",
    cost:
      "MiniMax charges $1.50 a voice the first time a line is spoken with it, not when it is " +
      "made, and deletes a voice that is not used within 7 days.",
    fee: { usd: 1.5, when: "first-use", said: "$1.50 a voice, charged when it first speaks" },
  },
  // https://platform.minimax.io/docs/api-reference/speech-t2a-http: voice_setting.speed
  speed: () => ({ min: 0.5, max: 2 }),
  models: [
    "speech-2.8-hd",
    "speech-2.8-turbo",
    "speech-2.6-hd",
    "speech-2.6-turbo",
    "speech-02-hd",
    "speech-02-turbo",
    "speech-01-hd",
    "speech-01-turbo",
  ],
};
