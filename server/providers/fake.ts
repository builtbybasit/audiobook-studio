// A deterministic scripting provider that never touches the network, for tests and simulated
// profiles. Quotes become dialogue, attributed to a name beside a speech verb or `Unknown`. Site
// text is marked by `siteTextSignals`, a sentence at a time. Token counts are text length / 4.
// A simulated target's `simulation` sets its latency and failure rate.
import { normalizeUsage } from "@/lib/pricing";
import { siteTextSignals } from "@/lib/siteText";
import { ProviderError } from "~/providers/http";
import type {
  ScriptAnswer,
  ScriptInput,
  ScriptedLine,
  ScriptingProvider,
} from "~/providers/scripting";
import { setTimeout as delay } from "node:timers/promises";

export interface FakeScriptingOptions {
  /** per paragraph, so a test can cancel a run in flight */
  delayMs?: number;
  /** throw this instead of answering */
  failWith?: string;
  /** `Math.random` unless a test wants it fixed */
  random?: () => number;
}

const SPEECH_VERBS =
  "said|asked|replied|whispered|shouted|muttered|called|answered|murmured|cried|added|snapped";
const AFTER = new RegExp(
  `\\b(?:${SPEECH_VERBS})\\s+(\\p{Lu}[\\p{L}'’-]+(?:\\s\\p{Lu}[\\p{L}'’-]+)?)`,
  "u",
);
const BEFORE = new RegExp(
  `(\\p{Lu}[\\p{L}'’-]+(?:\\s\\p{Lu}[\\p{L}'’-]+)?)\\s+(?:${SPEECH_VERBS})\\b`,
  "u",
);

const QUOTE = /[“"]([^”"]+)[”"]/gu;

export const UNKNOWN_SPEAKER = "Unknown";

function speakerNear(narration: string): string {
  const m = AFTER.exec(narration) ?? BEFORE.exec(narration);
  return m?.[1] ?? UNKNOWN_SPEAKER;
}

export function attributeParagraph(paragraph: string): ScriptedLine[] {
  const lines: ScriptedLine[] = [];
  let at = 0;
  const around = paragraph.replace(QUOTE, " ");
  for (const m of paragraph.matchAll(QUOTE)) {
    const before = paragraph.slice(at, m.index).trim();
    if (before) lines.push({ type: "narration", speaker: "Narrator", text: before });
    lines.push({ type: "dialogue", speaker: speakerNear(around), text: m[1].trim() });
    at = m.index + m[0].length;
  }
  const rest = paragraph.slice(at).trim();
  if (rest) lines.push({ type: "narration", speaker: "Narrator", text: rest });
  return lines;
}

const OPENS_A_NOTE = "opens as a translator's or author's note";

/**
 * Every character kept. A sentence ends at `.!?…` outside a quote, and only where the next starts
 * like a sentence, so "novelbin . com", "etc. and" and a two-sentence quote stay whole.
 */
function sentencesOf(paragraph: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let from = 0;
  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i];
    const closes = ch === "”" || (ch === '"' && quoted);
    if (ch === "“" || (ch === '"' && !quoted)) quoted = true;
    else if (closes) quoted = false;
    const ends = /[.!?…]/.test(ch) ? !quoted : closes && /[.!?…]/.test(paragraph[i - 1] ?? "");
    if (!ends) continue;
    let to = i + 1;
    while (/[)\]’']/.test(paragraph[to] ?? "")) to++;
    const next = /^\s+(?=[\p{Lu}\p{N}“"([‘])/u.exec(paragraph.slice(to));
    if (!next) continue;
    out.push(paragraph.slice(from, to));
    from = to + next[0].length;
    i = from - 1;
  }
  out.push(paragraph.slice(from));
  return out.filter(Boolean);
}

const marked = (type: "watermark" | "note", text: string): ScriptedLine => ({
  type,
  speaker: "Narrator",
  text,
});

/**
 * A paragraph opening as a note is one note; otherwise each sentence with a signal is a watermark.
 * Signals no single sentence carries leave it as story: when unsure, it is the story.
 */
export function scriptParagraph(paragraph: string): ScriptedLine[] {
  const signals = siteTextSignals(paragraph);
  if (!signals.length) return attributeParagraph(paragraph);
  if (signals.includes(OPENS_A_NOTE)) return [marked("note", paragraph)];
  const lines: ScriptedLine[] = [];
  let story: string[] = [];
  const flush = () => {
    if (story.length) lines.push(...attributeParagraph(story.join(" ")));
    story = [];
  };
  for (const sentence of sentencesOf(paragraph)) {
    const saw = siteTextSignals(sentence);
    if (!saw.length) story.push(sentence);
    else {
      flush();
      lines.push(marked(saw.includes(OPENS_A_NOTE) ? "note" : "watermark", sentence));
    }
  }
  flush();
  return lines;
}

/** Rejects with the signal's own reason, not `timers/promises`' wrapping `AbortError`. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).catch(() => {
    throw signal.reason;
  });
}

const tokensIn = (text: string): number => Math.ceil(text.length / 4);

export function fakeScriptingProvider(options: FakeScriptingOptions = {}): ScriptingProvider {
  const random = options.random ?? Math.random;
  return {
    name: "Simulated scripting",
    async script({ text, signal, progress, sent, target }: ScriptInput): Promise<ScriptAnswer> {
      const startedAt = Date.now();
      const simulation = target?.simulation;
      if (simulation?.latencyMs) await sleep(simulation.latencyMs, signal);
      const failure =
        options.failWith ??
        (simulation && random() < simulation.failRate
          ? `${target!.name} failed this request on purpose: it fails ${Math.round(simulation.failRate * 100)}% of them`
          : null);
      if (failure) {
        // a refusal: nothing was used
        sent?.({
          startedAt,
          finishedAt: Date.now(),
          attempts: 1,
          rateLimited: false,
          status: "failed",
          error: { code: 0, message: failure },
          simulated: true,
          usage: null,
        });
        // a 500, so it is retried like a real one
        throw options.failWith ? new Error(failure) : new ProviderError(failure, 500, true);
      }
      const paragraphs = text
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const out: ScriptedLine[] = [];
      for (const [i, paragraph] of paragraphs.entries()) {
        if (options.delayMs) await sleep(options.delayMs, signal);
        if (signal.aborted) throw signal.reason;
        out.push(...scriptParagraph(paragraph));
        progress?.(i + 1, paragraphs.length);
      }
      sent?.({
        startedAt,
        finishedAt: Date.now(),
        attempts: 1,
        rateLimited: false,
        status: "done",
        simulated: true,
        usage: normalizeUsage(
          {
            inputTokens: tokensIn(text),
            outputTokens: tokensIn(out.map((l) => l.text).join("")),
            cachedInput: null,
          },
          "internal",
        ),
      });
      return { lines: out };
    },
    async ask({ system, user, signal, sent, target, simulated }) {
      const startedAt = Date.now();
      if (target?.simulation?.latencyMs) await sleep(target.simulation.latencyMs, signal);
      if (options.failWith) throw new Error(options.failWith);
      sent?.({
        startedAt,
        finishedAt: Date.now(),
        attempts: 1,
        rateLimited: false,
        status: "done",
        simulated: true,
        usage: normalizeUsage(
          {
            inputTokens: tokensIn(system + user),
            outputTokens: tokensIn(JSON.stringify(simulated)),
            cachedInput: null,
          },
          "internal",
        ),
      });
      return structuredClone(simulated);
    },
    async probe() {
      return { ok: true, message: "Simulated: answered here, without a request", ms: 0 };
    },
  };
}
