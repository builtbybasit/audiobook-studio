// OpenAI's `/audio/speech`, and every server that copies it.
//
// Two descriptions share one wire shape. `openai` is OpenAI's own API, known by its host: its
// voices and models are written down in its docs, and it documents no expression tags — a
// bracketed word sent to it is read out as a word. `compatible` is everything no other description
// claims — Kokoro-FastAPI, an Orpheus or Piper bridge, vLLM-Omni — taken to speak OpenAI's shape,
// because that is what they copy. What tags such a server's model takes is its own business, so
// the person writes them in any of the usual shapes, copied from that model's docs.
import { ANGLE, ROUND, SQUARE, type SpeechProviderShape } from "@/lib/providers/types";

/**
 * `response_format` (https://platform.openai.com/docs/api-reference/audio/createSpeech): it also
 * offers AAC, FLAC and raw PCM, which this app does not keep clips in. It takes no rate and no
 * bitrate; the answer is at the model's own.
 */
const FORMATS: SpeechProviderShape["formats"] = (
  [
    ["wav", "WAV"],
    ["mp3", "MP3"],
    ["opus", "Opus"],
  ] as const
).map(([format, label]) => ({
  format,
  label,
  rates: null,
  defaultRate: null,
  bitrates: [],
  defaultBitrate: null,
}));

export const openai: SpeechProviderShape = {
  id: "openai",
  label: "OpenAI",
  matches: (baseUrl) => /(^|\/\/)api\.openai\.com(\/|:|$)/i.test(baseUrl),
  requestPath: () => "/audio/speech",
  formats: FORMATS,
  tags: () => null,
  // OpenAI's pricing is per character or token of what it speaks; it says nothing of refusals.
  billsFailures: false,
  models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
};

export const compatible: SpeechProviderShape = {
  id: "compatible",
  label: "OpenAI-compatible",
  matches: () => true,
  requestPath: () => "/audio/speech",
  formats: FORMATS,
  tags: () => ({
    forms: [SQUARE, ANGLE, ROUND],
    kinds: ["sound", "delivery"],
    example: "[laughter]",
    hint: "Copy the exact syntax from your model's documentation: Orpheus takes <laugh>, others [laughter].",
  }),
  // a server you run yourself bills nothing; a gateway that bills is priced by its own card
  billsFailures: false,
  models: [],
};
