// Scripting through any OpenAI-shaped `POST /chat/completions`, one request per chunk. Answers are
// not trusted (fenced JSON, odd types, truncation, tidied prose): each is checked word for word
// (`fidelity`) and refused on a mismatch, except in a prompt trial (`input.lenient`). Every request
// on the wire is reported through `input.sent`, refused or not, since it was billed (`sent.ts`).
import { diffArrays } from "diff";
import * as v from "valibot";

import type {
  Age,
  EndpointProbe,
  Gender,
  PromptTemplate,
  RenderedPrompt,
  SegmentType,
  TokenUsage,
} from "@/types";
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
  fetch?: typeof fetch;
  /** the wait before a retry the answer named none for; tests make it 0 */
  backoffMs?: CallOptions["backoffMs"];
}

/** The built-in prompt for a caller that rendered none, knowing nothing of the book. */
export function builtInPrompt(
  title: string,
  cast: readonly string[],
  text: string,
): RenderedPrompt {
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

/** How much of the prose sent came back as the script's words, in order, and how much was made up. */
export interface Fidelity {
  words: number;
  /** counted with repeats; a moved passage counts as missing where it was and added where it went */
  missing: number;
  added: number;
  /** words counted in both, because the passage they are in came back somewhere else */
  moved: number;
  /** the longest runs of missing words, for the message */
  examples: string[];
  /** at most TOLERANCE of the words either way, and no missing or added run longer than RUN */
  ok: boolean;
}

const TOLERANCE = 0.02;
/** A few words in a row is normalisation (a number spelled out, "Mr." as "Mister"); more is a lost phrase. */
const RUN = 3;
const EXAMPLE_WORDS = 8;

/**
 * Whether `lines` read out `input`: every word once, in order, nothing invented. Past the edits
 * TOLERANCE allows the answer fails anyway, so the diff stops there (an unrelated answer would
 * take seconds) and the figures fall back to counting words.
 */
export function fidelity(input: string, lines: readonly { text: string }[]): Fidelity {
  return wordFidelity(
    wordsOf(input),
    lines.flatMap((l) => wordsOf(l.text)),
  );
}

/** How many words either way `fidelity` lets a text of `words` words differ by. */
export const allowedEdits = (words: number): number => Math.max(1, Math.floor(words * TOLERANCE));

/** `fidelity` over words already read. */
export function wordFidelity(want: string[], got: string[]): Fidelity {
  const allowed = allowedEdits(want.length);
  const parts = diffArrays(want, got, { maxEditLength: 2 * allowed });
  if (!parts) return { words: want.length, ...wordCounts(want, got), moved: 0, ok: false };
  let missing = 0;
  let added = 0;
  let longest = 0;
  const gaps: string[][] = [];
  const addedRuns: string[] = [];
  for (const p of parts) {
    if (p.removed) {
      missing += p.count;
      gaps.push(p.value);
    } else if (p.added) {
      added += p.count;
      addedRuns.push(p.value.join(" "));
    } else continue;
    longest = Math.max(longest, p.count);
  }
  let moved = 0;
  for (const gap of gaps) {
    const at = addedRuns.indexOf(gap.join(" "));
    if (at < 0) continue;
    addedRuns.splice(at, 1);
    moved += gap.length;
  }
  return {
    words: want.length,
    missing,
    added,
    moved,
    examples: gaps
      .sort((a, b) => b.length - a.length)
      .slice(0, 5)
      .map(excerpt),
    ok: missing <= allowed && added <= allowed && longest <= RUN,
  };
}

/** Room for a moved passage of a few paragraphs on top of what `fidelity` allows. */
const MOVE_EDITS = 1000;

/**
 * `lines` in the book's order, when the model moved whole lines and changed nothing else past
 * what `fidelity` allows; else null. The model's k-th line ends up at `modelOrder[k]`.
 */
export function bookOrder<L extends { text: string }>(
  input: string,
  lines: readonly L[],
): { lines: L[]; modelOrder: number[]; moved: number } | null {
  const want = wordsOf(input);
  const per = lines.map((l) => wordsOf(l.text));
  const parts = diffArrays(want, per.flat(), {
    maxEditLength: 2 * allowedEdits(want.length) + MOVE_EDITS,
  });
  if (!parts) return null;
  // the book's index of each answer word that has one; a moved run takes the place it left
  const at: (number | undefined)[] = [];
  const left: { from: number; words: string }[] = [];
  const came: { from: number; count: number; words: string }[] = [];
  let w = 0;
  let g = 0;
  for (const p of parts) {
    if (p.removed) left.push({ from: w, words: p.value.join(" ") });
    else if (p.added) came.push({ from: g, count: p.count, words: p.value.join(" ") });
    else for (let k = 0; k < p.count; k++) at[g + k] = w + k;
    if (!p.added) w += p.count;
    if (!p.removed) g += p.count;
  }
  for (const c of came) {
    const r = left.findIndex((l) => l.words === c.words);
    if (r < 0) continue;
    for (let k = 0; k < c.count; k++) at[c.from + k] = left[r].from + k;
    left.splice(r, 1);
  }
  // a line goes where its first placed word is; one with none stays after the line before it
  let start = 0;
  let last = -1;
  const place = per.map((words) => {
    const k = words.findIndex((_, j) => at[start + j] !== undefined);
    if (k >= 0) last = at[start + k]!;
    start += words.length;
    return last;
  });
  const order = lines.map((_, i) => i).sort((a, b) => place[a] - place[b]);
  if (order.every((i, k) => i === k)) return null;
  const sorted = order.map((i) => lines[i]);
  if (!fidelity(input, sorted).ok) return null;
  const modelOrder: number[] = [];
  order.forEach((i, k) => (modelOrder[i] = k));
  return { lines: sorted, modelOrder, moved: lines.length - longestRising(order) };
}

/** The length of the longest rising run in `xs`, not necessarily contiguous. */
function longestRising(xs: readonly number[]): number {
  const tails: number[] = [];
  for (const x of xs) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
  }
  return tails.length;
}

const excerpt = (words: readonly string[]): string =>
  words.length > EXAMPLE_WORDS ? `${words.slice(0, EXAMPLE_WORDS).join(" ")}…` : words.join(" ");

/** Missing and added regardless of order, for an answer too far off to diff. */
function wordCounts(want: readonly string[], got: readonly string[]) {
  const counts = new Map<string, number>();
  for (const w of want) counts.set(w, (counts.get(w) ?? 0) + 1);
  let added = 0;
  for (const w of got) {
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
  return { missing, added, examples };
}

// ---------------------------------------------------------------------------------------------
// The answer

const Line = v.object({
  type: v.optional(v.string(), ""),
  speaker: v.optional(v.nullable(v.string()), ""),
  text: v.optional(v.nullable(v.string()), ""),
  direction: v.optional(v.nullable(v.string())),
  // read apart: a malformed list must not cost a good script
  effects: v.optional(v.unknown()),
});
const Answer = v.object({
  lines: v.array(Line),
  // read apart, item by item: a malformed note must not cost a good script
  cast: v.optional(v.unknown()),
  recap: v.optional(v.unknown()),
  pronounce: v.optional(v.unknown()),
});

const CastNote = v.object({
  name: v.string(),
  gender: v.optional(v.nullable(v.string())),
  age: v.optional(v.nullable(v.string())),
  aliases: v.optional(v.nullable(v.array(v.string()))),
  description: v.optional(v.nullable(v.string())),
  personaOf: v.optional(v.unknown()),
});

const EFFECT_NAME_MAX = 80;

function effectsOf(said: unknown): string[] {
  if (!Array.isArray(said)) return [];
  const names = said
    .filter((e): e is string => typeof e === "string")
    .map(oneLine)
    .filter((e) => e && e.length <= EFFECT_NAME_MAX);
  return [...new Set(names)];
}

const DESCRIPTION_MAX = 300;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function genderOf(said: string | null | undefined): Gender {
  const g = (said ?? "").trim().toLowerCase();
  if (/^(?:non[- ]?binary|nb|enby|n)$/.test(g)) return "n";
  if (/^(?:f|female|woman|girl)$/.test(g)) return "f";
  if (/^(?:m|male|man|boy)$/.test(g)) return "m";
  return "?";
}

function ageOf(said: string | null | undefined): Age | undefined {
  const a = (said ?? "").trim().toLowerCase();
  if (/^(?:child|kid|boy|girl|baby|infant|toddler)$/.test(a)) return "child";
  if (/^(?:teen|teenager|adolescent|youth)$/.test(a)) return "teen";
  if (/^(?:young adult|young)$/.test(a)) return "young adult";
  if (/^(?:middle[- ]aged)$/.test(a)) return "middle-aged";
  if (/^(?:elderly|elder|old|senior|aged)$/.test(a)) return "elderly";
  return undefined;
}

/** The readable cast notes, skipping the Narrator, "Unknown" and aliases equal to the name. */
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
    // a disguise: whose it is, or that nobody knows yet
    const of = typeof read.output.personaOf === "string" ? oneLine(read.output.personaOf) : "";
    const unknown = /^(?:unknown|someone unknown|\?)$/i.test(of);
    const age = ageOf(read.output.age);
    out.push({
      name,
      gender: genderOf(read.output.gender),
      ...(age ? { age } : {}),
      aliases,
      description: oneLine(read.output.description ?? "").slice(0, DESCRIPTION_MAX),
      ...(unknown ? { masked: true } : of && of !== name ? { personaOf: of } : {}),
    });
  }
  return out;
}

const Term = v.object({ term: v.string(), say: v.string() });

/** The readable suggestions: both halves present, one per term. */
function termsOf(said: unknown): { term: string; say: string }[] {
  if (!Array.isArray(said)) return [];
  const out = new Map<string, { term: string; say: string }>();
  for (const item of said) {
    const read = v.safeParse(Term, item);
    if (!read.success) continue;
    const term = oneLine(read.output.term);
    const say = oneLine(read.output.say);
    if (term && say && say !== term && !out.has(term.toLowerCase()))
      out.set(term.toLowerCase(), { term, say });
  }
  return [...out.values()];
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
 * `usage`, read apart from the answer so a malformed one cannot cost a good script. Loose on
 * purpose: OpenRouter's unasked `usage.cost` (US dollars) rides through to `normalizeUsage`.
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

/** null when the completion said nothing readable. */
export function usageOf(body: unknown): TokenUsage | null {
  const read = v.safeParse(Metered, body);
  return read.success ? normalizeUsage(read.output.usage, "openai") : null;
}

/** Billed thinking, where OpenAI, OpenRouter and DeepSeek document it; read apart from `Metered`. */
const Reasoned = v.looseObject({
  usage: v.looseObject({
    completion_tokens_details: v.looseObject({
      reasoning_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  }),
});

function reasoningTokensOf(body: unknown): number | null {
  const read = v.safeParse(Reasoned, body);
  return read.success ? read.output.usage.completion_tokens_details.reasoning_tokens : null;
}

// Site text is tested first: "site note" is still the site's.
const WATERMARK_SPELLING = /^(?:watermark|site\b|site[-_ ]?text|boilerplate|ads?\b|advert)/;
const NOTE_SPELLING =
  /^(?:(?:t\/?l|tn|translator'?s?|author'?s?|editor'?s?)(?:[-_ ]?notes?)?\b|a\/n\b|notes?\b)/;

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

const voiced = (type: SegmentType): boolean => type === "dialogue" || type === "thought";

/** Quotation marks a model left around a spoken line. */
const WRAPPING_QUOTES = /^["“”]+|["“”]+$/gu;
const OPENING_QUOTES = /^["“”]+\s*/u;

/** A fenced or chatty answer's JSON: from its first `{` to its last `}`. */
function jsonIn(content: string): unknown {
  const unfenced = content.replace(/```(?:json)?/gi, "");
  const from = unfenced.indexOf("{");
  const to = unfenced.lastIndexOf("}");
  if (from < 0 || to < from) throw new Error("no JSON object");
  return JSON.parse(unfenced.slice(from, to + 1));
}

/**
 * The normalised script, tags read in the marker `excerpt` was given. Throws a `ProviderError`
 * otherwise, and for a marker left in a line (the model wrote one nothing can read).
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
    throw new BadAnswer(
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
      throw new BadAnswer(
        `${who} wrote an expression tag that could not be read (“${said.length > 80 ? said.slice(0, 80) + "…" : said}”). The script was not written; run it again or try another model`,
        200,
        false,
      );
    if (voiced(type)) {
      const lead = text.match(OPENING_QUOTES)?.[0].length ?? 0;
      text = text.replace(WRAPPING_QUOTES, "").trim();
      tags = shiftTags(tags, lead, text.length);
    }
    // a stray dash or ellipsis has nothing to read out
    if (!wordsOf(text).length) continue;
    const direction = (l.direction ?? "").trim();
    const effects = effectsOf(l.effects);
    out.push({
      type,
      // site text and notes are the page's, whoever the model said
      speaker: voiced(type) ? speaker || UNKNOWN_SPEAKER : NARRATOR,
      text,
      ...(direction ? { direction } : {}),
      ...(tags.length ? { tags } : {}),
      ...(effects.length ? { effects } : {}),
    });
  }
  const recap = typeof parsed.recap === "string" ? oneLine(parsed.recap) : "";
  const pronounce = termsOf(parsed.pronounce);
  return {
    lines: out,
    cast: castOf(parsed.cast),
    ...(recap ? { recap } : {}),
    ...(pronounce.length ? { pronounce } : {}),
  };
}

/** The model answered, but with no usable script: worth asking again, as answers vary run to run. */
export class BadAnswer extends ProviderError {}

/** An answer cut off, or not the chunk's words: the failures a smaller chunk can get past. */
export class ChunkMisfit extends BadAnswer {}

/**
 * The script in a model's final message, checked against the prose sent (`lenient` skips only the
 * word check). Throws a `ProviderError` with `status`.
 */
export function checkedScript(
  who: string,
  content: string,
  text: string,
  status: number,
  lenient: boolean,
): ScriptAnswer {
  if (!content.trim()) throw new BadAnswer(`${who} answered with no script at all`, status, false);
  // the excerpt picks the marker, as it did for the prompt
  const answer = answerOf(content, who, text);
  const { lines } = answer;
  if (!lines.length)
    throw new BadAnswer(`${who} answered with a script of no lines`, status, false);
  const check = fidelity(text, lines);
  if (!check.ok && !lenient) {
    const fixed = bookOrder(text, lines);
    if (fixed)
      return {
        ...answer,
        lines: fixed.lines,
        reordered: { modelOrder: fixed.modelOrder, moved: fixed.moved },
      };
    const lost = check.missing - check.moved;
    const made = check.added - check.moved;
    const parts = [
      check.moved ? `moved ${check.moved} words out of the book's order` : "",
      lost ? `left out ${lost} of ${check.words} words` : "",
      made ? `added ${made} that are not in the text` : "",
    ].filter(Boolean);
    const example = check.examples.length
      ? ` (${lost ? "missing" : "moved"} e.g. “${check.examples.join("”, “")}”)`
      : "";
    throw new ChunkMisfit(
      `${who} did not copy the text faithfully: it ${parts.join(" and ")}${example}. The script was not written; run it again or try another model`,
      status,
      false,
    );
  }
  return answer;
}

// ---------------------------------------------------------------------------------------------
// The Test button

const PROBE_TEXT = "The lamp guttered in the draught. “Is someone there?” Mara whispered.";

/**
 * The Test button for any provider that sends a rendered prompt: the profile's template around
 * PROBE_TEXT, through `send`. Throws only on cancel; a refusal comes back as not ok.
 */
export async function probeWith(
  target: ScriptTarget,
  signal: AbortSignal,
  given: { template: PromptTemplate; notes: string } | undefined,
  send: (
    prompt: RenderedPrompt,
    text: string,
  ) => Promise<{ answer: ScriptAnswer; reasoningTokens: number | null }>,
): Promise<EndpointProbe> {
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
    } = await send(prompt, PROBE_TEXT);
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
}

// ---------------------------------------------------------------------------------------------
// The provider

/** The message's content, or the whole body when it is not a completion. */
function said(raw: unknown): string {
  const read = v.safeParse(Completion, raw);
  const content = read.success ? read.output.choices[0].message?.content : null;
  return content || (raw === undefined ? "" : JSON.stringify(raw, null, 2));
}

export const NO_PROFILE =
  "This run named no scripting profile; choose one on the Scripting page and run it again";

/** Refuses a run with no profile, or a keyed profile with no key, before any request. */
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
    const report = (
      usage: TokenUsage | null,
      error?: ProviderError,
      body?: string,
      status: SentScript["status"] = error ? "failed" : "done",
    ): void =>
      sent?.({
        startedAt,
        finishedAt: Date.now(),
        attempts: Math.max(1, stats.attempts),
        timedOut: stats.timedOut,
        rateLimited: stats.rateLimited,
        status,
        ...(error ? { error: { code: error.status, message: error.message, body } } : {}),
        simulated: false,
        usage,
      });
    // Reported only once the request went out: the provider may have billed it.
    const cancelled = (usage: TokenUsage | null = null): never => {
      if (stats.attempts) report(usage, undefined, undefined, "cancelled");
      throw signal.reason;
    };

    let res: Response;
    try {
      res = await call(
        target,
        `${target.baseUrl}/chat/completions`,
        { method: "POST", headers: jsonHeaders(target), body: JSON.stringify(body) },
        { signal, fetch: options.fetch, backoffMs: options.backoffMs, stats },
      );
    } catch (e) {
      if (signal.aborted) return cancelled();
      if (e instanceof ProviderError) report(null, e);
      throw e;
    }

    // From here the request was billed, whatever is refused below.
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      raw = undefined;
    }
    if (signal.aborted) return cancelled(usageOf(raw));
    const usage = usageOf(raw);
    const reasoningTokens = reasoningTokensOf(raw);
    try {
      const answer = readAnswer(target, text, res.status, raw, lenient);
      report(usage);
      return { answer, reasoningTokens };
    } catch (e) {
      // keep what a refused answer said, for the Activity tab
      if (e instanceof ProviderError) report(usage, e, said(raw));
      throw e;
    }
  }

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
      // thinking counts against the cap
      const remedy =
        target.reasoning && target.reasoning !== "off"
          ? "raise it or lower the reasoning level on the Endpoints page (the model’s thinking counts against it)"
          : "raise it on the Endpoints page (a reasoning model spends part of it thinking)";
      throw new ChunkMisfit(
        `${target.name}’s answer was cut off at max output tokens (${cap}); ${remedy} or use smaller chunks`,
        status,
        false,
      );
    }
    return checkedScript(target.name, choice.message?.content ?? "", text, status, lenient);
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
    probe: (target, signal, given) =>
      probeWith(target, signal, given, (prompt, text) => request(target, prompt, text, signal)),
  };
}
