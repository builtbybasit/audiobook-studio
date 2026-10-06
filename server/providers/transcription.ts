// Speech to text: a recording sent to a transcription endpoint, and the words that came back.
//
// One wire, OpenAI's `POST /audio/transcriptions`, which the local servers copy — Fermion's Phonon
// among them (`fermion serve phonon-2`). A multipart form of the file and the model; asked for
// `verbose_json` with `timestamp_granularities[]=word` when the caller wants the time of each word,
// which a server that has none answers without (`gpt-4o-transcribe` answers only `json`), and the
// caller then has the words without their times. `prompt` carries names the audio is likely to
// hold, which Whisper reads as context and Phonon as words to favour. A server that drops the
// connection for a request with a prompt (Fermion 0.2.9, whose hotwords fail to load) and answers
// the same request without one is sent none from then on, until restart, and each transcript
// heard so says it was `unhinted`.
//
// Every request that reached the wire is reported through `sent`, as speech is (`sent.ts`), so the
// ledger prices it by the minute of audio sent. A simulated endpoint answers here with a fixed
// sentence and no times, after its latency, and nothing is sent.
import type { EndpointProbe } from "@/types";
import { sleep } from "~/providers/fake";
import {
  authHeaders,
  call,
  jsonHeaders,
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

export interface TranscriptionProvider {
  name: string;
  transcribe(input: TranscriptionInput, target: ProviderTarget): Promise<Transcript>;
  probe(target: ProviderTarget, signal: AbortSignal): Promise<EndpointProbe>;
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
  target: ProviderTarget,
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
  } catch (e) {
    if (signal.aborted) throw e;
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

export function endpointTranscriber(
  inject: Pick<CallOptions, "fetch" | "backoffMs"> = {},
): TranscriptionProvider {
  return {
    name: "transcription endpoints",

    async transcribe(input, target) {
      const { signal } = input;
      if (target.simulation) {
        await sleep(target.simulation.latencyMs, signal);
        return { text: SIMULATED_TRANSCRIPT };
      }
      requireKey(target);
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

    async probe(target, signal) {
      if (target.simulation)
        return { ok: true, message: "Simulated: answers without a server", ms: 0 };
      requireKey(target);
      const started = Date.now();
      const res = await call(
        { ...target, maxRetries: 0 },
        `${target.baseUrl}/models`,
        { method: "GET", headers: jsonHeaders(target) },
        { signal, ...inject },
      );
      const ms = Date.now() - started;
      const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
      const ids = Array.isArray(body?.data)
        ? body.data.map((m) => m?.id).filter((id): id is string => typeof id === "string")
        : [];
      const model = target.model.trim();
      // a local server lists its model by its full name and takes a short one: Fermion lists
      // `FermionResearch/…` and takes `phonon-2`, so a model it does not list is said, not refused
      const listed = !model || !ids.length || ids.includes(model);
      return {
        ok: true,
        message:
          `Answered in ${ms} ms` +
          (listed
            ? ids.length && model
              ? ` and lists “${model}”`
              : ""
            : ` · it lists ${ids.map((id) => `“${id}”`).join(", ")}, not “${model}”`),
        ms,
      };
    },
  };
}
