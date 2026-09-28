// Many lines sent to a speech server in one request, and each line's answer read as it lands — the
// client side of the batch speech API (`docs/speech-batch-api.md`).
//
// Only a server that speaks OpenAI's shape can have it: it is an extension a local server writes
// for itself, and no hosted provider has the route. So it is the compatible wire's (`openai.ts`),
// and the provider asks it before a run whether the endpoint's model takes batches at all — `GET
// …/audio/speech/capabilities`, read leniently, as the spec asks: unknown fields are ignored, and a
// server that has no such route, does not list the model, or lists it with no `batch` is one that
// takes a line at a time. That answer is the provider's to remember (`endpointSpeech.ts`).
//
// A batch goes out through `call`, so a refusal of the whole of it — a 429 or 503 from a server too
// busy for it, a 400 for a request it cannot read — is retried, waited on and told to the gate like
// a line's. What comes back is a stream of JSON lines, one per item as the server finishes it, in
// whatever order that is, and a last `done`. It is read as it arrives, never buffered whole, and
// each item is told to the caller the moment its line lands. That changes what the endpoint's
// `timeoutSec` means: a batch of sixteen lines may take minutes and be perfectly healthy, so the
// attempt's clock stops at the headers (`headersOnly`) and the stream keeps its own — the same
// number of seconds, run again from every chunk that arrives. A server that is slow to its first
// item says it is alive with a `ping` line, and that is bytes like any other.
//
// Each item is a line as far as the ledger is concerned, and is reported through its own `sent`
// exactly once, by `send.ts`'s rule: an item answered `done` was generated and is billed, with what
// the server counted for it, even when its audio then proves unusable — cut short, not the format
// asked for; one answered `failed` is not, unless the provider bills failures; so is every item of
// a batch refused whole after the retries, and every item a stream that was cut off never reached,
// with the reason. A cancel reports nothing more: what the server made of the items it was still
// rendering is not knowable.
import type { AudioFormat, SpeechUsage } from "@/types";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { audioClip } from "~/providers/answer";
import { call, jsonHeaders, ProviderError, type CallStats } from "~/providers/http";
import type { SpeechCallOptions } from "~/providers/send";
import type { SentSpeech } from "~/providers/sent";
import type { BatchLimits, SpeechBatch } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";

/** What a server answers when it has no capabilities route: no batches, and no promises. */
const NO_ROUTE = new Set([404, 405, 501]);

const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

/** A limit as the capabilities give it: a count of at least one, or null for none of that kind. */
const limit = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) && x >= 1 ? Math.floor(x) : null;

/** The limits the capabilities give `model`, or null when they list it taking no batches. */
function limitsOf(body: unknown, model: string): BatchLimits | null {
  const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
  const entry = models.find((m) => isRecord(m) && m.id === model.trim());
  if (!isRecord(entry) || !isRecord(entry.batch)) return null;
  return {
    maxItems: limit(entry.batch.max_items),
    maxInputChars: limit(entry.batch.max_input_chars),
    maxItemChars: limit(entry.max_item_chars),
  };
}

/**
 * Whether the endpoint's model takes batches, and how many: asked of the server every time, with
 * the endpoint's retries. Null for a server with no capabilities route, one that answers something
 * that is not them, or one that does not list the model as taking batches. Anything else — no
 * answer, a refused key, a server fault — is thrown: it says nothing about batches either way.
 */
export async function batchCapabilities(
  target: ProviderTarget,
  signal: AbortSignal,
  options: SpeechCallOptions,
): Promise<BatchLimits | null> {
  let res: Response;
  try {
    res = await call(
      target,
      `${target.baseUrl}/audio/speech/capabilities`,
      { method: "GET", headers: jsonHeaders(target) },
      { signal, ...options },
    );
  } catch (e) {
    if (e instanceof ProviderError && NO_ROUTE.has(e.status)) return null;
    throw e;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (signal.aborted) throw signal.reason;
    // a page that answers every path — a web app's fallback — is not a batch server
    return null;
  }
  return limitsOf(body, target.model);
}

/** What the Test button adds when the endpoint takes batches. */
export const takesBatches = (limits: BatchLimits): string =>
  "takes batches" + (limits.maxItems ? ` of up to ${limits.maxItems} lines` : "");

/**
 * What an item's `usage` says, in the ledger's shape: the characters and the seconds the spec
 * requires, and the tokens a model that counts them adds. Labelled as totals, which is what they
 * are; null when the item carried no usage at all.
 */
function usageOf(usage: unknown): SpeechUsage | null {
  if (!isRecord(usage)) return null;
  const read = normalizeSpeechUsage(
    {
      chars: usage.input_characters,
      audioSeconds: usage.audio_seconds,
      textTokens: usage.input_tokens,
      audioTokens: usage.output_audio_tokens,
    },
    "internal",
  );
  return { ...read, format: "plain" };
}

/**
 * Send `batch` and tell `batch.answered` each item's clip or failure as its line arrives; see the
 * header for what is reported to the ledger. `voices[i]` is item `i`'s voice id, and every item has
 * already been through the checks a line gets before a request. Resolves once every item has been
 * answered; throws a `ProviderError` when the batch was refused whole or the stream was cut off
 * first — the items not yet answered are then the caller's — or the signal's reason on a cancel.
 */
export async function sendBatch(
  batch: SpeechBatch,
  voices: string[],
  options: SpeechCallOptions & { billsFailures: boolean },
): Promise<void> {
  const { target, items, signal } = batch;
  const { billsFailures, ...inject } = options;
  if (signal.aborted) throw signal.reason;
  if (!items.length) return;
  const format: AudioFormat = items[0].encoding.format;
  // what goes on the wire for each item, and so what the ledger counts
  const instructions = items.map((item) => item.instructions.trim());
  // our own name for each item — its place — which the answer is matched back by
  const ids = items.map((_, i) => String(i));
  const body = {
    model: target.model,
    response_format: format,
    items: items.map((item, i) => ({
      id: ids[i],
      input: item.text,
      voice: voices[i],
      ...(instructions[i] ? { instructions: instructions[i] } : {}),
    })),
  };

  const stats: CallStats = { attempts: 0, rateLimited: false };
  const startedAt = Date.now();
  /** the items not yet answered, by index */
  const open = new Set(items.keys());
  const report = (
    i: number,
    rest: Pick<SentSpeech, "status" | "audioSeconds" | "error" | "billed" | "reported">,
  ): void =>
    items[i].sent?.({
      startedAt,
      finishedAt: Date.now(),
      attempts: Math.max(1, stats.attempts),
      rateLimited: stats.rateLimited,
      simulated: false,
      text: items[i].text,
      instructions: instructions[i],
      ...rest,
    });
  /** The batch went wrong as a whole: every item still open is reported, and left to the caller. */
  const failOpen = (e: unknown, billed: boolean): never => {
    for (const i of open)
      report(i, {
        status: "failed",
        audioSeconds: 0,
        billed,
        reported: null,
        error: {
          code: e instanceof ProviderError ? e.status : 0,
          message: e instanceof Error ? e.message : String(e),
        },
      });
    throw e;
  };

  // The stream's own clock: aborted when nothing has arrived for `timeoutSec`, which closes the
  // request as a cancel would, and is told apart from one by which of the two fired.
  const idle = new AbortController();
  const live = AbortSignal.any([signal, idle.signal]);
  let res: Response;
  try {
    res = await call(
      target,
      `${target.baseUrl}/audio/speech/batch`,
      {
        method: "POST",
        headers: { ...jsonHeaders(target), accept: "application/x-ndjson" },
        body: JSON.stringify(body),
      },
      { signal: live, stats, rateLimited: batch.rateLimited, headersOnly: true, ...inject },
    );
  } catch (e) {
    if (signal.aborted) throw e;
    return failOpen(e, billsFailures);
  }

  /** One item's line: its clip, or why it has none, told and reported. */
  async function answer(line: Record<string, unknown>): Promise<void> {
    // matched by the id it was sent with, or by its place when the line names no id
    const i =
      typeof line.id === "string"
        ? ids.indexOf(line.id)
        : Number.isInteger(line.index)
          ? (line.index as number)
          : -1;
    // an item this batch did not send, or one already answered: the spec has every item answered
    // once, so a second answer is the server's mistake and the first one stands
    if (!open.has(i)) return;
    if (line.status === "done") {
      open.delete(i);
      const reported = usageOf(line.usage);
      let clip;
      try {
        if (typeof line.format === "string" && line.format !== format)
          throw new ProviderError(
            `${target.name} answered in ${line.format} where ${format} was asked for`,
            res.status,
            false,
          );
        const bytes =
          typeof line.audio === "string"
            ? new Uint8Array(Buffer.from(line.audio, "base64"))
            : new Uint8Array();
        clip = await audioClip(target, bytes, format, res.status);
      } catch (e) {
        // rendered, and so billed, whatever became of it here
        report(i, {
          status: "failed",
          audioSeconds: 0,
          billed: true,
          reported,
          error: { code: res.status, message: (e as Error).message },
        });
        batch.answered(i, { error: e as Error });
        return;
      }
      report(i, { status: "done", audioSeconds: clip.duration, billed: true, reported });
      batch.answered(i, {
        clip: {
          ...clip,
          ms: Date.now() - startedAt,
          model: target.model,
          voice: voices[i],
        },
      });
    } else if (line.status === "failed") {
      open.delete(i);
      const said = isRecord(line.error) ? line.error : {};
      const message =
        typeof said.message === "string" && said.message.trim()
          ? said.message.trim()
          : "no reason given";
      const code = typeof said.code === "string" && said.code ? ` (${said.code})` : "";
      const error = new ProviderError(
        `${target.name} could not render this line: ${message}${code}`,
        res.status,
        said.retryable === true,
      );
      report(i, {
        status: "failed",
        audioSeconds: 0,
        billed: billsFailures,
        reported: null,
        error: { code: res.status, message: error.message },
      });
      batch.answered(i, { error });
    }
    // any other status is one this client does not know, and the item stays open
  }

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const stream = {
    /** the `done` line arrived */
    finished: false,
    /** a refusal written into the stream in place of the items, in OpenAI's error shape */
    refused: null as ProviderError | null,
  };
  /** why the stream ended early, when reading it failed */
  let cut: unknown = null;
  let clock: ReturnType<typeof setTimeout> | undefined;
  const wind = (): void => {
    clearTimeout(clock);
    clock = setTimeout(() => idle.abort(), target.timeoutSec * 1000);
  };
  // a `fetch` that does not end its body on an abort still has its reader cancelled
  const close = (): void => void reader?.cancel().catch(() => {});
  live.addEventListener("abort", close, { once: true });

  /** One line of the stream. A line that is not JSON is skipped, as an unknown type is. */
  async function take(text: string): Promise<void> {
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      // if it was an item, that item is never answered, and is caught below as one the stream
      // left open
      return;
    }
    if (!isRecord(line)) return;
    if (line.type === "item") await answer(line);
    else if (line.type === "done") stream.finished = true;
    else if (line.type === undefined && isRecord(line.error)) {
      const said = typeof line.error.message === "string" ? line.error.message : "";
      stream.refused = new ProviderError(
        `${target.name} refused the batch${said ? `: ${said}` : ""}`,
        res.status,
        false,
      );
      stream.finished = true;
    }
    // `ping`, and any type this client does not know: it arrived, and so wound the clock
  }

  try {
    if (reader) {
      wind();
      while (!stream.finished) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          cut = e;
          break;
        }
        if (chunk.done) {
          // a last line with no newline after it is still a line
          buffered += decoder.decode();
          if (buffered.trim()) await take(buffered.trim());
          break;
        }
        wind();
        buffered += decoder.decode(chunk.value, { stream: true });
        for (
          let nl = buffered.indexOf("\n");
          nl >= 0 && !stream.finished;
          nl = buffered.indexOf("\n")
        ) {
          const text = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (text) await take(text);
        }
      }
    }
  } finally {
    clearTimeout(clock);
    live.removeEventListener("abort", close);
    // after `done` nothing follows; before it, closing the request is what stops the server
    close();
  }

  if (signal.aborted) throw signal.reason;
  if (stream.refused) return failOpen(stream.refused, billsFailures);
  // every item answered: whatever became of the rest of the stream, nothing was lost with it
  if (!open.size) return;
  const why = idle.signal.aborted
    ? `sent nothing for ${target.timeoutSec} s part-way through a batch`
    : cut
      ? `stopped sending a batch part-way (${cut instanceof Error ? cut.message : String(cut)})`
      : stream.finished
        ? "said a batch was done"
        : "stopped sending a batch before it said it was done";
  return failOpen(
    new ProviderError(
      `${target.name} ${why}, leaving ${open.size} of its ${items.length} lines unanswered`,
      0,
      true,
    ),
    billsFailures,
  );
}
