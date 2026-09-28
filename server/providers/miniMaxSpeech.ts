// A line spoken by MiniMax, through its synchronous `POST /v1/t2a_v2`.
//
// MiniMax is its own shape (https://platform.minimax.io/docs/api-reference/speech-t2a-http): a
// bearer key, a JSON body naming the model, the words, the voice in `voice_setting` and the format
// in `audio_setting`, and a JSON answer carrying the audio as a hex string in `data.audio` beside
// `extra_info` — whose `usage_characters` is the count MiniMax bills, reported to the ledger.
//
// A refusal does not always come back as an HTTP error: the answer carries `base_resp`, and a
// `status_code` other than 0 is MiniMax saying no — a bad key (1004, 2049), an empty balance
// (1008), a rate limit (1002, 1039, 1041), a voice this key cannot use (20132, 2042). Each is
// turned into a failure that says so. Those another attempt could fix are marked retryable for the
// job; the request itself is not sent again here, since it was answered.
//
// Only the words are sent. MiniMax takes delivery as interjections in the text — `(laughs)`,
// `(sighs)` — and pauses as `<#0.5#>`, which is what the endpoint's Expressions tab is for.
import type { SpeechUsage } from "@/types";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { audioAnswer, refuseEncoding, type AnsweredAudio } from "~/providers/answer";
import { sendSpeech, type SpeechCallOptions } from "~/providers/fishSpeech";
import { call, jsonHeaders, ProviderError } from "~/providers/http";
import type { RenderedClip, SpeechInput } from "~/providers/speech";
import type { ProbeResult, ProviderTarget } from "~/providers/target";

/** What this app asks for when the endpoint names no rate: the rate MiniMax's own example uses. */
const DEFAULT_RATE = 32000;
const DEFAULT_MP3_KBPS = 128;

/** `base_resp` codes another attempt may answer differently: a fault, a timeout, a limit. */
const RETRYABLE_CODES = new Set([1000, 1001, 1002, 1024, 1039, 1041]);

/** MiniMax serves its API under `/v1` on its host, whatever path the base URL was saved with. */
export const miniMaxRoot = (baseUrl: string): string => `${new URL(baseUrl).origin}/v1`;

interface BaseResp {
  base_resp?: { status_code?: number; status_msg?: string };
}

/** Throws the refusal `body.base_resp` describes, when it describes one. */
export function refusedBy(target: ProviderTarget, body: BaseResp | null, status: number): void {
  const code = body?.base_resp?.status_code;
  if (code == null || code === 0) return;
  const said = body?.base_resp?.status_msg?.trim();
  throw new ProviderError(
    `${target.name} refused the request (${code}${said ? `: ${said}` : ""})`,
    status,
    RETRYABLE_CODES.has(code),
  );
}

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

export async function miniMaxSpeak(
  input: SpeechInput,
  target: ProviderTarget,
  voice: string,
  options: SpeechCallOptions,
): Promise<RenderedClip> {
  refuseEncoding(target, input);
  const { format } = input.encoding;
  const started = Date.now();
  const audio = await sendSpeech(
    input,
    target,
    {
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
      read: async (res, signal) => {
        let body: MiniMaxAnswer;
        try {
          body = (await res.json()) as MiniMaxAnswer;
        } catch {
          if (signal.aborted) throw signal.reason;
          throw new ProviderError(
            `${target.name} answered ${res.status} with something that is not JSON`,
            res.status,
            false,
          );
        }
        refusedBy(target, body, res.status);
        const hex = body.data?.audio;
        if (!hex)
          throw new ProviderError(`${target.name} answered with no audio`, res.status, false);
        // decoded, the audio is what `format` asked for, and is read the way a body of it would be
        const decoded: AnsweredAudio = await audioAnswer(
          target,
          new Response(Buffer.from(hex, "hex"), { status: res.status }),
          signal,
          format,
        );
        const characters = body.extra_info?.usage_characters;
        const reported: SpeechUsage | null =
          typeof characters === "number" ? normalizeSpeechUsage({ characters }, "plain") : null;
        return { audio: decoded, reported };
      },
    },
    options,
  );
  return { ...audio, ms: Date.now() - started, model: target.model, voice };
}

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
    { signal, ...options },
  );
  const body = (await res.json().catch(() => null)) as
    | (BaseResp & Record<string, { voice_id?: unknown; voice_name?: unknown }[] | undefined>)
    | null;
  refusedBy(target, body, res.status);
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

/**
 * The Test button for MiniMax: its list of system voices, which needs the key and renders nothing.
 * A refusal in `base_resp` is the answer, as it is to a line.
 */
export async function miniMaxProbe(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<ProbeResult> {
  const started = Date.now();
  const voices = await miniMaxVoices(target, signal, options, "system");
  const ms = Date.now() - started;
  return {
    ok: true,
    message: `Answered in ${ms} ms; the key was accepted and it offers ${voices.length} system voices`,
    ms,
  };
}
