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
import type { ScriptInput, ScriptedLine, ScriptingProvider } from "~/providers/scripting";
import { setTimeout as delay } from "node:timers/promises";

export interface FakeScriptingOptions {
  /** a pause per paragraph, so a test can cancel a run that is genuinely in flight */
  delayMs?: number;
  /** throw with this message instead of answering, to exercise the failure path */
  failWith?: string;
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

export function fakeScriptingProvider(options: FakeScriptingOptions = {}): ScriptingProvider {
  return {
    name: "Fake scripting (local)",
    async script({ text, signal, progress }: ScriptInput): Promise<ScriptedLine[]> {
      if (options.failWith) throw new Error(options.failWith);
      const paragraphs = text
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const out: ScriptedLine[] = [];
      for (const [i, paragraph] of paragraphs.entries()) {
        if (options.delayMs) await sleep(options.delayMs, signal);
        if (signal.aborted) throw signal.reason;
        out.push(...attributeParagraph(paragraph));
        progress?.(i + 1, paragraphs.length);
      }
      return out;
    },
  };
}
