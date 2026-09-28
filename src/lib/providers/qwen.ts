// Alibaba's Model Studio (DashScope) for Qwen-Audio 3.0, by its long-standing host or a workspace's
// own (https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide), and for the
// Qwen-TTS voice-cloning model a voice made from a file is spoken with
// (https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api).
import type { SpeechProviderShape } from "@/lib/providers/types";

/**
 * The models a voice can be cloned for from a file this app holds. Model Studio's voice cloning
 * (https://www.alibabacloud.com/help/en/model-studio/voice-cloning-user-guide, and its HTTP
 * reference https://www.alibabacloud.com/help/doc-detail/3027318.html) makes a voice for one
 * `target_model`, and only that model can speak it. For the Qwen-Audio 3.0 models it takes the
 * recording only as a publicly reachable link, which an app on your own machine does not have; for
 * the Qwen-TTS family (`qwen-voice-enrollment`) it also takes the file itself, as a data URL. Of
 * that family's models only this one is spoken over HTTP — the others are its realtime ones, which
 * this app does not speak — so a voice made for any other would cost a cent and never be heard.
 */
export const QWEN_CLONE_MODELS = ["qwen3-tts-vc-2026-01-22"] as const;

/**
 * Whether `model` is one of the Qwen-TTS family, which Model Studio speaks at its multimodal
 * generation path (https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api) rather than
 * the Qwen-Audio models' `SpeechSynthesizer`.
 */
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
  /**
   * WAV at 24 kHz, the combination Alibaba's own example asks for — and all the Qwen-TTS API
   * answers with. Its MP3 and other rates are left out until they have been tried against these
   * models.
   */
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
  // Model Studio documents no inline tags for these models; delivery is an instruction, which
  // only its realtime API is documented to take for them.
  tags: () => null,
  // nothing in Model Studio's docs says a refused request is charged
  billsFailures: false,
  // https://www.alibabacloud.com/help/en/model-studio/voice-cloning-user-guide and the HTTP
  // reference https://www.alibabacloud.com/help/doc-detail/3027318.html: one recording per voice,
  // WAV (16-bit), MP3 or M4A — sent as `audio/wav`, `audio/mpeg` or `audio/mp4` — of at most 10 MB,
  // 10 to 20 seconds recommended and 60 at most, mono at 24 kHz or more. The limit is on the file;
  // the request carries it as base64, a third larger again.
  cloning: {
    maxSamples: 1,
    maxSampleBytes: 10 * 1024 * 1024,
    formats: ["wav", "mp3", "m4a"],
    // Qwen-Audio 3.0 enrols only from a public URL, which a file picked here does not have
    models: QWEN_CLONE_MODELS,
    advice:
      "Model Studio makes a voice from one recording of 10–20 seconds (60 at most): mono, " +
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
