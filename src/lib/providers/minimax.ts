// MiniMax (https://platform.minimax.io/docs/api-reference/speech-t2a-http): `POST /v1/t2a_v2`,
// answered with JSON carrying the audio as hex.
import type { SpeechProviderShape } from "@/lib/providers/types";

/** `(laughs)`, `(clear-throat)`: the interjections its reference lists, lower case and hyphens. */
const INTERJECTION = /^\([a-z][a-z-]{1,30}\)$/;
/** `<#0.5#>`: a pause of 0.01 to 99.99 seconds. */
const PAUSE = /^<#\d{1,2}(\.\d{1,2})?#>$/;

const RATES = [16000, 22050, 24000, 32000, 44100] as const;

export const minimax: SpeechProviderShape = {
  id: "minimax",
  label: "MiniMax",
  matches: (baseUrl) => /(^|\/\/)([a-z0-9-]+\.)*minimax\.(io|chat|cn)(\/|:|$)/i.test(baseUrl),
  requestPath: () => "/t2a_v2",
  /**
   * `audio_setting`: a rate up to 44.1 kHz — it has no 48 — and for an MP3 a bitrate, in bits a
   * second on the wire. Its Ogg Opus is left out until its rates are known. What this app asks for
   * when no rate is set is 32 kHz, the rate MiniMax's own example uses.
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
  // Its reference: pauses as `<#x#>` on every model; interjections — `(laughs)`, `(sighs)`,
  // `(breath)` — "only supported when using speech-2.8-hd or speech-2.8-turbo". Both are sounds.
  tags: (model) =>
    /^speech-2\.8-/i.test(model.trim())
      ? {
          forms: [INTERJECTION, PAUSE],
          kinds: ["sound"],
          example: "(laughs)",
          hint: "MiniMax's 2.8 models take the interjections its reference lists, such as (sighs), and pauses as <#0.5#>.",
        }
      : {
          forms: [PAUSE],
          kinds: ["sound"],
          example: "<#0.5#>",
          hint: "MiniMax's models before 2.8 take only pauses, in seconds, as <#0.5#>.",
        },
  // Its error codes are refusals to retry or fix; nothing in its docs says one is charged.
  billsFailures: false,
  cloning: null,
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
