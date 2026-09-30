// An endpoint's lines sent in batches (`docs/speech-batch-api.md`).
//
// The narration job hands this the lines going to an endpoint that said it takes batches, and the
// few calls every line goes through whichever way it is sent (`LineRun`): a slot on the endpoint,
// the budget, committing a line and landing what came back. What is decided here is only what a
// batch adds — which lines go together, which part of which line an item is, and which lines go
// again when a batch did not answer them.
import type { SplitPart } from "@/lib/split";
import type { SpeechGate } from "~/providers/gate";
import { ProviderError } from "~/providers/http";
import {
  BatchCut,
  type BatchLimits,
  type BatchOutcome,
  type RenderedClip,
  type SpeechInput,
  type SpeechProvider,
} from "~/providers/speech";
import { joinParts, PartFailed, speakInParts, type Outcome } from "~/narration/parts";

/** A line committed to going out, as far as a batch needs to know it; `T` is the run's own line. */
export interface BatchLine<T> {
  t: T;
  /** where it is cut to fit, or null when it goes whole */
  cuts: SplitPart[] | null;
  /** the whole line as the provider is sent it; an item is this with a part's text */
  input: SpeechInput;
  /** how many times it has been sent again in a later batch */
  tries: number;
}

/** What the run lends its batches: the calls a line goes through however it is sent. */
export interface LineRun<T, L extends BatchLine<T>> {
  provider: SpeechProvider;
  gate: SpeechGate;
  /** the run's stop: a cancel, or the first thing to go wrong beyond one line */
  stop: AbortSignal;
  /** a slot on the endpoint, waited for; the function it gives back leaves it */
  acquire(endpoint: string | null): Promise<() => void>;
  /** whether nothing more should go out: the run was stopped, or the budget no longer covers it */
  halted(): boolean;
  /** whether the budget no longer covers this line; says so, and halts the run, when it does not */
  budgetStops(t: T): boolean;
  /** commit a line to going out, cut to `maxChars` when that is shorter; null when it has gone */
  commit(t: T, maxChars?: number | null): L | null;
  /** why a committed line cannot be sent at all, or null */
  unsendable(line: L): Error | null;
  /** how a send ended; a stop is thrown instead */
  outcomeOf(send: () => Promise<RenderedClip>): Promise<Outcome>;
  /** write what came back where the line's slot is */
  land(line: L, outcome: Outcome): Promise<void>;
}

/**
 * An endpoint's lines in batches: each batch takes one of the endpoint's slots, and is filled when
 * it has one, from the lines still waiting, in the chapter's order, up to what the endpoint said
 * it takes. A line longer than an item may be goes as its parts, each its own item, and is joined
 * when they have all come back. Each line lands on its own as its items are answered.
 *
 * A line goes into a later batch, up to the endpoint's retries, when another batch could go
 * differently and nothing has tried it yet: the server answered its item as failed and worth
 * another try, or the batch's answer was cut off before reaching it (`BatchCut`). A batch the
 * server refused whole is not sent again: `call` has already spent the endpoint's retries on that
 * very request, and sending its lines again would try each of them (1 + retries)² times.
 */
export async function batchLines<T, L extends BatchLine<T>>(
  run: LineRun<T, L>,
  id: string,
  lines: readonly T[],
  limits: BatchLimits,
): Promise<void> {
  /** a line still to go: not yet committed, or committed and sent again */
  type Waiting = { t: T; line?: L };
  const pending: Waiting[] = lines.map((t) => ({ t }));
  const order = new Map(lines.map((t, i) => [t, i]));
  const maxItems = limits.maxItems ?? Infinity;
  const maxChars = limits.maxInputChars ?? Infinity;

  /** Take the next batch's lines, committing each; lines that cannot go are landed now. */
  const fill = async (): Promise<L[]> => {
    const batch: L[] = [];
    let items = 0;
    let chars = 0;
    while (pending.length && !run.halted()) {
      const next = pending[0];
      let line: L | null;
      if (next.line) line = next.line;
      else {
        if (run.budgetStops(next.t)) break;
        line = run.commit(next.t, limits.maxItemChars);
      }
      // a line only goes into a batch it fits beside the others; the first always goes
      const parts = line?.cuts?.length ?? 1;
      const size = line?.input.text.length ?? 0;
      if (line && batch.length && (items + parts > maxItems || chars + size > maxChars)) {
        pending[0] = { t: next.t, line };
        break;
      }
      pending.shift();
      if (!line) continue;
      const blocked = run.unsendable(line);
      if (blocked) await run.land(line, { error: blocked });
      // more parts than a batch may carry: sent the way a line always was, one part at a time
      else if (parts > maxItems) {
        const alone = line;
        await run.land(
          alone,
          await run.outcomeOf(() => speakInParts(run.provider, alone.input, alone.cuts)),
        );
      } else {
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
          ? // the whitespace a cut keeps so the parts rejoin is not the provider's to read
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
    /** lines to send again, back at the front of the line in the chapter's order */
    const again: L[] = [];
    const maxRetries = batch[0].input.target?.maxRetries ?? 0;
    /** A line whose send failed: into a later batch when `retry` says one could go differently, else landed failed. */
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
        joined = { rendered: count > 1 ? joinParts(got) : got[0] };
      } catch (e) {
        joined = { error: e };
      }
      landing.push(run.land(line, joined));
    };
    try {
      await run.provider.speakBatch!({
        target: batch[0].input.target!,
        items,
        signal: run.stop,
        answered,
        rateLimited: (ms) => run.gate.rateLimited(id, ms),
      });
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
