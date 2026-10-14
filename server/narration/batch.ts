// An endpoint's lines sent in batches (`docs/speech-batch-api.md`). The per-line steps (`LineRun`)
// and their order are the narration run's; this decides only which lines go together, which part
// each item is, and which lines go again.
import { joinedParts, type SplitPart } from "@/lib/split";
import { ProviderError } from "~/providers/http";
import {
  BatchCut,
  type BatchLimits,
  type BatchOutcome,
  type RenderedClip,
  type SpeechInput,
} from "~/providers/speech";
import { joinParts, PartFailed, type Outcome } from "~/narration/parts";

/** `T` is the run's own line. */
export interface BatchLine<T> {
  t: T;
  /** where it is cut to fit, or null when it goes whole */
  cuts: SplitPart[] | null;
  /** an item is this with a part's text */
  input: SpeechInput;
  tries: number;
}

/** The calls a line goes through however it is sent. */
export interface LineRun<T, L extends BatchLine<T>> {
  /** a cancel, or the first failure beyond one line */
  stop: AbortSignal;
  /** resolves to the slot's release */
  acquire(endpoint: string | null): Promise<() => void>;
  /** stopped, or out of budget */
  halted(): boolean;
  /**
   * Budget asked, line committed, cut to `maxChars` if shorter than the endpoint's. Null when it
   * does not go: halted, already gone, or landed as failed.
   */
  admit(t: T, maxChars?: number | null): Promise<L | null>;
  /** one line on its own; a stop is thrown */
  speak(line: L): Promise<Outcome>;
  speakBatch(
    endpoint: string,
    items: SpeechInput[],
    answered: (index: number, outcome: BatchOutcome) => void,
  ): Promise<void>;
  /** writes the outcome and gives back what the line held */
  land(line: L, outcome: Outcome): Promise<void>;
}

/**
 * Each batch takes a slot and is filled in chapter order up to the endpoint's limits; a cut line
 * goes as one item per part. A line is resent (up to the endpoint's retries) only after a
 * retryable item failure or a `BatchCut`; a whole-batch refusal is not, since `call` already
 * retried it and resending would make (1 + retries)² attempts.
 */
export async function batchLines<T, L extends BatchLine<T>>(
  run: LineRun<T, L>,
  id: string,
  lines: readonly T[],
  limits: BatchLimits,
): Promise<void> {
  /** `line` is set once committed */
  type Waiting = { t: T; line?: L };
  const pending: Waiting[] = lines.map((t) => ({ t }));
  const order = new Map(lines.map((t, i) => [t, i]));
  const maxItems = limits.maxItems ?? Infinity;
  const maxChars = limits.maxInputChars ?? Infinity;

  const fill = async (): Promise<L[]> => {
    const batch: L[] = [];
    let items = 0;
    let chars = 0;
    while (pending.length && !run.halted()) {
      const next = pending[0];
      const line = next.line ?? (await run.admit(next.t, limits.maxItemChars));
      if (!line) {
        if (run.halted()) break;
        pending.shift();
        continue;
      }
      // the first always goes
      const parts = line.cuts?.length ?? 1;
      const size = line.input.text.length;
      if (batch.length && (items + parts > maxItems || chars + size > maxChars)) {
        pending[0] = { t: next.t, line };
        break;
      }
      pending.shift();
      // more parts than a batch may carry: sent alone
      if (parts > maxItems) await run.land(line, await run.speak(line));
      else {
        batch.push(line);
        items += parts;
        chars += size;
      }
    }
    return batch;
  };

  const send = async (batch: L[]): Promise<void> => {
    const items: SpeechInput[] = [];
    const owner: { line: L; part: number }[] = [];
    for (const line of batch) {
      const texts =
        line.cuts && line.cuts.length > 1
          ? // the whitespace a cut keeps for rejoining is not the provider's to read
            line.cuts.map((c) => c.text.trim())
          : [line.input.text];
      texts.forEach((text, part) => {
        items.push({ ...line.input, text });
        owner.push({ line, part });
      });
    }
    const parts = new Map(batch.map((l) => [l, [] as RenderedClip[]]));
    const settled = new Set<L>();
    const landing: Promise<void>[] = [];
    /** back to the front, in chapter order */
    const again: L[] = [];
    const maxRetries = batch[0].input.target?.maxRetries ?? 0;
    const failLine = (line: L, error: unknown, retry: boolean): void => {
      settled.add(line);
      if (retry && line.tries < maxRetries) {
        line.tries++;
        again.push(line);
        return;
      }
      landing.push(run.land(line, { error }));
    };
    const answered = (index: number, outcome: BatchOutcome): void => {
      const { line, part } = owner[index] ?? {};
      if (!line || settled.has(line)) return;
      const count = line.cuts && line.cuts.length > 1 ? line.cuts.length : 1;
      if ("error" in outcome)
        return failLine(
          line,
          count > 1 ? new PartFailed(part + 1, outcome.error) : outcome.error,
          outcome.error instanceof ProviderError && outcome.error.retryable,
        );
      const got = parts.get(line)!;
      got[part] = outcome.clip;
      if (got.filter(Boolean).length < count) return;
      settled.add(line);
      let joined: Outcome;
      try {
        joined = { rendered: joinedParts(line.cuts) ? joinParts(got, line.cuts!) : got[0] };
      } catch (e) {
        joined = { error: e };
      }
      landing.push(run.land(line, joined));
    };
    try {
      await run.speakBatch(id, items, answered);
    } catch (e) {
      if (run.stop.aborted) throw e;
      for (const line of batch) if (!settled.has(line)) failLine(line, e, e instanceof BatchCut);
    }
    pending.unshift(
      ...again
        .sort((a, b) => order.get(a.t)! - order.get(b.t)!)
        .map((line) => ({ t: line.t, line })),
    );
    await Promise.all(landing);
  };

  const worker = async (): Promise<void> => {
    while (pending.length && !run.halted()) {
      const leave = await run.acquire(id);
      try {
        const batch = await fill();
        if (batch.length) await send(batch);
      } finally {
        leave();
      }
    }
  };
  // as many as could ever be out at once; the gate decides how many are
  const width = Math.max(1, Math.ceil(lines.length / Math.min(maxItems, lines.length)));
  await Promise.all(Array.from({ length: width }, worker));
}
