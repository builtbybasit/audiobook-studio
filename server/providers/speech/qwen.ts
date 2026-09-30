// A line spoken by Alibaba's Qwen-Audio 3.0 TTS models, through Model Studio (DashScope).
//
// The request is Model Studio's own (https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide):
// `POST {host}/api/v1/services/audio/tts/SpeechSynthesizer` with a bearer key and a body of the
// model and an `input` holding the words, the voice, the format and the rate. The answer does not
// carry the audio: `output.audio.url` is a link to it, valid for a day, which is fetched at once —
// no key, it is signed — and read as every other body of audio is (`audioAnswer`). The request
// counts as one; the download is part of it, and its attempts are counted with the request's.
// Beside the link the answer counts the characters it billed (`usage.characters`, per the API
// reference), which is reported to the ledger.
//
// The host is either the long-standing `dashscope-intl.aliyuncs.com` or a workspace's own
// `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`; Alibaba recommends the second and says the
// first remains fully functional. Only the words are sent. Alibaba's realtime guide says these
// models take instructions, through the realtime API's `instruction`; the HTTP API's reference
// documents no such field for them, so none is sent and none is billed.
//
// A model of the Qwen-TTS family (`qwen3-tts-*`) is spoken at `POST {host}/api/v1/services/aigc/
// multimodal-generation/generation` instead (https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api),
// with only the words and the voice: that API takes no format or rate, and answers WAV at 24 kHz
// with the same link and the same character count. It is here for the one voice-cloning model
// this app speaks, `qwen3-tts-vc-2026-01-22`.
//
// A voice is cloned for it with `POST {host}/api/v1/services/audio/tts/customization`
// (https://www.alibabacloud.com/help/en/model-studio/voice-cloning-user-guide, and the HTTP
// reference https://www.alibabacloud.com/help/doc-detail/3027318.html): model
// `qwen-voice-enrollment`, action `create`, the endpoint's model as `target_model` — the voice
// works with that model and no other — a `preferred_name` made from the title, and the recording
// itself as a base64 data URL under `audio.data`. The answer's `output.voice` is the id a line is
// spoken with. The Qwen-Audio 3.0 models are cloned for through the older `voice-enrollment`, which
// takes a recording only as a public link, so for them the clone is refused before anything is
// sent. The recording's language is sent as English: Model Studio assumes Chinese when none is
// named, and the books this app reads are English.
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

/** Where voices are made, listed and removed, for every model family. */
const customizationUrl = (baseUrl: string): string =>
  `${apiRoot(baseUrl)}/services/audio/tts/customization`;

/** The request body for one line. Exported for the tests, which check it against the docs. */
export function qwenBody(
  input: Pick<SpeechInput, "text" | "sampleRate">,
  model: string,
  voice: string,
): Record<string, unknown> {
  // the Qwen-TTS API takes the words and the voice, and answers at its own format and rate
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

/**
 * What a voice is asked for as: letters, digits and underscores, at most 16 — the rule the HTTP
 * reference gives `preferred_name`, which it calls a prefix for the voice's name: the id itself is
 * Model Studio's, and comes back in the answer. The title stays the voice's label here.
 */
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

/** Why a voice cannot be cloned for the endpoint's model; empty when it can. */
function uncloneableModel(target: ProviderTarget): string {
  if ((QWEN_CLONE_MODELS as readonly string[]).includes(target.model)) return "";
  return (
    `${target.name} cannot make a voice from a file for “${target.model}”: Model Studio takes a ` +
    `file to clone from only for ${QWEN_CLONE_MODELS.join(", ")}, and a voice works only with the ` +
    "model it was made for. Set the endpoint's model to that on the Endpoints page, then clone."
  );
}

/** A voice in `qwen-voice-enrollment`'s `list` answer. */
interface EnrolledVoice {
  voice?: unknown;
  target_model?: unknown;
}

/** The HTTP reference's own page size; it documents no larger one. A list is read up to a cap. */
const ENROLLED_PAGE = 10;
const ENROLLED_PAGES = 30;

interface QwenAnswer {
  output?: { audio?: { url?: string } };
  usage?: { characters?: unknown };
  code?: string;
  message?: string;
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

export const qwenWire: SpeechWire = {
  async clone(target, request, signal, options) {
    const problem = uncloneableModel(target);
    if (problem) throw new ProviderError(problem, 0, false);
    // one recording: the route holds a clone to `cloning.maxSamples`, which is 1
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
            // the blob is typed by its bytes: audio/wav, audio/mpeg or audio/mp4, as the docs list
            audio: { data: `data:${sample.blob.type};base64,${data}` },
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
      // no documented instructions field on this API (see the header), so none are billed
      instructions: "",
      async read(res, context) {
        const body = await jsonAnswer<QwenAnswer>(target, res, context.signal);
        // a count of 0 is a model that counted tokens instead, which says nothing about characters
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
        // the link is signed: fetched with nothing but the job's clock and retries
        const file = await context.call({ ...target, apiKey: null }, url, {
          method: "GET",
          headers: { accept: AUDIO_MIME.wav },
        });
        return audioAnswer(target, file, context.signal, "wav");
      },
    };
  },

  /**
   * One page of the account's cloned voices, which needs the key and renders nothing. An empty
   * page is still an accepted key.
   */
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

  /**
   * A Qwen-Audio model's system voices, written down in Alibaba's voice list: nothing to ask for.
   * A voice-cloning model has none, only the voices made for it, which are asked of
   * `qwen-voice-enrollment` a page at a time and kept to those made for this model — another
   * model cannot speak them. The list names each by its id alone, so that is its label too.
   */
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
    // `hasMore` here means the cap was reached with the list still going
    return { voices, total: voices.length, page: 1, hasMore: more };
  },
};
