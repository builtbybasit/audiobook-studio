// Alibaba Model Studio TTS (https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide).
// The answer links to signed audio, fetched as part of the same request; `usage.characters` is
// billed. No documented instructions field. `qwen3-tts-*` models use the multimodal-generation
// route (https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api).
import type { SpeechUsage } from "@/types";
import { AUDIO_MIME } from "@/lib/endpointShapes";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { isQwenTts, qwen, QWEN_CLONE_MODELS } from "@/lib/providers/qwen";
import { formatDefaults } from "@/lib/providers/types";
import { audioAnswer, jsonAnswer } from "~/providers/answer";
import { call, jsonHeaders, ProviderError } from "~/providers/http";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { onePage, type SpeechWire } from "~/providers/speech/wire";

const apiRoot = (baseUrl: string): string => `${new URL(baseUrl).origin}/api/v1`;

const customizationUrl = (baseUrl: string): string =>
  `${apiRoot(baseUrl)}/services/audio/tts/customization`;

/** Exported for the tests. */
export function qwenBody(
  input: Pick<SpeechInput, "text" | "sampleRate">,
  model: string,
  voice: string,
): Record<string, unknown> {
  // the Qwen-TTS API takes no format or rate; it answers 24 kHz WAV
  if (isQwenTts(model)) return { model, input: { text: input.text, voice } };
  return {
    model,
    input: {
      text: input.text,
      voice,
      format: "wav",
      sample_rate: input.sampleRate ?? formatDefaults(qwen, "wav").rate,
    },
  };
}

/** `preferred_name`: `[A-Za-z0-9_]`, at most 16; only a prefix, the id comes back in the answer. */
export function qwenPreferredName(title: string): string {
  const name = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16)
    .replace(/_+$/, "");
  return name || "voice";
}

/**
 * Empty when the model can be cloned for. The Qwen-Audio 3.0 models' `voice-enrollment` takes a
 * sample only as a public link, so they are refused.
 */
function uncloneableModel(target: ProviderTarget): string {
  if ((QWEN_CLONE_MODELS as readonly string[]).includes(target.model)) return "";
  return (
    `${target.name} cannot make a voice from a file for “${target.model}”: Model Studio takes a ` +
    `file to clone from only for ${QWEN_CLONE_MODELS.join(", ")}, and a voice works only with the ` +
    "model it was made for. Set the endpoint's model to that on the Endpoints page, then clone."
  );
}

interface EnrolledVoice {
  voice?: unknown;
  target_model?: unknown;
}

/** The documented page size; read up to a cap of pages. */
const ENROLLED_PAGE = 10;
const ENROLLED_PAGES = 30;

interface QwenAnswer {
  output?: { audio?: { url?: string } };
  usage?: { characters?: unknown };
  code?: string;
  message?: string;
}

/** From Alibaba's voice list; each voice works with one model only. 500+ more can be added by id. */
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

export const qwenWire: SpeechWire = {
  // https://www.alibabacloud.com/help/en/model-studio/voice-cloning-user-guide and
  // https://www.alibabacloud.com/help/doc-detail/3027318.html. The voice works only with
  // `target_model`. Language is sent as English: Model Studio assumes Chinese otherwise.
  async clone(target, request, signal, options) {
    const problem = uncloneableModel(target);
    if (problem) throw new ProviderError(problem, 0, false);
    // the route enforces `cloning.maxSamples` (1)
    const [sample] = request.samples;
    const data = Buffer.from(await sample.blob.arrayBuffer()).toString("base64");
    const res = await call(
      target,
      customizationUrl(target.baseUrl),
      {
        method: "POST",
        headers: jsonHeaders(target),
        body: JSON.stringify({
          model: "qwen-voice-enrollment",
          input: {
            action: "create",
            target_model: target.model,
            preferred_name: qwenPreferredName(request.title),
            // typed by its bytes: audio/wav, audio/mpeg or audio/mp4, as the docs list
            audio: { data: `data:${sample.blob.type};base64,${data}` },
            ...(sample.transcript ? { text: sample.transcript } : {}),
            language: "en",
          },
        }),
      },
      { signal, ...options },
    );
    const body = (await res.json().catch(() => null)) as {
      output?: { voice?: unknown };
      code?: unknown;
      message?: unknown;
    } | null;
    const voice = body?.output?.voice;
    if (typeof voice !== "string" || !voice)
      throw new ProviderError(
        `${target.name} answered ${res.status} without the new voice's id` +
          (typeof body?.message === "string" && body.message
            ? `: ${typeof body.code === "string" && body.code ? `${body.code}, ` : ""}${body.message}`
            : ""),
        res.status,
        false,
      );
    return { id: voice, label: request.title, gender: "?" };
  },

  request(input, target, voice) {
    return {
      url: `${apiRoot(target.baseUrl)}${qwen.requestPath(target.model)}`,
      init: {
        method: "POST",
        headers: jsonHeaders(target),
        body: JSON.stringify(qwenBody(input, target.model, voice)),
      },
      format: "wav",
      text: input.text,
      // no documented instructions field, so none are billed
      instructions: "",
      async read(res, context) {
        const body = await jsonAnswer<QwenAnswer>(target, res, context.signal);
        // 0 means the model counted tokens instead
        const characters = body.usage?.characters;
        const reported: SpeechUsage | null =
          typeof characters === "number" && characters > 0
            ? normalizeSpeechUsage({ characters }, "plain")
            : null;
        context.counted(reported);
        const url = body.output?.audio?.url;
        if (!url)
          throw new ProviderError(
            `${target.name} answered with no audio link` +
              (body.message ? `: ${body.code ? `${body.code}, ` : ""}${body.message}` : ""),
            res.status,
            false,
          );
        // the link is signed: no key
        const file = await context.call({ ...target, apiKey: null }, url, {
          method: "GET",
          headers: { accept: AUDIO_MIME.wav },
        });
        return audioAnswer(target, file, context.signal, "wav");
      },
    };
  },

  /** Lists one cloned voice: needs the key, renders nothing. */
  async probe(target, signal, options) {
    const started = Date.now();
    await call(
      target,
      customizationUrl(target.baseUrl),
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
  },

  /** Qwen-Audio: `QWEN_VOICES`. A cloning model: only the voices enrolled for it. */
  async voices(target, signal, options) {
    if (!isQwenTts(target.model)) return onePage([...(QWEN_VOICES[target.model] ?? [])]);
    const voices: { id: string; label: string; gender: "?" }[] = [];
    let more = true;
    for (let page = 0; more && page < ENROLLED_PAGES; page++) {
      const res = await call(
        target,
        customizationUrl(target.baseUrl),
        {
          method: "POST",
          headers: jsonHeaders(target),
          body: JSON.stringify({
            model: "qwen-voice-enrollment",
            input: { action: "list", page_size: ENROLLED_PAGE, page_index: page },
          }),
        },
        { signal, ...options },
      );
      const body = await jsonAnswer<{
        output?: { voice_list?: EnrolledVoice[]; total_count?: unknown };
      }>(target, res, signal);
      const items = body.output?.voice_list ?? [];
      for (const v of items)
        if (typeof v.voice === "string" && v.voice && v.target_model === target.model)
          voices.push({ id: v.voice, label: v.voice, gender: "?" });
      const total = body.output?.total_count;
      more =
        items.length > 0 &&
        (typeof total === "number"
          ? (page + 1) * ENROLLED_PAGE < total
          : items.length === ENROLLED_PAGE);
    }
    // `hasMore`: the cap was reached with the list still going
    return { voices, total: voices.length, page: 1, hasMore: more };
  },
};
