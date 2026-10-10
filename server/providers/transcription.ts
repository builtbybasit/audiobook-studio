// Speech to text: a recording sent to a transcription endpoint, and the words that came back.
//
// One wire, OpenAI's `POST /audio/transcriptions`, which the local servers copy — Fermion's Phonon
// among them (`fermion serve phonon-2`). A multipart form of the file and the model; asked for
// `verbose_json` with `timestamp_granularities[]=word` when the caller wants the time of each word,
// which a server that has none answers without (`gpt-4o-transcribe` answers only `json`), and the
// caller then has the words without their times. `prompt` carries names the audio is likely to
// hold, which Whisper reads as context and Phonon as words to favour — by `hotword_lambda` when the
// endpoint sets one, since Phonon's own default of 2 changes nothing it hears. A server that drops the
// connection for a request with a prompt (Fermion 0.2.9, whose hotwords fail to load) and answers
// the same request without one is sent none from then on, until restart, and each transcript
// heard so says it was `unhinted`.
//
// The recording goes as 16 kHz mono WAV, made by ffmpeg (`SpeechRate`), unless the endpoint says to
// send it as rendered (`resample16k: false`) or the transcriber was made without one (a test's): the rate every
// speech-to-text model hears at, and the only one Phonon's CUDA build takes.
//
// Every request that reached the wire is reported through `sent`, as speech is (`sent.ts`), so the
// ledger prices it by the minute of audio sent — a cancelled one too, at a cost nobody knows. A simulated endpoint answers here with a fixed
// sentence and no times, after its latency, and nothing is sent.
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

/** One word as the server heard it, in seconds from the start of the file. */
export interface HeardWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionInput {
  /** the recording, typed so the server can tell its format */
  audio: Blob;
  /** a file name with the right extension, which some servers read the format from */
  name: string;
  /** how long it plays, in seconds — what the ledger prices when the server does not say */
  seconds: number;
  /** ask for the time of every word */
  words: boolean;
  /** names and words the audio is likely to hold; never more than a hint */
  hints?: readonly string[];
  signal: AbortSignal;
  sent?: (request: SentTranscription) => void;
}

export interface Transcript {
  text: string;
  /** absent when the server gave no times, or was not asked for them */
  words?: HeardWord[];
  /** heard without the hints, because the server gives no answer to a request that has them */
  unhinted?: true;
}

/** A transcription endpoint as a request needs it: a target, and how hard to favour the hints. */
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

/** What a simulated endpoint hears, whatever it is sent. */
export const SIMULATED_TRANSCRIPT = "A simulated endpoint hears this sentence in every recording.";

/** Words a prompt may carry: Whisper reads 224 tokens of it, so a long cast is cut, never refused. */
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

/** Servers that answer a request only without its prompt, by endpoint and address, until restart. */
const promptHurts = new Set<string>();

/** One request to the server, with `prompt` when it is not empty. */
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
    // an answer cut short by a cancel is the cancel's, not a server that sent no transcript
    if (signal.aborted) throw signal.reason;
  } catch (e) {
    if (signal.aborted) {
      // out at the server, which may have heard it and billed it: nobody here can say
      if (stats.attempts) report({ status: "cancelled", billed: null });
      throw e;
    }
    const error = e instanceof ProviderError ? e : new ProviderError(String(e), 0, true);
    // a refusal is not billed; a request no answer came back for is not knowable, and is not either
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

/**
 * The recording as 16 kHz mono WAV, under a name that says so — or as it came when ffmpeg cannot
 * read it, for the server to say what is wrong with it.
 */
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
  /** what a recording is turned into before it is sent; absent sends it as it came */
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
        // no answer at all: the prompt may be what it cannot take (Fermion 0.2.9 drops the
        // connection for one) — and when the same request without it is answered, it was
        const heard = await send(input, target, "", inject).catch(() => {
          throw e;
        });
        promptHurts.add(server);
        return { ...heard, unhinted: true };
      }
    },
  };
}
