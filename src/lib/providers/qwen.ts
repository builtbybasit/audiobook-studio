// Alibaba's Model Studio (DashScope) for Qwen-Audio 3.0, by its long-standing host or a workspace's
// own (https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide).
import type { SpeechProviderShape } from "@/lib/providers/types";

export const qwen: SpeechProviderShape = {
  id: "qwen",
  label: "Qwen (Model Studio)",
  matches: (baseUrl) =>
    /(^|\/\/)(dashscope[a-z-]*\.aliyuncs\.com|[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com)(\/|:|$)/i.test(
      baseUrl,
    ),
  requestPath: () => "/services/audio/tts/SpeechSynthesizer",
  /**
   * WAV at 24 kHz, the combination Alibaba's own example asks for. Its MP3 and other rates are left
   * out until they have been tried against these models.
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
  cloning: null,
  models: ["qwen-audio-3.0-tts-flash", "qwen-audio-3.0-tts-plus"],
};
