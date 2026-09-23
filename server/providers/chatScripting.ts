// A scripting provider that asks a chat-completions model to attribute the prose.
//
// Most hosted models, and most gateways in front of them, speak the OpenAI `POST
// /chat/completions` shape, so one provider reaches all of them: the profile the run was queued
// with names the base URL, the model and the key, and this file names nothing. One request per
// chunk — the job has already cut the chapter into the pieces the profile allows.
//
// What comes back is not trusted. A model asked for JSON may wrap it in a Markdown fence (the
// gateway this was first run against does, `response_format` or not), call a line "speech" rather
// than "dialogue", or run out of output tokens halfway through a line. Worse, it may tidy the
// prose: drop a sentence it thought redundant, summarise a paragraph, fix a word. An audiobook
// that silently skips text is the worst thing this app could make, so every answer is checked word
// for word against what was sent (`fidelity`) and refused, saying how much went missing, when it
// does not match.
import * as v from "valibot";

import type { SegmentType } from "@/types";
import { NARRATOR } from "@/lib/cast";
import { UNKNOWN_SPEAKER } from "~/providers/fake";
import { call, jsonHeaders, ProviderError, requireKey, type CallOptions } from "~/providers/http";
import type {
  ScriptInput,
  ScriptTarget,
  ScriptedLine,
  ScriptingProvider,
} from "~/providers/scripting";
import type { ProbeResult } from "~/providers/target";

export interface ChatScriptingOptions {
  /** injected by tests; the real one otherwise */
  fetch?: typeof fetch;
  /** the wait before a retry that the answer named none for; tests make it 0 */
  backoffMs?: CallOptions["backoffMs"];
}

/** What the model is told the job is. The user message carries the title, the cast and the text. */
export const SYSTEM_PROMPT = `You turn an excerpt from a chapter of an English novel into an audiobook script.

The script is a list of consecutive lines that together read out the excerpt from start to finish. Each line has:
- "type": "narration" for the narrator's prose, "dialogue" for words a character says aloud, "thought" for words a character thinks (usually in italics or marked "she thought").
- "speaker": "Narrator" for narration; for dialogue and thought, the name of the character speaking or thinking.
- "text": the words of the line, copied verbatim from the excerpt.
- "direction" (optional): a few words on how the line is delivered, e.g. "whispering" or "angrily" — only when the prose itself says so. Leave it out otherwise.

Rules:
1. Every word of the excerpt appears exactly once, in the original order. Add nothing, drop nothing, summarise nothing, correct nothing. Keep the punctuation of the prose.
2. Dialogue text is the spoken words without their surrounding quotation marks. A quotation interrupted by narration becomes three lines: dialogue, narration, dialogue.
3. Attribution tags such as "said Mara" or "he asked, frowning" are narration, read by the Narrator; they are never part of the dialogue line.
4. Work out who is speaking from the tags and from the conversation's back-and-forth. When a speaker is one of the known cast, use exactly that name; otherwise use the name the text gives them (e.g. "Old Tobiah", "the Captain"). Use "Unknown" only when nothing in the excerpt says who speaks.
5. Consecutive sentences of narration may share one line; start a new line at every change of speaker or type, and at paragraph breaks.

Answer with JSON only, in this shape:
{"lines":[{"type":"narration","speaker":"Narrator","text":"The door opened."},{"type":"dialogue","speaker":"Mara","text":"Come in,","direction":"softly"},{"type":"narration","speaker":"Narrator","text":"said Mara softly."}]}`;

/** The user message: which book it is, who is known already, and the excerpt itself. */
export function userPrompt(title: string, cast: readonly string[], text: string): string {
  const known = cast.filter((n) => n !== NARRATOR && n !== UNKNOWN_SPEAKER);
  return [
    `Chapter: ${title}`,
    `Known cast: ${known.length ? known.join(", ") : "(none yet)"}`,
    "",
    "Excerpt:",
    text,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Fidelity

/** How much of the prose sent came back as the script's words, and how much was made up. */
export interface Fidelity {
  /** the words the input had */
  words: number;
  /** input words the answer did not have, counted with repeats */
  missing: number;
  /** words the answer had that the input did not */
  added: number;
  /** a few of the missing words, for the message */
  examples: string[];
  /** within tolerance: at most 2% of the words either way, and never less than one */
  ok: boolean;
}

/** The share of words that may differ either way before an answer is refused. */
const TOLERANCE = 0.02;

/** The words of a text as the check compares them: lower case, quotes and punctuation gone. */
export function wordsOf(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[‘’ʼ`´]/g, "'")
      .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []
  );
}

/**
 * Whether `lines` read out `input`: every word once, nothing invented. Compared as a count of
 * each word rather than in order — cheap on a long chunk, and what goes wrong in practice is a
 * sentence dropped or rewritten, which a count sees.
 */
export function fidelity(input: string, lines: readonly { text: string }[]): Fidelity {
  const want = wordsOf(input);
  const counts = new Map<string, number>();
  for (const w of want) counts.set(w, (counts.get(w) ?? 0) + 1);
  let added = 0;
  for (const line of lines)
    for (const w of wordsOf(line.text)) {
      const n = counts.get(w) ?? 0;
      if (n > 0) counts.set(w, n - 1);
      else added++;
    }
  let missing = 0;
  const examples: string[] = [];
  for (const [w, n] of counts)
    if (n > 0) {
      missing += n;
      if (examples.length < 5) examples.push(w);
    }
  const allowed = Math.max(1, Math.floor(want.length * TOLERANCE));
  return {
    words: want.length,
    missing,
    added,
    examples,
    ok: missing <= allowed && added <= allowed,
  };
}

// ---------------------------------------------------------------------------------------------
// The answer

const Line = v.object({
  type: v.optional(v.string(), ""),
  speaker: v.optional(v.nullable(v.string()), ""),
  text: v.optional(v.nullable(v.string()), ""),
  direction: v.optional(v.nullable(v.string())),
});
const Answer = v.object({ lines: v.array(Line) });

const Completion = v.object({
  choices: v.pipe(
    v.array(
      v.object({
        message: v.optional(v.nullable(v.object({ content: v.optional(v.nullable(v.string())) }))),
        finish_reason: v.optional(v.nullable(v.string())),
      }),
    ),
    v.minLength(1),
  ),
});

/** A type as a model may spell it, read as the one it means. */
function typeOf(said: string, speaker: string): SegmentType {
  const t = said.trim().toLowerCase();
  if (t.startsWith("narrat")) return "narration";
  if (t.startsWith("thought") || t.startsWith("think") || t === "internal") return "thought";
  if (t.startsWith("dialog") || t === "speech" || t === "spoken") return "dialogue";
  // anything else is judged by who says it
  return speaker === NARRATOR || !speaker ? "narration" : "dialogue";
}

/** Quotation marks a model left around a spoken line. */
const WRAPPING_QUOTES = /^["“”]+|["“”]+$/gu;

/** A fenced or chatty answer's JSON object: the span from its first `{` to its last `}`. */
export function jsonIn(content: string): unknown {
  const unfenced = content.replace(/```(?:json)?/gi, "");
  const from = unfenced.indexOf("{");
  const to = unfenced.lastIndexOf("}");
  if (from < 0 || to < from) throw new Error("no JSON object");
  return JSON.parse(unfenced.slice(from, to + 1));
}

/** The lines an answer's content holds, normalised; throws a readable `ProviderError` otherwise. */
export function linesOf(content: string, who: string): ScriptedLine[] {
  let parsed: v.InferOutput<typeof Answer>;
  try {
    parsed = v.parse(Answer, jsonIn(content));
  } catch {
    const said = content.replace(/\s+/g, " ").trim();
    throw new ProviderError(
      `${who} did not answer with a script: “${said.length > 120 ? said.slice(0, 120) + "…" : said}”`,
      200,
      false,
    );
  }
  const out: ScriptedLine[] = [];
  for (const l of parsed.lines) {
    const speaker = (l.speaker ?? "").trim();
    const type = typeOf(l.type, speaker);
    let text = (l.text ?? "").replace(/\s+/g, " ").trim();
    if (type !== "narration") text = text.replace(WRAPPING_QUOTES, "").trim();
    // a line with no words — a stray dash, an ellipsis — has nothing to read out
    if (!wordsOf(text).length) continue;
    const direction = (l.direction ?? "").trim();
    out.push({
      type,
      speaker: type === "narration" ? NARRATOR : speaker || UNKNOWN_SPEAKER,
      text,
      ...(direction ? { direction } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The provider

/** Said to a run that reached a real provider with no profile to send it to. */
export const NO_PROFILE =
  "This run named no scripting profile; choose one on the Scripting page and run it again";

/** Two sentences and one quote: what the Test button sends. */
const PROBE_TEXT = "The lamp guttered in the draught. “Is someone there?” Mara whispered.";

/**
 * The provider that sends each chunk to `{baseUrl}/chat/completions` of the profile the run was
 * queued with. Refuses a run with no profile, and a profile that needs a key with none saved,
 * before any request.
 */
export function chatScriptingProvider(options: ChatScriptingOptions = {}): ScriptingProvider {
  async function request(
    target: ScriptTarget,
    title: string,
    cast: readonly string[],
    text: string,
    signal: AbortSignal,
  ): Promise<ScriptedLine[]> {
    requireKey(target);
    const body = {
      model: target.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(title, cast, text) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      ...(target.maxOutputTokens > 0 ? { max_tokens: target.maxOutputTokens } : {}),
    };
    const res = await call(
      target,
      `${target.baseUrl}/chat/completions`,
      { method: "POST", headers: jsonHeaders(target), body: JSON.stringify(body) },
      { signal, fetch: options.fetch, backoffMs: options.backoffMs },
    );
    let completion: v.InferOutput<typeof Completion>;
    try {
      completion = v.parse(Completion, await res.json());
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new ProviderError(
        `${target.name} answered with something that is not a chat completion`,
        res.status,
        false,
      );
    }
    const [choice] = completion.choices;
    if (choice.finish_reason === "length")
      throw new ProviderError(
        `${target.name}’s answer was cut off at max output tokens (${target.maxOutputTokens || "the model’s own limit"}); raise it on the Endpoints page (a reasoning model spends part of it thinking) or use smaller chunks`,
        res.status,
        false,
      );
    const content = choice.message?.content ?? "";
    if (!content.trim())
      throw new ProviderError(`${target.name} answered with no script at all`, res.status, false);
    const lines = linesOf(content, target.name);
    if (!lines.length)
      throw new ProviderError(
        `${target.name} answered with a script of no lines`,
        res.status,
        false,
      );
    const check = fidelity(text, lines);
    if (!check.ok) {
      const parts = [
        check.missing ? `left out ${check.missing} of ${check.words} words` : "",
        check.added ? `added ${check.added} that are not in the text` : "",
      ].filter(Boolean);
      const example = check.examples.length
        ? ` (missing e.g. “${check.examples.join("”, “")}”)`
        : "";
      throw new ProviderError(
        `${target.name} did not copy the text faithfully: it ${parts.join(" and ")}${example}. The script was not written; run it again or try another model`,
        res.status,
        false,
      );
    }
    return lines;
  }

  return {
    name: "Chat completions",
    callsProfile: true,
    async script({ title, text, signal, progress, target, cast }: ScriptInput) {
      if (!target) throw new ProviderError(NO_PROFILE, 0, false);
      progress?.(0, 1);
      const lines = await request(target, title, cast, text, signal);
      progress?.(1, 1);
      return lines;
    },
    async probe(target, signal): Promise<ProbeResult> {
      const started = performance.now();
      const ms = (): number => Math.round(performance.now() - started);
      try {
        const lines = await request(target, "Connection test", [], PROBE_TEXT, signal);
        const speakers = [
          ...new Set(lines.filter((l) => l.type !== "narration").map((l) => l.speaker)),
        ];
        return {
          ok: true,
          message: `Answered in ${ms()} ms with ${lines.length} line${lines.length === 1 ? "" : "s"}${speakers.length ? `, spoken by ${speakers.join(", ")}` : ""}`,
          ms: ms(),
        };
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        return { ok: false, message: e instanceof Error ? e.message : String(e), ms: ms() };
      }
    },
  };
}
