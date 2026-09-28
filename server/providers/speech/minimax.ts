// A line spoken by MiniMax, through its synchronous `POST /v1/t2a_v2`.
//
// MiniMax is its own shape (https://platform.minimax.io/docs/api-reference/speech-t2a-http): a
// bearer key, a JSON body naming the model, the words, the voice in `voice_setting` and the format
// in `audio_setting`, and a JSON answer carrying the audio as a hex string in `data.audio` beside
// `extra_info` — whose `usage_characters` is the count MiniMax bills, reported to the ledger.
//
// A refusal does not always come back as an HTTP error: the answer carries `base_resp`, and a
// `status_code` other than 0 is MiniMax saying no — a bad key (1004, 2049), an empty balance
// (1008), a rate limit (1002, 1039, 1041, 2045), a voice this key cannot use (20132, 2042). The
// answer is read for it before it is accepted (`check`), so a refusal its error-code page says to
// retry later is retried in `call`'s loop as a 429 would be, a rate limit after the endpoint's
// cooldown, and any other is a failure that says what MiniMax said. The failure carries MiniMax's
// code rather than the 200 it arrived in, and is not billed: nothing was generated.
//
// Only the words are sent. MiniMax takes delivery as interjections in the text — `(laughs)`,
// `(sighs)` — and pauses as `<#0.5#>`, which is what the endpoint's Expressions tab is for.
import type { SpeechUsage } from "@/types";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { audioAnswer, jsonAnswer } from "~/providers/answer";
import { call, jsonHeaders, ProviderError } from "~/providers/http";
import type { SpeechCallOptions } from "~/providers/send";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { onePage, type SpeechWire } from "~/providers/speech/wire";

/** What this app asks for when the endpoint names no rate: the rate MiniMax's own example uses. */
const DEFAULT_RATE = 32000;
const DEFAULT_MP3_KBPS = 128;

/**
 * `base_resp` codes whose answer on https://platform.minimax.io/docs/api-reference/errorcode is to
 * retry later — an unknown or internal error, a timeout, a limit — and 2045, "rate growth limit",
 * which asks for a steadier pace, which is what a wait gives it.
 */
const RETRYABLE_CODES = new Set([1000, 1001, 1002, 1024, 1033, 1039, 1041, 2045]);
/** Of those, the ones that are a limit on how fast or how much, as a 429 is. */
const RATE_LIMIT_CODES = new Set([1002, 1039, 1041, 2045]);

/** MiniMax serves its API under `/v1` on its host, whatever path the base URL was saved with. */
export const miniMaxRoot = (baseUrl: string): string => `${new URL(baseUrl).origin}/v1`;

interface BaseResp {
  base_resp?: { status_code?: number; status_msg?: string };
}

/** The refusal `body.base_resp` describes, or null when it describes none. */
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

/** The `check` for every MiniMax request: its answer, read for a refusal in `base_resp`. */
const checkOf =
  (target: ProviderTarget) =>
  async (res: Response): Promise<ProviderError | null> =>
    refusalIn(target, (await res.json().catch(() => null)) as BaseResp | null);

/** The request body for one line. Exported for the tests, which check it against the docs. */
export function miniMaxBody(
  input: Pick<SpeechInput, "text" | "sampleRate" | "encoding">,
  model: string,
  voice: string,
): Record<string, unknown> {
  const { format, bitrate } = input.encoding;
  return {
    model,
    text: input.text,
    stream: false,
    output_format: "hex",
    voice_setting: { voice_id: voice },
    audio_setting: {
      sample_rate: input.sampleRate ?? DEFAULT_RATE,
      format,
      channel: 1,
      // MiniMax spells an MP3's bitrate in bits a second
      ...(format === "mp3" ? { bitrate: (bitrate ?? DEFAULT_MP3_KBPS) * 1000 } : {}),
    },
  };
}

interface MiniMaxAnswer extends BaseResp {
  data?: { audio?: string } | null;
  extra_info?: { usage_characters?: number };
}

/** A whole hex string: pairs of hex digits and nothing else, which `Buffer.from` would not check. */
const HEX = /^(?:[0-9a-f]{2})*$/i;

/** One page of the voices a key can use: MiniMax's own, and those cloned or designed on it. */
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

export const miniMaxWire: SpeechWire = {
  request(input, target, voice) {
    const { format } = input.encoding;
    return {
      url: `${miniMaxRoot(target.baseUrl)}/t2a_v2`,
      init: {
        method: "POST",
        headers: jsonHeaders(target),
        body: JSON.stringify(miniMaxBody(input, target.model, voice)),
      },
      format,
      text: input.text,
      // no instructions field (see the header), so none are billed
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
        // decoded, the audio is what `format` asked for, and is read the way a body of it would be
        return audioAnswer(
          target,
          new Response(Buffer.from(hex, "hex"), { status: res.status }),
          signal,
          format,
        );
      },
    };
  },

  /**
   * Its list of system voices, which needs the key and renders nothing. A refusal in `base_resp` is
   * the answer, as it is to a line.
   */
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

  // every voice the key can use, MiniMax's own and those made on it; none has a gender field
  async voices(target, signal, options) {
    const found = await miniMaxVoices(target, signal, options);
    return onePage(found.map((v) => ({ ...v, gender: "?" as const })));
  },
};
