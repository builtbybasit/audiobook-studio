// MiniMax (https://platform.minimax.io/docs/api-reference/speech-t2a-http): `POST /v1/t2a_v2`,
// answered with JSON carrying the audio as hex.
import type { SpeechProviderShape } from "@/lib/providers/types";

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
          brackets: ["round", "angle"],
          open: false,
          kinds: ["sound"],
          example: "(laughs)",
          hint: "MiniMax's 2.8 models take the interjections its reference lists, such as (sighs), and pauses as <#0.5#>.",
        }
      : {
          brackets: ["angle"],
          open: false,
          kinds: ["sound"],
          example: "<#0.5#>",
          hint: "MiniMax's models before 2.8 take only pauses, in seconds, as <#0.5#>.",
        },
  // Its error codes are refusals to retry or fix; nothing in its docs says one is charged.
  billsFailures: false,
  // https://platform.minimax.io/docs/api-reference/voice-cloning-clone and the guide beside it,
  // https://platform.minimax.io/docs/guides/speech-voice-clone: one file, uploaded for
  // `voice_clone`, in MP3, M4A or WAV, of 10 seconds to 5 minutes and up to 20 MB. The fee is on
  // https://platform.minimax.io/docs/guides/pricing-paygo (rapid voice cloning), and the deletion
  // of a voice left unused is the first line of the clone reference. `get_voice`
  // (https://platform.minimax.io/docs/api-reference/voice-management-get) lists a cloned voice
  // "only after first use", so a new one is not in "Fetch from server" until it has spoken.
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 20 * 1024 * 1024,
    formats: ["wav", "mp3", "m4a"],
    // The clone reference's `text_validation` is not a transcript the voice is made with but a
    // check: MiniMax transcribes the sample and refuses the clone (1043) when the two differ, so
    // none is sent. `clone_prompt.prompt_text` belongs to a second, prompt clip this app does not send.
    transcript: "none",
    advice:
      "MiniMax makes a voice from one clip of 10 seconds to 5 minutes. " +
      "It shows under Fetch from server once a line has been spoken with it.",
    cost:
      "MiniMax charges $1.50 a voice the first time a line is spoken with it, not when it is " +
      "made, and deletes a voice that is not used within 7 days.",
    fee: { usd: 1.5, when: "first-use", said: "$1.50 a voice, charged when it first speaks" },
  },
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
