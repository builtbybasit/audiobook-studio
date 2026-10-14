// Alibaba's Model Studio (DashScope): Qwen-Audio 3.0
// (https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide) and the Qwen-TTS
// cloning model (https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api).
import type { SpeechProviderShape } from "@/lib/providers/types";

/**
 * A clone is made for one `target_model` only. Qwen-Audio 3.0 enrols only from a public URL; of
 * the Qwen-TTS family only this model is spoken over HTTP (the rest are realtime), so a voice for
 * any other would cost a cent and never be heard.
 */
export const QWEN_CLONE_MODELS = ["qwen3-tts-vc-2026-01-22"] as const;

/** Qwen-TTS is spoken at the multimodal generation path, not `SpeechSynthesizer`. */
export const isQwenTts = (model: string): boolean => /^qwen3?-tts(-|$)/i.test(model.trim());

export const qwen: SpeechProviderShape = {
  id: "qwen",
  label: "Qwen (Model Studio)",
  matches: (baseUrl) =>
    /(^|\/\/)(dashscope[a-z-]*\.aliyuncs\.com|[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com)(\/|:|$)/i.test(
      baseUrl,
    ),
  requestPath: (model) =>
    isQwenTts(model)
      ? "/services/aigc/multimodal-generation/generation"
      : "/services/audio/tts/SpeechSynthesizer",
  /** WAV at 24 kHz, as Alibaba's example asks and Qwen-TTS answers; other formats are untried. */
  formats: [
    {
      format: "wav",
      label: "WAV · 16-bit PCM, mono",
      rates: [24000],
      defaultRate: 24000,
      bitrates: [],
      defaultBitrate: null,
    },
  ],
  // no documented inline tags; only the realtime API takes delivery instructions
  tags: () => null,
  // nothing in Model Studio's docs says a refused request is charged
  billsFailures: false,
  // https://www.alibabacloud.com/help/en/model-studio/voice-cloning-user-guide and
  // https://www.alibabacloud.com/help/doc-detail/3027318.html: one clip, at most 10 MB as a file
  // (sent as base64, a third larger)
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 10 * 1024 * 1024,
    formats: ["wav", "mp3", "m4a"],
    models: QWEN_CLONE_MODELS,
    transcript: "optional",
    advice:
      "Model Studio makes a voice from one clip of 10–20 seconds (60 at most): mono, " +
      "24 kHz or better, one speaker in complete sentences with no music or noise. The voice " +
      "works only with the model it was made for, qwen3-tts-vc-2026-01-22 — change the " +
      "endpoint's model and it can no longer be spoken with.",
    cost:
      "Model Studio charges $0.01 for each voice made, and nothing for one it failed to make; " +
      "in Singapore the first 1,000 in your first 90 days are free.",
    fee: { usd: 0.01, when: "made", said: "$0.01 a voice" },
  },
  models: ["qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-plus", ...QWEN_CLONE_MODELS],
};
