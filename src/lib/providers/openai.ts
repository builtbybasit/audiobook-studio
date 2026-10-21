// OpenAI's `/audio/speech`, and every server that copies it. `openai` has no expression tags (a
// bracketed word is read out); `compatible` is anything no other provider claims, whose tags the
// person copies from that model's docs.
import type { SpeechProviderShape } from "@/lib/providers/types";

/**
 * `response_format` (https://platform.openai.com/docs/api-reference/audio/createSpeech). No rate
 * or bitrate: the answer is at the model's own.
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
  billsFailures: false,
  cloning: null,
  // https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create;
  // gpt-4o-mini-tts is reported to ignore it
  speed: (model) => (/^tts-1(-hd)?$/.test(model.trim()) ? { min: 0.25, max: 4 } : null),
  models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
};

export const compatible: SpeechProviderShape = {
  id: "compatible",
  label: "OpenAI-compatible",
  matches: () => true,
  requestPath: () => "/audio/speech",
  formats: FORMATS,
  tags: () => ({
    brackets: ["square", "angle", "round"],
    open: false,
    kinds: ["sound", "delivery"],
    example: "[laughter]",
    hint: "Copy the exact syntax from your model's documentation: Orpheus takes <laugh>, others [laughter].",
  }),
  // a server you run yourself bills nothing; a gateway that bills is priced by its own card
  billsFailures: false,
  // `POST /audio/voices` (docs/speech-batch-api.md#voices): one transcript for all samples, and
  // OmniVoice clones from one clip
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 20 * 1024 * 1024,
    formats: ["wav", "mp3", "flac", "m4a", "opus"],
    transcript: "optional",
    advice:
      "One clip of one speaker, about 5 to 15 seconds, with no music or background noise. A " +
      "transcript of what is said helps a model that would otherwise work it out.",
    cost: null,
    fee: null,
    optIn: true,
    deletes: true,
  },
  // omnivoice-fastapi takes 0.5–2 on /audio/speech; other servers often ignore `speed`, so it is
  // stretched here
  speed: (model) => (model.trim() === "omnivoice" ? { min: 0.5, max: 2 } : null),
  models: [],
};
