// Client side of the batch speech API (`docs/speech-batch-api.md`): answers stream back as NDJSON in
// any order. The attempt's clock stops at the headers; the stream keeps an idle clock of
// `timeoutSec`, rewound by every chunk (`ping` too). A cut stream throws `BatchCut` (its lines may
// go again); a whole-batch refusal throws `call`'s `ProviderError` (they may not).
import type { AudioFormat, SpeechUsage } from "@/types";
import { normalizeSpeechUsage } from "@/lib/pricing";
import { audioClip } from "~/providers/answer";
import { call, jsonHeaders, ProviderError, type CallStats } from "~/providers/http";
import type { SpeechCallOptions } from "~/providers/send";
import type { SentSpeech } from "~/providers/sent";
import { BatchCut, type BatchLimits, type SpeechBatch } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";

/** No capabilities route: no batches. */
const NO_ROUTE = new Set([404, 405, 501]);

const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

/** A count of at least one, or null. */
const limit = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) && x >= 1 ? Math.floor(x) : null;

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
 * `GET …/audio/speech/capabilities`, read leniently per the spec. Null when there is no route, no
 * readable answer, or no `batch` for the model; any other failure is thrown.
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
    // a web app's fallback page is not a batch server
    return null;
  }
  return limitsOf(body, target.model);
}

export const takesBatches = (limits: BatchLimits): string =>
  "takes batches" + (limits.maxItems ? ` of up to ${limits.maxItems} lines` : "");

/** An item's `usage` in the ledger's shape, as totals; null when it carried none. */
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
 * Resolves once every item is answered. Throws when the batch was refused whole or cut off (the
 * unanswered items are then the caller's), or the signal's reason on a cancel.
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
  // as sent, and so as the ledger counts
  const instructions = items.map((item) => item.instructions.trim());
  // each item's place, which the answer is matched back by
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
  const cancelOpen = (): never => {
    if (stats.attempts)
      for (const i of open)
        report(i, { status: "cancelled", audioSeconds: 0, billed: null, reported: null });
    throw signal.reason;
  };

  // The stream's idle clock; told apart from a cancel by which signal fired.
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
    if (signal.aborted) return cancelOpen();
    return failOpen(e, billsFailures);
  }

  async function answer(line: Record<string, unknown>): Promise<void> {
    // by id, or by place when the line names no id
    const i =
      typeof line.id === "string"
        ? ids.indexOf(line.id)
        : Number.isInteger(line.index)
          ? (line.index as number)
          : -1;
    // unknown, or already answered: the first answer stands
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
        // rendered, and so billed
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
    // an unknown status leaves the item open
  }

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const stream = {
    finished: false,
    /** a refusal in place of the items, in OpenAI's error shape */
    refused: null as ProviderError | null,
  };
  let cut: unknown = null;
  let clock: ReturnType<typeof setTimeout> | undefined;
  const wind = (): void => {
    clearTimeout(clock);
    clock = setTimeout(() => idle.abort(), target.timeoutSec * 1000);
  };
  // for a `fetch` that does not end its body on an abort
  const close = (): void => void reader?.cancel().catch(() => {});
  live.addEventListener("abort", close, { once: true });

  /** A line that is not JSON is skipped, as an unknown type is. */
  async function take(text: string): Promise<void> {
    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      // an item lost this way is caught below as left open
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
    // `ping` and unknown types only rewind the clock
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
    // before `done`, closing the request is what stops the server
    close();
  }

  if (signal.aborted) return cancelOpen();
  if (stream.refused) return failOpen(stream.refused, billsFailures);
  if (!open.size) return;
  const why = idle.signal.aborted
    ? `sent nothing for ${target.timeoutSec} s part-way through a batch`
    : cut
      ? // oxlint-disable-next-line typescript/no-base-to-string -- whatever was thrown, as words
        `stopped sending a batch part-way (${cut instanceof Error ? cut.message : String(cut)})`
      : stream.finished
        ? "said a batch was done"
        : "stopped sending a batch before it said it was done";
  return failOpen(
    new BatchCut(
      `${target.name} ${why}, leaving ${open.size} of its ${items.length} lines unanswered`,
    ),
    billsFailures,
  );
}
