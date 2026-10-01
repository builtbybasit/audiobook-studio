// A scripting provider that reads the prose and never the network.
//
// It exists so the real queue, the real storage and the real routes can be exercised end to end —
// the requirement in `docs/demo.md` — without a request leaving the machine. It is deterministic
// on its input, so a test can say what it will produce, and it is honest about what it is: every
// line it attributes comes from punctuation, not understanding.
//
// The rules are simple on purpose. A paragraph is narration. A quoted span inside it is dialogue,
// and the speaker is whoever the paragraph names beside a speech verb — "…," said Mara — or
// `Unknown` when it names nobody. That is enough to give the Scripting page a cast to route, a
// script to correct and clips to render, which is what the screens need to be tested against.
//
// Text that is not the story is marked the way the prompt asks a model to mark it (`OUTPUT_FORMAT`
// in src/lib/prompt.ts), and by the same signals the detector reads (`siteTextSignals`): a paragraph
// that opens as a translator's note is a `note` line, and a sentence that names a web address or
// tells the reader where to read is a `watermark` line, cut out of the paragraph it was dropped
// into with the story either side kept. A sentence is as fine as it cuts — boilerplate dropped into
// the middle of one takes that sentence with it — and every word it was sent is still in a line.
//
// Each call reports one simulated request, with token counts worked out from the text (four
// characters to a token), so a priced profile puts real-looking rows in the ledger and a budget can
// be run out — in a test or a demo — without spending anything.
//
// It is what a simulated profile (`simulated://…`) is answered by, and there it is held to the
// target's `simulation`: each chunk takes as long as that says, and fails as often. A test hands
// it options instead, and a target with no simulation is answered at once, every time.
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
  /** a pause per paragraph, so a test can cancel a run that is genuinely in flight */
  delayMs?: number;
  /** throw with this message instead of answering, to exercise the failure path */
  failWith?: string;
  /** what a simulated failure is drawn against; `Math.random` unless a test wants it fixed */
  random?: () => number;
}

/** Whoever the narration around a quote names next to a speech verb. */
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

/** Straight or curly double quotes, and the text between them. */
const QUOTE = /[“"]([^”"]+)[”"]/gu;

export const UNKNOWN_SPEAKER = "Unknown";

function speakerNear(narration: string): string {
  const m = AFTER.exec(narration) ?? BEFORE.exec(narration);
  return m?.[1] ?? UNKNOWN_SPEAKER;
}

/** One paragraph cut into narration and dialogue, in reading order. */
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

/** What `siteTextSignals` says of a translator's or author's note. */
const OPENS_A_NOTE = "opens as a translator's or author's note";

/**
 * A paragraph's sentences, every character kept. A sentence ends at a full stop, question or
 * exclamation mark outside a quote, and only where the next one starts as a sentence does — so
 * "novelbin . com", "etc. and" and a line of dialogue with two sentences in it stay whole.
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
 * One paragraph as lines, site text marked. A paragraph that opens as a note is one note, every
 * sentence of it; otherwise each sentence that gives itself away is a watermark line, and the
 * story between is attributed as it would have been. A paragraph whose signals no single sentence
 * carries is left as story: when unsure, it is the story.
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

/**
 * A pause that ends early, rejecting with the signal's reason, when the job is cancelled.
 *
 * `timers/promises` does the listening and the cleanup; what it rejects with is its own
 * `AbortError` carrying the reason as `cause`, and the reason itself is what every other path in a
 * provider throws, so it is unwrapped here to keep them alike.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).catch(() => {
    throw signal.reason;
  });
}

/** A rough token count: four characters to a token, which is what the demo's estimates assume. */
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
        // a refusal, as a provider that answered with an error would report it: nothing was used
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
        // what a server error is, so a simulated one is retried as a real one would be
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
    async probe() {
      return { ok: true, message: "Simulated: answered here, without a request", ms: 0 };
    },
  };
}
