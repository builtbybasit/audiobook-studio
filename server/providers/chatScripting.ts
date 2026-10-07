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
// does not match — except for a prompt trial (`input.lenient`), which is shown the lines and the
// check beside them rather than the refusal. Every other refusal holds for a trial too.
//
// Every request that reaches the wire is reported through `input.sent` with the usage the answer
// carried, whether its script was accepted or refused: a model that was cut off or dropped a
// sentence was still billed for it. See `sent.ts`.
//
// The profile's reasoning level is added as its host spells it (`@/lib/reasoning`), and
// `temperature` is left out where that host refuses or ignores it beside a reasoning level.
import * as v from "valibot";

import type { EndpointProbe, Gender, RenderedPrompt, SegmentType, TokenUsage } from "@/types";
import {
  BUILT_IN_PROMPT,
  readScriptedTags,
  renderPrompt,
  sampleVars,
  scriptMarkerFor,
  shiftTags,
  type PromptCastMember,
} from "@/lib/prompt";
import { NARRATOR } from "@/lib/cast";
import { wordsOf } from "@/lib/gaps";
import { normalizeUsage } from "@/lib/pricing";
import { reasoningRequest } from "@/lib/reasoning";
import { UNKNOWN_SPEAKER } from "~/providers/fake";
import {
  call,
  jsonHeaders,
  ProviderError,
  requireKey,
  type CallOptions,
  type CallStats,
} from "~/providers/http";
import type {
  ScriptAnswer,
  ScriptInput,
  ScriptTarget,
  ScriptedLine,
  ScriptingProvider,
} from "~/providers/scripting";
import type { SentScript } from "~/providers/sent";

export interface ChatScriptingOptions {
  /** injected by tests; the real one otherwise */
  fetch?: typeof fetch;
  /** the wait before a retry that the answer named none for; tests make it 0 */
  backoffMs?: CallOptions["backoffMs"];
}

/**
 * The built-in prompt for one request, for a caller that rendered none: the chapter's title, the
 * cast and the text, with nothing known of the book.
 */
function builtInPrompt(title: string, cast: readonly string[], text: string): RenderedPrompt {
  return renderPrompt(BUILT_IN_PROMPT, {
    book: { title: "", author: "", notes: "" },
    chapter: { title, number: 1 },
    part: 1,
    parts: 1,
    cast: cast.map((name) => ({ name })),
    excerpt: text,
    endpoint: { name: "", model: "" },
  });
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
const Answer = v.object({
  lines: v.array(Line),
  // read apart from the lines, item by item: a malformed note must not cost a good script
  cast: v.optional(v.unknown()),
  recap: v.optional(v.unknown()),
});

const CastNote = v.object({
  name: v.string(),
  gender: v.optional(v.nullable(v.string())),
  aliases: v.optional(v.nullable(v.array(v.string()))),
  description: v.optional(v.nullable(v.string())),
});

/** The longest description kept from a model, which a chatty one can run to a paragraph. */
const DESCRIPTION_MAX = 300;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A gender as a model may spell it. */
function genderOf(said: string | null | undefined): Gender {
  const g = (said ?? "").trim().toLowerCase();
  if (/^(?:non[- ]?binary|nb|enby|n)$/.test(g)) return "n";
  if (/^(?:f|female|woman|girl)$/.test(g)) return "f";
  if (/^(?:m|male|man|boy)$/.test(g)) return "m";
  return "?";
}

/**
 * What an answer says of its speakers, the entries that can be read: one with no name, or naming
 * the Narrator or "Unknown", says nothing about anyone, and an alias that is the name is none.
 */
function castOf(said: unknown): PromptCastMember[] {
  if (!Array.isArray(said)) return [];
  const out: PromptCastMember[] = [];
  for (const item of said) {
    const read = v.safeParse(CastNote, item);
    if (!read.success) continue;
    const name = oneLine(read.output.name);
    if (!name || name === NARRATOR || name === UNKNOWN_SPEAKER) continue;
    const aliases = [
      ...new Set((read.output.aliases ?? []).map(oneLine).filter((a) => a && a !== name)),
    ];
    out.push({
      name,
      gender: genderOf(read.output.gender),
      aliases,
      description: oneLine(read.output.description ?? "").slice(0, DESCRIPTION_MAX),
    });
  }
  return out;
}

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

/**
 * The `usage` block of a completion, read on its own: a gateway that sends a malformed one must not
 * cost a good script, so it is checked apart from the answer and simply read as not reported.
 *
 * It is a loose object on purpose. OpenRouter adds `usage.cost` to every answer, unasked — what the
 * request was charged, in its credits, which are US dollars, at whichever provider served it — and
 * that rides through to `normalizeUsage`, which keeps it as the reported cost beside the tokens.
 */
const Metered = v.looseObject({
  usage: v.looseObject({
    prompt_tokens: v.optional(v.nullable(v.number())),
    completion_tokens: v.optional(v.nullable(v.number())),
    prompt_tokens_details: v.optional(
      v.nullable(v.looseObject({ cached_tokens: v.optional(v.nullable(v.number())) })),
    ),
  }),
});

/** What a completion says it used, normalized; null when it said nothing readable. */
export function usageOf(body: unknown): TokenUsage | null {
  const read = v.safeParse(Metered, body);
  return read.success ? normalizeUsage(read.output.usage, "openai") : null;
}

/**
 * `usage.completion_tokens_details.reasoning_tokens`: the thinking a completion was billed for, where
 * OpenAI, OpenRouter and DeepSeek document it. Read as loosely as `Metered`, and apart from it.
 */
const Reasoned = v.looseObject({
  usage: v.looseObject({
    completion_tokens_details: v.looseObject({
      reasoning_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  }),
});

/** The reasoning tokens a completion says it spent; null when it said nothing readable. */
function reasoningTokensOf(body: unknown): number | null {
  const read = v.safeParse(Reasoned, body);
  return read.success ? read.output.usage.completion_tokens_details.reasoning_tokens : null;
}

/**
 * How a model may spell the two types that are not the story. Site text first, since "site note"
 * is still the site's; a note is anything that says it is one, or names who wrote it.
 */
const WATERMARK_SPELLING = /^(?:watermark|site\b|site[-_ ]?text|boilerplate|ads?\b|advert)/;
const NOTE_SPELLING =
  /^(?:(?:t\/?l|tn|translator'?s?|author'?s?|editor'?s?)(?:[-_ ]?notes?)?\b|a\/n\b|notes?\b)/;

/** A type as a model may spell it, read as the one it means. */
function typeOf(said: string, speaker: string): SegmentType {
  const t = said.trim().toLowerCase();
  if (t.startsWith("narrat")) return "narration";
  if (t.startsWith("thought") || t.startsWith("think") || t === "internal") return "thought";
  if (t.startsWith("dialog") || t === "speech" || t === "spoken") return "dialogue";
  if (WATERMARK_SPELLING.test(t)) return "watermark";
  if (NOTE_SPELLING.test(t)) return "note";
  // anything else is judged by who says it
  return speaker === NARRATOR || !speaker ? "narration" : "dialogue";
}

/** Types a character speaks, whose words a model may have left in their quotation marks. */
const voiced = (type: SegmentType): boolean => type === "dialogue" || type === "thought";

/** Quotation marks a model left around a spoken line, and the space after the opening ones. */
const WRAPPING_QUOTES = /^["“”]+|["“”]+$/gu;
const OPENING_QUOTES = /^["“”]+\s*/u;

/** A fenced or chatty answer's JSON object: the span from its first `{` to its last `}`. */
function jsonIn(content: string): unknown {
  const unfenced = content.replace(/```(?:json)?/gi, "");
  const from = unfenced.indexOf("{");
  const to = unfenced.lastIndexOf("}");
  if (from < 0 || to < from) throw new Error("no JSON object");
  return JSON.parse(unfenced.slice(from, to + 1));
}

/**
 * The script an answer's content holds, normalised, with the expression tags read out of each
 * line's text in the marker `excerpt` was told; throws a readable `ProviderError` otherwise — for
 * a marker left in a line too, which only the model can have written and nothing could read.
 */
export function answerOf(content: string, who: string, excerpt?: string): ScriptAnswer {
  const marker = excerpt === undefined ? null : scriptMarkerFor(excerpt);
  let parsed: v.InferOutput<typeof Answer>;
  try {
    const read = v.safeParse(Answer, jsonIn(content));
    if (!read.success) {
      const [issue] = read.issues;
      const at = v.getDotPath(issue);
      throw new Error(at ? `${at}: ${issue.message}` : issue.message);
    }
    parsed = read.output;
  } catch (e) {
    const said = content.replace(/\s+/g, " ").trim();
    const why = e instanceof Error ? e.message : String(e);
    throw new ProviderError(
      `${who} did not answer with a script (${why}): “${said.length > 80 ? said.slice(0, 80) + "…" : said}”`,
      200,
      false,
    );
  }
  const out: ScriptedLine[] = [];
  for (const l of parsed.lines) {
    const speaker = (l.speaker ?? "").trim();
    const type = typeOf(l.type, speaker);
    const said = (l.text ?? "").replace(/\s+/g, " ").trim();
    let { text, tags } = readScriptedTags(said, marker, excerpt);
    if (marker?.some((half) => text.includes(half)))
      throw new ProviderError(
        `${who} wrote an expression tag that could not be read (“${said.length > 80 ? said.slice(0, 80) + "…" : said}”). The script was not written; run it again or try another model`,
        200,
        false,
      );
    if (voiced(type)) {
      const lead = text.match(OPENING_QUOTES)?.[0].length ?? 0;
      text = text.replace(WRAPPING_QUOTES, "").trim();
      tags = shiftTags(tags, lead, text.length);
    }
    // a line with no words — a stray dash, an ellipsis — has nothing to read out
    if (!wordsOf(text).length) continue;
    const direction = (l.direction ?? "").trim();
    out.push({
      type,
      // site text and notes are nobody's lines but the page's, whoever the model said
      speaker: voiced(type) ? speaker || UNKNOWN_SPEAKER : NARRATOR,
      text,
      ...(direction ? { direction } : {}),
      ...(tags.length ? { tags } : {}),
    });
  }
  const recap = typeof parsed.recap === "string" ? oneLine(parsed.recap) : "";
  return { lines: out, cast: castOf(parsed.cast), ...(recap ? { recap } : {}) };
}

// ---------------------------------------------------------------------------------------------
// The provider

/** What an answer said: its message's content, or the whole body when it is not a completion. */
function said(raw: unknown): string {
  const read = v.safeParse(Completion, raw);
  const content = read.success ? read.output.choices[0].message?.content : null;
  return content || (raw === undefined ? "" : JSON.stringify(raw, null, 2));
}

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
    prompt: RenderedPrompt,
    text: string,
    signal: AbortSignal,
    sent?: (request: SentScript) => void,
    lenient = false,
  ): Promise<{ answer: ScriptAnswer; reasoningTokens: number | null }> {
    requireKey(target);
    const reasoning = reasoningRequest(target.baseUrl, target.reasoning);
    const body = {
      model: target.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      response_format: { type: "json_object" },
      ...(reasoning.omitTemperature ? {} : { temperature: 0.1 }),
      ...(target.maxOutputTokens > 0 ? { max_tokens: target.maxOutputTokens } : {}),
      ...reasoning.fields,
    };
    const stats: CallStats = { attempts: 0, rateLimited: false };
    const startedAt = Date.now();
    /** The one report for this request: what it used, and how it ended. */
    const report = (usage: TokenUsage | null, error?: ProviderError, body?: string): void =>
      sent?.({
        startedAt,
        finishedAt: Date.now(),
        attempts: Math.max(1, stats.attempts),
        rateLimited: stats.rateLimited,
        status: error ? "failed" : "done",
        ...(error ? { error: { code: error.status, message: error.message, body } } : {}),
        simulated: false,
        usage,
      });

    let res: Response;
    try {
      res = await call(
        target,
        `${target.baseUrl}/chat/completions`,
        { method: "POST", headers: jsonHeaders(target), body: JSON.stringify(body) },
        { signal, fetch: options.fetch, backoffMs: options.backoffMs, stats },
      );
    } catch (e) {
      // a cancel is not a request that ended: what the provider made of it is not knowable
      if (signal.aborted) throw signal.reason;
      if (e instanceof ProviderError) report(null, e);
      throw e;
    }

    // From here the request was answered, and whatever is refused below was billed as it stands.
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      if (signal.aborted) throw signal.reason;
      raw = undefined;
    }
    if (signal.aborted) throw signal.reason;
    const usage = usageOf(raw);
    const reasoningTokens = reasoningTokensOf(raw);
    try {
      const answer = readAnswer(target, text, res.status, raw, lenient);
      report(usage);
      return { answer, reasoningTokens };
    } catch (e) {
      // the answer was refused for what it said, so keep what it said for the Activity tab
      if (e instanceof ProviderError) report(usage, e, said(raw));
      throw e;
    }
  }

  /**
   * The script an answer holds, checked against the prose it was sent; throws what is wrong. A
   * lenient read hands back lines that fail the word check instead of refusing them.
   */
  function readAnswer(
    target: ScriptTarget,
    text: string,
    status: number,
    raw: unknown,
    lenient: boolean,
  ): ScriptAnswer {
    const parsed = v.safeParse(Completion, raw);
    if (!parsed.success)
      throw new ProviderError(
        `${target.name} answered with something that is not a chat completion`,
        status,
        false,
      );
    const completion = parsed.output;
    const [choice] = completion.choices;
    if (choice.finish_reason === "length") {
      const cap = target.maxOutputTokens || "the model’s own limit";
      // a level other than off asked the model to think, and its thinking counts against the cap
      const remedy =
        target.reasoning && target.reasoning !== "off"
          ? "raise it or lower the reasoning level on the Endpoints page (the model’s thinking counts against it)"
          : "raise it on the Endpoints page (a reasoning model spends part of it thinking)";
      throw new ProviderError(
        `${target.name}’s answer was cut off at max output tokens (${cap}); ${remedy} or use smaller chunks`,
        status,
        false,
      );
    }
    const content = choice.message?.content ?? "";
    if (!content.trim())
      throw new ProviderError(`${target.name} answered with no script at all`, status, false);
    // the excerpt names the marker, as it did for the prompt this answers
    const answer = answerOf(content, target.name, text);
    const { lines } = answer;
    if (!lines.length)
      throw new ProviderError(`${target.name} answered with a script of no lines`, status, false);
    const check = fidelity(text, lines);
    if (!check.ok && !lenient) {
      const parts = [
        check.missing ? `left out ${check.missing} of ${check.words} words` : "",
        check.added ? `added ${check.added} that are not in the text` : "",
      ].filter(Boolean);
      const example = check.examples.length
        ? ` (missing e.g. “${check.examples.join("”, “")}”)`
        : "";
      throw new ProviderError(
        `${target.name} did not copy the text faithfully: it ${parts.join(" and ")}${example}. The script was not written; run it again or try another model`,
        status,
        false,
      );
    }
    return answer;
  }

  return {
    name: "Chat completions",
    callsProfile: true,
    async script({
      title,
      text,
      signal,
      progress,
      target,
      cast,
      prompt,
      lenient,
      sent,
    }: ScriptInput) {
      if (!target) throw new ProviderError(NO_PROFILE, 0, false);
      progress?.(0, 1);
      const { answer } = await request(
        target,
        prompt ?? builtInPrompt(title, cast, text),
        text,
        signal,
        sent,
        lenient,
      );
      progress?.(1, 1);
      return answer;
    },
    async probe(target, signal, given): Promise<EndpointProbe> {
      const started = performance.now();
      const ms = (): number => Math.round(performance.now() - started);
      try {
        // reports nothing: a connection test belongs to no book, and the ledger is per book
        const prompt = renderPrompt(
          given?.template ?? BUILT_IN_PROMPT,
          sampleVars(PROBE_TEXT, { name: target.name, model: target.model, notes: given?.notes }),
        );
        const {
          answer: { lines },
          reasoningTokens,
        } = await request(target, prompt, PROBE_TEXT, signal);
        const speakers = [...new Set(lines.filter((l) => voiced(l.type)).map((l) => l.speaker))];
        // a count of none is news only to someone who picked a level, "off" above all
        const thought =
          reasoningTokens !== null && (reasoningTokens > 0 || target.reasoning)
            ? `; ${reasoningTokens} reasoning token${reasoningTokens === 1 ? "" : "s"}`
            : "";
        return {
          ok: true,
          message: `Answered in ${ms()} ms with ${lines.length} line${lines.length === 1 ? "" : "s"}${speakers.length ? `, spoken by ${speakers.join(", ")}` : ""}${thought}`,
          ms: ms(),
        };
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        return { ok: false, message: e instanceof Error ? e.message : String(e), ms: ms() };
      }
    },
  };
}
