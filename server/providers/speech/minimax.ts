// MiniMax's synchronous `POST /v1/t2a_v2`
// (https://platform.minimax.io/docs/api-reference/speech-t2a-http): hex audio in `data.audio`,
// billed characters in `extra_info.usage_characters`. A refusal may come inside a 200 as a nonzero
// `base_resp.status_code`, read by `check`, carrying MiniMax's code and not billed.
import type { SpeechUsage, Voice } from "@/types";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { minimax } from "@/lib/providers/minimax";
import { formatDefaults } from "@/lib/providers/types";
import { audioAnswer, jsonAnswer } from "~/providers/answer";
import type { CloneRequest } from "~/providers/clone";
import { authHeaders, call, jsonHeaders, ProviderError } from "~/providers/http";
import type { SpeechCallOptions } from "~/providers/send";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { onePage, type SpeechWire } from "~/providers/speech/wire";

/**
 * Codes https://platform.minimax.io/docs/api-reference/errorcode says to retry later, plus 2045
 * ("rate growth limit"), which a wait also cures.
 */
const RETRYABLE_CODES = new Set([1000, 1001, 1002, 1024, 1033, 1039, 1041, 2045]);
const RATE_LIMIT_CODES = new Set([1002, 1039, 1041, 2045]);

/** `/v1` on the host, whatever path the base URL was saved with. */
export const miniMaxRoot = (baseUrl: string): string => `${new URL(baseUrl).origin}/v1`;

interface BaseResp {
  base_resp?: { status_code?: number; status_msg?: string };
}

export function refusalIn(target: ProviderTarget, body: BaseResp | null): ProviderError | null {
  const code = body?.base_resp?.status_code;
  if (code == null || code === 0) return null;
  const said = body?.base_resp?.status_msg?.trim();
  return new ProviderError(
    `${target.name} refused the request (${code}${said ? `: ${said}` : ""})`,
    code,
    RETRYABLE_CODES.has(code),
    RATE_LIMIT_CODES.has(code),
  );
}

const checkOf =
  (target: ProviderTarget) =>
  async (res: Response): Promise<ProviderError | null> =>
    refusalIn(target, (await res.json().catch(() => null)) as BaseResp | null);

/** Exported for the tests. Only words are sent; delivery goes inline (`(laughs)`, `<#0.5#>`). */
export function miniMaxBody(
  input: Pick<SpeechInput, "text" | "sampleRate" | "encoding">,
  model: string,
  voice: string,
): Record<string, unknown> {
  const { format, bitrate } = input.encoding;
  const defaults = formatDefaults(minimax, format);
  return {
    model,
    text: input.text,
    stream: false,
    output_format: "hex",
    voice_setting: { voice_id: voice },
    audio_setting: {
      sample_rate: input.sampleRate ?? defaults.rate,
      format,
      channel: 1,
      // bits per second
      ...(format === "mp3" ? { bitrate: (bitrate ?? defaults.bitrate!) * 1000 } : {}),
    },
  };
}

interface MiniMaxAnswer extends BaseResp {
  data?: { audio?: string } | null;
  extra_info?: { usage_characters?: number };
}

/** `Buffer.from` would not check it is whole hex. */
const HEX = /^(?:[0-9a-f]{2})*$/i;

/** MiniMax's own voices and those cloned or designed on the key. */
export async function miniMaxVoices(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
  voiceType: "system" | "all" = "all",
): Promise<{ id: string; label: string }[]> {
  const res = await call(
    target,
    `${miniMaxRoot(target.baseUrl)}/get_voice`,
    {
      method: "POST",
      headers: jsonHeaders(target),
      body: JSON.stringify({ voice_type: voiceType }),
    },
    { signal, ...options, check: checkOf(target) },
  );
  const body = (await res.json().catch(() => null)) as Record<
    string,
    { voice_id?: unknown; voice_name?: unknown }[] | undefined
  > | null;
  const out: { id: string; label: string }[] = [];
  for (const list of ["system_voice", "voice_cloning", "voice_generation"])
    for (const v of body?.[list] ?? []) {
      if (typeof v?.voice_id !== "string" || !v.voice_id) continue;
      const name =
        typeof v.voice_name === "string" && v.voice_name.trim() ? v.voice_name.trim() : "";
      out.push({ id: v.voice_id, label: name || v.voice_id });
    }
  return out;
}

// ---------- cloning ----------
// Two requests (https://platform.minimax.io/docs/guides/speech-voice-clone): `POST /v1/files/upload`
// then `POST /v1/voice_clone` under a `voice_id` we choose. No preview `text` (billed per char).
// A clone that timed out may exist, but MiniMax charges on first use and deletes unused ones.

/**
 * MiniMax wants 8–256 chars, a letter first, `[A-Za-z0-9_-]`, no trailing `-`/`_`, and unused on
 * the account; random hex at the end keeps a repeated title from colliding.
 */
export function miniMaxVoiceId(
  title: string,
  random: () => string = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10),
): string {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  const lead = /^[A-Za-z]/.test(words) ? words : `voice${words ? `-${words}` : ""}`;
  return `${lead}-${random()}`;
}

/** `file.file_id` is an int64, so one past 2^53 is read from the text, not the rounded number. */
function fileIdIn(text: string): string | null {
  let id: unknown;
  try {
    id = (JSON.parse(text) as { file?: { file_id?: unknown } } | null)?.file?.file_id;
  } catch {
    return null;
  }
  if (typeof id === "string") return /^\d+$/.test(id) ? id : null;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) return null;
  if (Number.isSafeInteger(id)) return String(id);
  return /"file_id"\s*:\s*(\d+)/.exec(text)?.[1] ?? null;
}

/** Prefixes a failure with which step it was; a cancel passes through. */
async function step<T>(doing: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    throw new ProviderError(`${doing}: ${e.message}`, e.status, e.retryable, e.rateLimited);
  }
}

async function miniMaxClone(
  target: ProviderTarget,
  request: CloneRequest,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<Voice> {
  // the route enforces `cloning.maxSamples` (1); this is only a guard
  const [sample] = request.samples;
  if (!sample || request.samples.length > 1)
    throw new ProviderError(`${target.name} makes a voice from exactly one sample`, 0, false);
  const root = miniMaxRoot(target.baseUrl);
  const check = checkOf(target);

  const uploading = `Uploading ${sample.name} to ${target.name} failed`;
  const fileId = await step(uploading, async () => {
    const form = new FormData();
    form.set("purpose", "voice_clone");
    form.set("file", sample.blob, sample.name);
    const res = await call(
      target,
      `${root}/files/upload`,
      // no content-type: the multipart boundary is the form's to write
      { method: "POST", headers: authHeaders(target), body: form },
      { signal, ...options, check },
    );
    const id = fileIdIn(await res.text().catch(() => ""));
    if (!id)
      throw new ProviderError(`${target.name} answered without the file's id`, res.status, false);
    return id;
  });

  const voiceId = miniMaxVoiceId(request.title);
  await step(`${sample.name} was uploaded, but making the voice from it failed`, async () => {
    const res = await call(
      target,
      `${root}/voice_clone`,
      {
        method: "POST",
        headers: jsonHeaders(target),
        // digits, not a string: see `fileIdIn`
        body: `{"file_id":${fileId},"voice_id":${JSON.stringify(voiceId)}}`,
      },
      { signal, ...options, check },
    );
    // success must be said, not implied by silence
    const body = (await res.json().catch(() => null)) as BaseResp | null;
    if (body?.base_resp?.status_code !== 0)
      throw new ProviderError(
        `${target.name} answered ${res.status} without saying the voice was made`,
        res.status,
        false,
      );
  });
  return { id: voiceId, label: request.title, gender: "?" };
}

export const miniMaxWire: SpeechWire = {
  clone: miniMaxClone,

  request(input, target, voice) {
    const { format } = input.encoding;
    return {
      url: `${miniMaxRoot(target.baseUrl)}${minimax.requestPath(target.model)}`,
      init: {
        method: "POST",
        headers: jsonHeaders(target),
        body: JSON.stringify(miniMaxBody(input, target.model, voice)),
      },
      format,
      text: input.text,
      // no instructions field, so none are billed
      instructions: "",
      check: checkOf(target),
      async read(res, { signal, counted }) {
        const body = await jsonAnswer<MiniMaxAnswer>(target, res, signal);
        const characters = body.extra_info?.usage_characters;
        const reported: SpeechUsage | null =
          typeof characters === "number" ? normalizeSpeechUsage({ characters }, "plain") : null;
        counted(reported);
        const hex = body.data?.audio;
        if (!hex)
          throw new ProviderError(`${target.name} answered with no audio`, res.status, false);
        if (!HEX.test(hex))
          throw new ProviderError(
            `${target.name} answered with audio that is not whole hex, so it cannot be read`,
            res.status,
            false,
          );
        return audioAnswer(
          target,
          new Response(Buffer.from(hex, "hex"), { status: res.status }),
          signal,
          format,
        );
      },
    };
  },

  /** Lists system voices: needs the key, renders nothing. */
  async probe(target, signal, options) {
    const started = Date.now();
    const voices = await miniMaxVoices(target, signal, options, "system");
    const ms = Date.now() - started;
    return {
      ok: true,
      message: `Answered in ${ms} ms; the key was accepted and it offers ${voices.length} system voices`,
      ms,
    };
  },

  // no gender field
  async voices(target, signal, options) {
    const found = await miniMaxVoices(target, signal, options);
    return onePage(found.map((v) => ({ ...v, gender: "?" as const })));
  },
};
