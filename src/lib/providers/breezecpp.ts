// Breeze-TTS-2.cpp's `breeze-server`, a server you run yourself
// (https://github.com/HoppouAI/Breeze-TTS-2.cpp/blob/main/docs/server.md). Not BreezeBlue's hosted
// API (`breezeblue.ts`), which is another product.
//
// Its address is any local one, so it is never recognised by its base URL: an endpoint names it
// (`Endpoint.server`), as the preset does. It takes OpenAI's `/audio/speech` body and answers at
// 24 kHz in MP3 or WAV — Opus it is sent as WAV, so it is not offered. Its vocal events are free-form
// words in round brackets, `(laugh)`; delivery goes in `instructions`. Voices are made from one WAV
// and its exact transcript, which it requires, and kept on the server.
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
    // the OpenAI body takes no rate; the model answers at its own
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
  // a server you run yourself bills nothing
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
