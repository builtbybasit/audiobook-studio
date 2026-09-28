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
//
// A voice is cloned in two requests (https://platform.minimax.io/docs/guides/speech-voice-clone):
// the sample goes up to `POST /v1/files/upload` as multipart with `purpose=voice_clone`
// (https://platform.minimax.io/docs/api-reference/file-management-upload), which answers with a
// `file_id`; then `POST /v1/voice_clone`
// (https://platform.minimax.io/docs/api-reference/voice-cloning-clone) makes the voice from that
// file under a `voice_id` the caller chooses, and answers with no id of its own. Only the two
// required fields are sent: a preview `text` is billed per character, and noise reduction and
// volume normalisation are left at MiniMax's default, off, so the voice is made from the sample as
// it was picked. Each request goes out once, and a failure says which of the two it was: a failed
// upload never reaches the clone. A clone that timed out may still have made its voice; since
// MiniMax charges a voice on its first use and deletes one unused for 7 days, that one costs
// nothing, and the next attempt's random `voice_id` cannot collide with it.
import type { SpeechUsage, Voice } from "@/types";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { audioAnswer, jsonAnswer } from "~/providers/answer";
import type { CloneRequest } from "~/providers/clone";
import { authHeaders, call, jsonHeaders, ProviderError } from "~/providers/http";
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

// ---------- cloning ----------

/**
 * The `voice_id` a clone is made under, from its title: MiniMax's rules are 8 to 256 characters,
 * an English letter first, only letters, digits, `-` and `_`, not ending in `-` or `_`, and not an
 * id the account already has. So the title is folded to plain letters and digits joined by `-`,
 * led by a letter (`voice` in front when it would not be), and ends in random hex — a second
 * clone with the same title is a second voice rather than a refusal. `random` is for the tests.
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

/**
 * The upload's `file.file_id`, as the digits MiniMax sent. It is an int64, which a JavaScript
 * number holds exactly only up to 2^53, so an id past that is taken from the answer's own text
 * rather than from the number `JSON.parse` rounded it to. Null when there is none.
 */
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

/**
 * One step of a clone, sent once (the target has no retries), its failure put in words that say
 * which step it was. A cancel is the job's own, and passes through as it is.
 */
async function step<T>(doing: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    throw new ProviderError(`${doing}: ${e.message}`, e.status, e.retryable, e.rateLimited);
  }
}

/** The upload, then the clone; see the top of this file. */
async function miniMaxClone(
  target: ProviderTarget,
  request: CloneRequest,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<Voice> {
  // the route holds a clone to `cloning.maxClips`, which is 1; this is its guard, not the rule
  const [clip] = request.clips;
  if (!clip || request.clips.length > 1)
    throw new ProviderError(`${target.name} makes a voice from exactly one sample`, 0, false);
  const root = miniMaxRoot(target.baseUrl);
  const check = checkOf(target);

  const uploading = `Uploading ${clip.name} to ${target.name} failed`;
  const fileId = await step(uploading, async () => {
    const form = new FormData();
    form.set("purpose", "voice_clone");
    form.set("file", clip.blob, clip.name);
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
  await step(`${clip.name} was uploaded, but making the voice from it failed`, async () => {
    const res = await call(
      target,
      `${root}/voice_clone`,
      {
        method: "POST",
        headers: jsonHeaders(target),
        // the file id written as MiniMax sent it, digits and not a string: see `fileIdIn`
        body: `{"file_id":${fileId},"voice_id":${JSON.stringify(voiceId)}}`,
      },
      { signal, ...options, check },
    );
    // `check` has turned away a refusal; what is left must say it succeeded, and not by silence
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
