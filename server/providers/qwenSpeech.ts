// A line spoken by Alibaba's Qwen-Audio 3.0 TTS models, through Model Studio (DashScope).
//
// The request is Model Studio's own (https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide):
// `POST {host}/api/v1/services/audio/tts/SpeechSynthesizer` with a bearer key and a body of the
// model and an `input` holding the words, the voice, the format and the rate. The answer does not
// carry the audio: `output.audio.url` is a link to it, valid for a day, which is fetched at once —
// no key, it is signed — and read as every other body of audio is (`audioAnswer`). The request
// counts as one; the download is part of it.
//
// The host is either the long-standing `dashscope-intl.aliyuncs.com` or a workspace's own
// `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`; Alibaba recommends the second and says the
// first remains fully functional. Only the words are sent: these models take no instructions.
import { AUDIO_MIME } from "@/lib/endpointShapes";
import { audioAnswer, refuseEncoding } from "~/providers/answer";
import { sendSpeech, type SpeechCallOptions } from "~/providers/fishSpeech";
import { call, jsonHeaders, ProviderError } from "~/providers/http";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

/** The rate Alibaba's own example asks for, and the only one offered until others are tried. */
const RATE = 24000;

const apiRoot = (baseUrl: string): string => `${new URL(baseUrl).origin}/api/v1`;

/** The request body for one line. Exported for the tests, which check it against the docs. */
export function qwenBody(
  input: Pick<SpeechInput, "text" | "sampleRate">,
  model: string,
  voice: string,
): Record<string, unknown> {
  return {
    model,
    input: { text: input.text, voice, format: "wav", sample_rate: input.sampleRate ?? RATE },
  };
}

interface QwenAnswer {
  output?: { audio?: { url?: string } };
  code?: string;
  message?: string;
}

export async function qwenSpeak(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  options: SpeechCallOptions,
): Promise<RenderedClip> {
  refuseEncoding(target, input);
  const started = Date.now();
  const audio = await sendSpeech(
    input,
    target,
    {
      url: `${apiRoot(target.baseUrl)}/services/audio/tts/SpeechSynthesizer`,
      init: {
        method: "POST",
        headers: jsonHeaders(target),
        body: JSON.stringify(qwenBody(input, target.model, voice)),
      },
      format: "wav",
      text: input.text,
      // these models take no instructions, so none are billed
      instructions: "",
      read: async (res, signal) => {
        let body: QwenAnswer;
        try {
          body = (await res.json()) as QwenAnswer;
        } catch {
          if (signal.aborted) throw signal.reason;
          throw new ProviderError(
            `${target.name} answered ${res.status} with something that is not JSON`,
            res.status,
            false,
          );
        }
        const url = body.output?.audio?.url;
        if (!url)
          throw new ProviderError(
            `${target.name} answered with no audio link` +
              (body.message ? `: ${body.code ? `${body.code}, ` : ""}${body.message}` : ""),
            res.status,
            false,
          );
        // the link is signed: fetched with nothing but the job's clock and retries
        const file = await call(
          { ...target, apiKey: null },
          url,
          { method: "GET", headers: { accept: AUDIO_MIME.wav } },
          { signal, ...options },
        );
        return { audio: await audioAnswer(target, file, signal, "wav"), reported: null };
      },
    },
    options,
  );
  return { ...audio, ms: Date.now() - started, model: target.model, voice };
}

/**
 * The Test button for Qwen: one page of the account's cloned voices, which needs the key and
 * renders nothing. An empty page is still an accepted key.
 */
export async function qwenProbe(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<ProbeResult> {
  const started = Date.now();
  await call(
    target,
    `${apiRoot(target.baseUrl)}/services/audio/tts/customization`,
    {
      method: "POST",
      headers: jsonHeaders(target),
      body: JSON.stringify({
        model: "voice-enrollment",
        input: { action: "list_voice", page_index: 0, page_size: 1 },
      }),
    },
    { signal, ...options },
  );
  const ms = Date.now() - started;
  return { ok: true, message: `Answered in ${ms} ms; the key was accepted`, ms };
}

/**
 * Each model's system voices, from Alibaba's voice list: a voice belongs to one model and cannot be
 * used with the other. Both models also take over 500 base voices, which can be added by id.
 */
export const QWEN_VOICES: Record<
  string,
  readonly { id: string; label: string; gender: "m" | "f" }[]
> = {
  "qwen-audio-3.0-tts-plus": [
    { id: "longanlingxin", label: "Long An Ling Xin · warm, empathetic (zh, en)", gender: "f" },
    { id: "longanlufeng", label: "Long An Lu Feng · bright, cheerful (zh, en)", gender: "m" },
  ],
  "qwen-audio-3.0-tts-flash": [
    { id: "loongmary", label: "loongmary · warm British (en)", gender: "f" },
    { id: "loongeva_v3.6", label: "loongeva · American (en)", gender: "f" },
    { id: "loongjohn", label: "loongjohn · calm American (en)", gender: "m" },
    { id: "longanfengyue", label: "Long An Feng Yue · natural, friendly (zh, en)", gender: "f" },
    { id: "longanyuanfei", label: "Long An Yuan Fei · proud, regal (zh, en)", gender: "f" },
    { id: "longanlingxi", label: "Long An Ling Xi · cute, sweet (zh, en)", gender: "f" },
    { id: "longanxiaoxin", label: "Long An Xiao Xin · friendly, lively (zh, en)", gender: "f" },
    { id: "longanhuan_v3.6", label: "Long An Huan (zh, en)", gender: "f" },
    { id: "longjielidou_v3.6", label: "Long Jie Li Dou · young boy (zh, en)", gender: "m" },
    { id: "longpaopao_v3.6", label: "Long Pao Pao · child (zh, en)", gender: "f" },
    { id: "longhuohuo_v3.6", label: "Long Huo Huo · mischievous boy (zh, en)", gender: "m" },
    { id: "longchuanshu_v3.6", label: "Long Chuan Shu · Sichuan-accented (zh, en)", gender: "m" },
  ],
};
