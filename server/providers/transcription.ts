// Speech to text over OpenAI's `POST /audio/transcriptions`, which local servers copy (Fermion's
// Phonon). Hints go as `prompt` (Phonon: favoured words, weighted by `hotword_lambda`, whose
// default of 2 changes nothing). Audio goes as 16 kHz mono WAV, the only rate Phonon's CUDA build
// takes. Requests are reported through `sent` and priced per minute of audio.
import type { SpeechRate } from "~/audio/ffmpeg";
import { sleep } from "~/providers/fake";
import {
  authHeaders,
  call,
  ProviderError,
  requireKey,
  type CallOptions,
  type CallStats,
} from "~/providers/http";
import type { SentTranscription } from "~/providers/sent";
import type { ProviderTarget } from "~/providers/target";

/** Seconds from the start of the file. */
export interface HeardWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionInput {
  audio: Blob;
  /** with the right extension: some servers read the format from it */
  name: string;
  /** what the ledger prices */
  seconds: number;
  /** ask for the time of every word (`gpt-4o-transcribe` gives none) */
  words: boolean;
  /** names the audio is likely to hold */
  hints?: readonly string[];
  signal: AbortSignal;
  sent?: (request: SentTranscription) => void;
}

export interface Transcript {
  text: string;
  words?: HeardWord[];
  /** heard without the hints, because the server gives no answer to a request with them */
  unhinted?: true;
}

export interface TranscriptionTarget extends ProviderTarget {
  /** sent as `hotword_lambda` beside a prompt; absent sends none */
  hotwordLambda?: number;
  /** false sends the recording as it came, not as 16 kHz mono (`SpeechRate`) */
  resample16k?: boolean;
}

export interface TranscriptionProvider {
  name: string;
  transcribe(input: TranscriptionInput, target: TranscriptionTarget): Promise<Transcript>;
}

export const SIMULATED_TRANSCRIPT = "A simulated endpoint hears this sentence in every recording.";

/** Whisper reads 224 tokens of prompt, so a long cast is cut, never refused. */
const HINT_CHARS = 800;

const promptOf = (hints: readonly string[]): string => {
  let out = "";
  for (const h of hints) {
    const next = out ? `${out}, ${h}` : h;
    if (next.length > HINT_CHARS) break;
    out = next;
  }
  return out;
};

const wordsOf = (body: { words?: unknown }): HeardWord[] | undefined =>
  Array.isArray(body.words)
    ? body.words
        .filter(
          (w): w is HeardWord =>
            typeof w?.word === "string" && Number.isFinite(w.start) && Number.isFinite(w.end),
        )
        .map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }))
    : undefined;

/** Servers that only answer without a prompt (Fermion 0.2.9), until restart. */
const promptHurts = new Set<string>();

async function send(
  input: TranscriptionInput,
  target: TranscriptionTarget,
  prompt: string,
  inject: Pick<CallOptions, "fetch" | "backoffMs">,
): Promise<Transcript> {
  const { signal } = input;
  const form = new FormData();
  form.set("file", input.audio, input.name);
  if (target.model.trim()) form.set("model", target.model.trim());
  form.set("language", "en");
  form.set("response_format", input.words ? "verbose_json" : "json");
  if (input.words) form.set("timestamp_granularities[]", "word");
  if (prompt) form.set("prompt", prompt);
  if (prompt && target.hotwordLambda != null)
    form.set("hotword_lambda", String(target.hotwordLambda));

  const stats: CallStats = { attempts: 0, rateLimited: false };
  const startedAt = Date.now();
  const report = (rest: Pick<SentTranscription, "status" | "error" | "billed">): void =>
    input.sent?.({
      startedAt,
      finishedAt: Date.now(),
      attempts: Math.max(1, stats.attempts),
      rateLimited: stats.rateLimited,
      simulated: false,
      audioSeconds: input.seconds,
      ...rest,
    });

  let body: { text?: unknown; words?: unknown };
  try {
    const res = await call(
      target,
      `${target.baseUrl}/audio/transcriptions`,
      { method: "POST", headers: authHeaders(target), body: form },
      { signal, stats, ...inject },
    );
    body = (await res.json().catch(() => null)) ?? {};
    // a body cut short by a cancel is the cancel's
    if (signal.aborted) throw signal.reason;
  } catch (e) {
    if (signal.aborted) {
      // the server may have billed it: nobody here can say
      if (stats.attempts) report({ status: "cancelled", billed: null });
      throw e;
    }
    const error = e instanceof ProviderError ? e : new ProviderError(String(e), 0, true);
    // neither a refusal nor no answer is billed
    report({
      status: "failed",
      error: { code: error.status, message: error.message },
      billed: false,
    });
    throw error;
  }
  if (typeof body.text !== "string") {
    const error = new ProviderError(`${target.name} answered without a transcript`, 200, false);
    report({ status: "failed", error: { code: 200, message: error.message }, billed: true });
    throw error;
  }
  report({ status: "done", billed: true });
  const words = input.words ? wordsOf(body) : undefined;
  return { text: body.text.trim(), ...(words?.length ? { words } : {}) };
}

/** As it came when ffmpeg cannot read it, for the server to say what is wrong. */
async function atSpeechRate(
  input: TranscriptionInput,
  speechRate: SpeechRate,
): Promise<TranscriptionInput> {
  try {
    const wav = await speechRate(await input.audio.bytes(), input.signal);
    const name = `${input.name.replace(/\.[^./]*$/, "")}.wav`;
    return { ...input, audio: new Blob([wav], { type: "audio/wav" }), name };
  } catch (e) {
    if (input.signal.aborted) throw e;
    return input;
  }
}

export function endpointTranscriber({
  speechRate,
  ...inject
}: Pick<CallOptions, "fetch" | "backoffMs"> & {
  /** absent sends the recording as it came */
  speechRate?: SpeechRate;
} = {}): TranscriptionProvider {
  return {
    name: "transcription endpoints",

    async transcribe(given, target) {
      const { signal } = given;
      if (target.simulation) {
        await sleep(target.simulation.latencyMs, signal);
        return { text: SIMULATED_TRANSCRIPT };
      }
      requireKey(target);
      const input =
        speechRate && target.resample16k !== false ? await atSpeechRate(given, speechRate) : given;
      const server = `${target.id} ${target.baseUrl}`;
      const prompt = promptOf(input.hints ?? []);
      if (!prompt) return send(input, target, "", inject);
      if (promptHurts.has(server))
        return { ...(await send(input, target, "", inject)), unhinted: true };
      try {
        return await send(input, target, prompt, inject);
      } catch (e) {
        if (signal.aborted || !(e instanceof ProviderError) || e.status !== 0) throw e;
        // no answer: Fermion 0.2.9 drops the connection over a prompt; retry without one
        const heard = await send(input, target, "", inject).catch(() => {
          throw e;
        });
        promptHurts.add(server);
        return { ...heard, unhinted: true };
      }
    },
  };
}
