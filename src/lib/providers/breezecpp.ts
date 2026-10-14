// Breeze-TTS-2.cpp's `breeze-server`, self-hosted
// (https://github.com/HoppouAI/Breeze-TTS-2.cpp/blob/main/docs/server.md); not BreezeBlue's API.
// Any local address, so an endpoint names it (`Endpoint.server`). It answers Opus requests with
// WAV, so Opus is not offered.
import type { SpeechProviderShape } from "@/lib/providers/types";

export const breezecpp: SpeechProviderShape = {
  id: "breezecpp",
  label: "Breeze-TTS-2.cpp",
  matches: () => false,
  requestPath: () => "/audio/speech",
  formats: (
    [
      ["wav", "WAV"],
      ["mp3", "MP3"],
    ] as const
  ).map(([format, label]) => ({
    format,
    label,
    // the OpenAI body takes no rate
    rates: null,
    defaultRate: 24000,
    bitrates: [],
    defaultBitrate: null,
  })),
  tags: () => ({
    brackets: ["round"],
    open: true,
    kinds: ["sound"],
    example: "(laugh)",
    hint:
      "Breeze's README: (laugh), (sigh), (cough) and (clears throat) are the reliable ones, and " +
      "any descriptive words often work. At its default cfg_scale of 1 it often ignores them.",
  }),
  billsFailures: false,
  models: [],
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 20 * 1024 * 1024,
    // it reads only WAV; the server turns any of these into one before sending (`breezecpp.ts`)
    formats: ["wav", "mp3", "flac", "m4a", "opus"],
    transcript: "required",
    advice:
      "One clip of one speaker, a few seconds long, with the exact words said in it. The voice is " +
      "saved on the server under its name.",
    cost: null,
    fee: null,
  },
};
