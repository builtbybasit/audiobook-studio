// Scripting through any OpenAI-shaped `POST /chat/completions`, one request per chunk. Answers are
// not trusted (fenced JSON, odd types, truncation, tidied prose): each is checked word for word
// (`fidelity`) and refused on a mismatch, except in a prompt trial (`input.lenient`). Every request
// on the wire is reported through `input.sent`, refused or not, since it was billed (`sent.ts`).
import { diffArrays } from "diff";
import * as v from "valibot";

import type {
  Age,
  EndpointProbe,
  FactKind,
  Gender,
  MendKind,
  PromptTemplate,
  RenderedPrompt,
  SegmentType,
  TokenUsage,
  VoiceType,
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
import { FACT_KINDS, NARRATOR } from "@/lib/cast";
import { wordsOf } from "@/lib/gaps";
import { normalizeUsage } from "@/lib/pricing";
import { DELIVERIES, PITCHES, TEXTURES } from "@/lib/voiceProfile";
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
  AskInput,
  ScriptAnswer,
  ScriptInput,
  ScriptRepair,
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
    source: { text, offset: 0 },
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
// Mending an answer that fails the word check

/** Room for a moved passage of a few paragraphs on top of what `fidelity` allows. */
const MOVE_EDITS = 1000;
/** The most words put back without asking: more could be a line in a voice the answer lacks. */
const LOCAL_WORDS = 12;

/** Book words `[from, to)` came back as answer words `[at, end)`; either side may be empty. */
interface Hunk {
  from: number;
  to: number;
  at: number;
  end: number;
}

/**
 * The answer's words against the book's: where each answer word sits in the book (a moved run
 * takes the place it left) and the places they part, moves aside. Null past MOVE_EDITS.
 */
function alignWords(want: string[], got: string[]) {
  const parts = diffArrays(want, got, {
    maxEditLength: 2 * allowedEdits(want.length) + MOVE_EDITS,
  });
  if (!parts) return null;
  const runs: { from: number; at: number; count: number; side: "same" | "left" | "came" }[] = [];
  let w = 0;
  let g = 0;
  for (const p of parts) {
    runs.push({
      from: w,
      at: g,
      count: p.count,
      side: p.removed ? "left" : p.added ? "came" : "same",
    });
    if (!p.added) w += p.count;
    if (!p.removed) g += p.count;
  }
  const place: (number | undefined)[] = [];
  const moved = new Set<(typeof runs)[number]>();
  for (const r of runs) {
    if (r.side === "same") for (let k = 0; k < r.count; k++) place[r.at + k] = r.from + k;
    if (r.side !== "came") continue;
    const words = got.slice(r.at, r.at + r.count).join(" ");
    const left = runs.find(
      (l) =>
        l.side === "left" &&
        !moved.has(l) &&
        want.slice(l.from, l.from + l.count).join(" ") === words,
    );
    if (!left) continue;
    moved.add(left).add(r);
    for (let k = 0; k < r.count; k++) place[r.at + k] = left.from + k;
  }
  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  for (const r of runs) {
    if (r.side === "same" || moved.has(r)) {
      open = null;
      continue;
    }
    if (!open) hunks.push((open = { from: r.from, to: r.from, at: r.at, end: r.at }));
    if (r.side === "left") open.to = r.from + r.count;
    else open.end = r.at + r.count;
  }
  return { place, hunks };
}

/** Each word's place in `text` as `[from, to)`, or null where `wordsOf` would count otherwise. */
function spansOf(text: string): [number, number][] | null {
  const spans = [...text.matchAll(/[\p{L}\p{N}]+(?:['‘’ʼ`´][\p{L}\p{N}]+)*/gu)].map(
    (m): [number, number] => [m.index, m.index + m[0].length],
  );
  return spans.length === wordsOf(text).length ? spans : null;
}

const hunkSize = (h: Hunk): number => Math.max(h.to - h.from, h.end - h.at);

/**
 * `lines` with the book's own words put back where `least` or more were left out, added or
 * changed together, when it is clear which line they belong to; else null.
 */
function patchWords<L extends ScriptedLine>(
  input: string,
  want: string[],
  lines: readonly L[],
  least: number,
): { lines: L[]; words: number } | null {
  const book = spansOf(input);
  const spans = lines.map((l) => spansOf(l.text));
  if (!book || spans.some((s) => !s)) return null;
  const owner = spans.flatMap((s, li) => s!.map((_, k) => [li, k] as const));
  const aligned = alignWords(
    want,
    lines.flatMap((l) => wordsOf(l.text)),
  );
  if (!aligned) return null;
  const edits: { line: number; from: number; to: number; text: string; note: string }[] = [];
  let words = 0;
  for (const h of aligned.hunks) {
    const size = hunkSize(h);
    if (size < least) continue;
    if (size > LOCAL_WORDS || h.from === 0 || h.to >= want.length) return null;
    // the book between the words either side: a quote or a paragraph break means another voice
    if (/[“”"\n]/.test(input.slice(book[h.from - 1][1], book[h.to][0]))) return null;
    let said = "";
    if (h.to > h.from) {
      const [from, to] = [book[h.from][0], book[h.to - 1][1]];
      said = input.slice(from, to + (input.slice(to).match(/^[.,;:!?…]+/)?.[0].length ?? 0));
    }
    if (h.end > h.at) {
      const [li, k0] = owner[h.at];
      const [lj, k1] = owner[h.end - 1];
      if (li !== lj) return null;
      const s = spans[li]!;
      const came = quoted(lines[li].text.slice(s[k0][0], s[k1][1]));
      if (said)
        edits.push({
          line: li,
          from: s[k0][0],
          to: s[k1][1],
          text: said,
          note: `${quoted(said)} for ${came}`,
        });
      // a space goes with the words taken out
      else if (k0 > 0)
        edits.push({
          line: li,
          from: s[k0 - 1][1],
          to: s[k1][1],
          text: "",
          note: `took out ${came}`,
        });
      else if (k1 + 1 < s.length)
        edits.push({
          line: li,
          from: s[k0][0],
          to: s[k1 + 1][0],
          text: "",
          note: `took out ${came}`,
        });
      else return null;
    } else {
      const next = owner[h.at];
      const prev = owner[h.at - 1];
      if (!next || !prev) return null;
      const [a, b] = [lines[prev[0]], lines[next[0]]];
      if (prev[0] !== next[0] && (a.speaker !== b.speaker || a.type !== b.type)) return null;
      const at = spans[next[0]]![next[1]][0];
      edits.push({
        line: next[0],
        from: at,
        to: at,
        text: `${said} `,
        note: `put back ${quoted(said)}`,
      });
    }
    words += size;
  }
  const out = [...lines];
  for (const e of edits.sort((x, y) => y.from - x.from)) {
    const l = out[e.line];
    const delta = e.text.length - (e.to - e.from);
    out[e.line] = withMend(
      {
        ...l,
        text: l.text.slice(0, e.from) + e.text + l.text.slice(e.to),
        ...(l.tags?.length && {
          tags: l.tags.map((t) => ({
            ...t,
            at: t.at <= e.from ? t.at : t.at >= e.to ? t.at + delta : e.from,
          })),
        }),
      },
      "words",
      e.note,
    );
  }
  return out.some((l) => !wordsOf(l.text).length) ? null : { lines: out, words };
}

/**
 * An answer that fails the word check made to pass without asking again: whole lines the model
 * moved go back to the book's order, and a few lost or changed words are put back from the book.
 * The model's k-th line ends up at `modelOrder[k]`. Null when neither makes it pass.
 */
export function mendScript<L extends ScriptedLine>(
  input: string,
  lines: readonly L[],
): { lines: L[]; modelOrder: number[]; moved: number; patched: number } | null {
  const want = wordsOf(input);
  const per = lines.map((l) => wordsOf(l.text));
  const aligned = alignWords(want, per.flat());
  if (!aligned) return null;
  // a line goes where its first placed word is; one with none stays after the line before it
  let start = 0;
  let last = -1;
  const place = per.map((words) => {
    const k = words.findIndex((_, j) => aligned.place[start + j] !== undefined);
    if (k >= 0) last = aligned.place[start + k]!;
    start += words.length;
    return last;
  });
  const order = lines.map((_, i) => i).sort((a, b) => place[a] - place[b]);
  const kept = risingRun(order);
  const sorted = order.map((i) => (kept.has(i) ? lines[i] : withMend(lines[i], "moved")));
  // the slips `fidelity` allows are left as the model wrote them unless the rest is not enough
  const patched = [RUN + 1, 1]
    .map((least) => patchWords(input, want, sorted, least))
    .find((p) => p && fidelity(input, p.lines).ok);
  if (!patched) return null;
  const modelOrder: number[] = [];
  order.forEach((i, k) => (modelOrder[i] = k));
  return {
    lines: patched.lines,
    modelOrder,
    moved: lines.length - kept.size,
    patched: patched.words,
  };
}

/** The values of a longest rising run in `xs`, not necessarily contiguous: what kept its order. */
function risingRun(xs: readonly number[]): Set<number> {
  // `tails[n]`: where in `xs` the smallest end of a run n + 1 long is
  const tails: number[] = [];
  const before: number[] = [];
  xs.forEach((x, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]] < x) lo = mid + 1;
      else hi = mid;
    }
    before[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const kept = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = before[i]) kept.add(xs[i]);
  return kept;
}

/** `line` marked as mended by `kind`, keeping any earlier mark. */
function withMend<L extends ScriptedLine>(line: L, kind: MendKind, detail?: string): L {
  const kinds = [...new Set([...(line.mended?.kinds ?? []), kind])];
  const said = [line.mended?.detail, detail].filter(Boolean).join("; ");
  return { ...line, mended: { kinds, ...(said ? { detail: said } : {}) } };
}

/** The most of an answer a repair asks back before a whole new answer is the better buy. */
const REPAIR_SHARE = 0.25;
const QUOTED = 120;
const quoted = (t: string): string => `“${t.length > QUOTED ? t.slice(0, QUOTED) + "…" : t}”`;

/**
 * What to send back so the model fixes only the lines that part from the book, or null when that
 * is most of the answer. Ranges are 1-based and inclusive, in the answer's own numbering.
 */
function repairFor(input: string, content: string, answer: ScriptAnswer): ScriptRepair | null {
  const { lines } = answer;
  const want = wordsOf(input);
  const book = spansOf(input);
  const aligned = alignWords(
    want,
    lines.flatMap((l) => wordsOf(l.text)),
  );
  if (!aligned || !book) return null;
  const owner = lines.flatMap((l, li) => wordsOf(l.text).map(() => li));
  const big = aligned.hunks.filter((h) => hunkSize(h) > RUN);
  const found: { from: number; to: number; what: string }[] = [];
  for (const h of big.length ? big : aligned.hunks) {
    const from = owner[h.end > h.at ? h.at : Math.max(0, h.at - 1)] ?? lines.length - 1;
    const to = owner[h.end > h.at ? h.end - 1 : Math.min(h.at, owner.length - 1)] ?? from;
    const left = h.to > h.from ? input.slice(book[h.from][0], book[h.to - 1][1]) : "";
    const came =
      h.end > h.at
        ? lines
            .flatMap((l) => wordsOf(l.text))
            .slice(h.at, h.end)
            .join(" ")
        : "";
    const what =
      left && came
        ? `${quoted(came)} stands where the excerpt has ${quoted(left)}`
        : left
          ? `${quoted(left)} is left out`
          : `${quoted(came)} is added, but is not in the excerpt`;
    found.push({ from: Math.min(from, to) + 1, to: Math.max(from, to) + 1, what });
  }
  const ranges: { from: number; to: number }[] = [];
  for (const f of [...found].sort((a, b) => a.from - b.from)) {
    const r = ranges.at(-1);
    if (r && f.from <= r.to + 1) r.to = Math.max(r.to, f.to);
    else ranges.push({ from: f.from, to: f.to });
  }
  const asked = ranges.reduce((n, r) => n + r.to - r.from + 1, 0);
  if (!ranges.length || asked > Math.max(3, lines.length * REPAIR_SHARE)) return null;
  const name = (r: { from: number; to: number }) =>
    r.from === r.to ? `line ${r.from}` : `lines ${r.from}–${r.to}`;
  const note = [
    "Your script, as you sent it:",
    content.trim(),
    "",
    "It does not hold the excerpt's words exactly:",
    // models miscount lines, so each is named by how it starts too
    ...found.map(
      (f) => `- ${name(f)} (from “${excerpt(lines[f.from - 1].text.split(/\s+/))}”): ${f.what}`,
    ),
    "",
    `Send back only ${ranges.map(name).join(", ")}, fixed so every word of the excerpt is there once and nothing is added. Answer with JSON only, each line written as before: {"ranges":[${ranges.map((r) => `{"from":${r.from},"to":${r.to},"lines":[…]}`).join(",")}]}`,
  ].join("\n");
  return { answer, content, ranges, note };
}

/** The prompt answered, then what to fix in a block of its own, so the prompt is read from cache. */
export const repairPrompt = (prompt: RenderedPrompt, repair: ScriptRepair): RenderedPrompt => ({
  ...prompt,
  followUp: repair.note,
});

const Ranges = v.object({
  ranges: v.array(v.object({ from: v.number(), to: v.number(), lines: v.array(v.unknown()) })),
});

/** The repaired answer: the asked ranges replaced by the lines sent back for them. */
function repaired(who: string, content: string, text: string, repair: ScriptRepair): ScriptAnswer {
  let sent: v.InferOutput<typeof Ranges>["ranges"];
  try {
    const read = v.safeParse(Ranges, jsonIn(content));
    if (!read.success) throw new Error(read.issues[0].message);
    sent = read.output.ranges;
  } catch (e) {
    throw new BadAnswer(
      `${who} did not send back the lines it was asked to fix (${e instanceof Error ? e.message : String(e)})`,
      200,
      false,
    );
  }
  const lines = [...repair.answer.lines];
  for (const r of [...repair.ranges].sort((a, b) => b.from - a.from)) {
    const got = sent.find((s) => s.from === r.from && s.to === r.to);
    if (!got)
      throw new BadAnswer(`${who} did not send back lines ${r.from}–${r.to} to fix`, 200, false);
    const fixed = answerOf(JSON.stringify({ lines: got.lines }), who, text).lines;
    lines.splice(r.from - 1, r.to - r.from + 1, ...fixed.map((l) => withMend(l, "model")));
  }
  return { ...repair.answer, lines };
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
  personaOf: v.optional(v.unknown()),
  voiceType: v.optional(v.unknown()),
  // read apart, item by item: one odd fact must not cost the note
  facts: v.optional(v.unknown()),
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

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export function genderOf(said: string | null | undefined): Gender {
  const g = (said ?? "").trim().toLowerCase();
  if (/^(?:non[- ]?binary|nb|enby|n)$/.test(g)) return "n";
  if (/^(?:f|female|woman|girl)$/.test(g)) return "f";
  if (/^(?:m|male|man|boy)$/.test(g)) return "m";
  return "?";
}

export function ageOf(said: string | null | undefined): Age | undefined {
  const a = (said ?? "").trim().toLowerCase();
  if (/^(?:child|kid|boy|girl|baby|infant|toddler)$/.test(a)) return "child";
  if (/^(?:teen|teenager|adolescent|youth)$/.test(a)) return "teen";
  if (/^(?:young adult|young)$/.test(a)) return "young adult";
  if (/^(?:middle[- ]aged)$/.test(a)) return "middle-aged";
  if (/^(?:elderly|elder|old|senior|aged)$/.test(a)) return "elderly";
  return undefined;
}

const listed = <T extends string>(list: readonly T[], said: unknown): T | undefined => {
  const w = typeof said === "string" ? said.trim().toLowerCase() : "";
  return list.find((x) => x === w);
};

/** What of a note's voice type uses the shared words; anything else is dropped, not guessed. */
export function voiceTypeOf(said: unknown): VoiceType | undefined {
  if (!said || typeof said !== "object") return undefined;
  const s = said as Record<string, unknown>;
  const pitch = listed(PITCHES, s.pitch);
  const texture = listed(TEXTURES, s.texture);
  const delivery = Array.isArray(s.delivery)
    ? [
        ...new Set(s.delivery.map((d) => listed(DELIVERIES, d)).filter((d) => d !== undefined)),
      ].slice(0, 3)
    : [];
  const out: VoiceType = {
    ...(pitch ? { pitch } : {}),
    ...(texture ? { texture } : {}),
    ...(delivery.length ? { delivery } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

const Fact = v.object({
  kind: v.string(),
  text: v.string(),
  sourceIds: v.optional(
    v.pipe(
      v.array(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
      v.minLength(1),
      v.maxLength(5),
    ),
  ),
});
export const FACT_MAX = 200;
const FACTS_MAX = 8;

/** A note's readable facts: a known kind, some text, once each, at most `FACTS_MAX`. */
export function factsOf(said: unknown): NonNullable<PromptCastMember["facts"]> {
  if (!Array.isArray(said)) return [];
  const out = new Map<string, { kind: FactKind; text: string; sourceIds?: number[] }>();
  for (const item of said) {
    const read = v.safeParse(Fact, item);
    if (!read.success) continue;
    const kind = listed(FACT_KINDS, read.output.kind);
    const text = oneLine(read.output.text).slice(0, FACT_MAX);
    const key = `${kind}\n${text.toLowerCase()}`;
    if (kind && text && !out.has(key))
      out.set(key, {
        kind,
        text,
        ...(read.output.sourceIds ? { sourceIds: read.output.sourceIds } : {}),
      });
  }
  return [...out.values()].slice(0, FACTS_MAX);
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
    const voiceType = voiceTypeOf(read.output.voiceType);
    const facts = factsOf(read.output.facts);
    out.push({
      name,
      gender: genderOf(read.output.gender),
      ...(age ? { age } : {}),
      ...(voiceType ? { voiceType } : {}),
      aliases,
      ...(facts.length ? { facts } : {}),
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
export class ChunkMisfit extends BadAnswer {
  /** set when only a few lines part from the book, so asking for those back is enough */
  repair?: ScriptRepair;
}

/**
 * The script in a model's final message, checked against the prose sent (`lenient` skips only the
 * word check), and mended where it can be (`mendScript`). With `repair`, the message holds only
 * the lines asked back. Throws a `ProviderError` with `status`.
 */
export function checkedScript(
  who: string,
  content: string,
  text: string,
  status: number,
  lenient: boolean,
  repair?: ScriptRepair,
): ScriptAnswer {
  if (!content.trim()) throw new BadAnswer(`${who} answered with no script at all`, status, false);
  // the excerpt picks the marker, as it did for the prompt
  const answer = repair ? repaired(who, content, text, repair) : answerOf(content, who, text);
  const { lines } = answer;
  if (!lines.length)
    throw new BadAnswer(`${who} answered with a script of no lines`, status, false);
  const check = fidelity(text, lines);
  if (!check.ok && !lenient) {
    const mended = mendScript(text, lines);
    if (mended)
      return {
        ...answer,
        lines: mended.lines,
        ...(mended.moved
          ? { reordered: { modelOrder: mended.modelOrder, moved: mended.moved } }
          : {}),
        ...(mended.patched ? { patched: mended.patched } : {}),
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
    const misfit = new ChunkMisfit(
      `${who} did not copy the text faithfully: it ${parts.join(" and ")}${example}. The script was not written; run it again or try another model`,
      status,
      false,
    );
    // one repair per answer: a repaired one that still fails is asked again whole
    if (!repair) misfit.repair = repairFor(text, content, answer) ?? undefined;
    throw misfit;
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

/** An `ask` as a prompt: the schema rides in the system message for providers that cannot take it. */
export const askPrompt = ({ system, user, schema }: AskInput): RenderedPrompt => ({
  system: `${system}\n\nAnswer with one JSON object only, matching this JSON schema:\n${JSON.stringify(schema)}`,
  user,
});

/** An `ask` answer's JSON; a reply with none is refused like a malformed script. */
export function askedJson(who: string, content: string, status: number): unknown {
  try {
    return jsonIn(content);
  } catch {
    const said = oneLine(content);
    throw new BadAnswer(
      `${who} did not answer with JSON: “${said.length > 80 ? said.slice(0, 80) + "…" : said}”`,
      status,
      false,
    );
  }
}

/** Refuses a run with no profile, or a keyed profile with no key, before any request. */
export function chatScriptingProvider(options: ChatScriptingOptions = {}): ScriptingProvider {
  /** One completion, retried and reported; `read` turns the final message into the answer. */
  async function request<T>(
    target: ScriptTarget,
    prompt: RenderedPrompt,
    signal: AbortSignal,
    sent: ((request: SentScript) => void) | undefined,
    read: (content: string, status: number) => T,
    chunked: boolean,
  ): Promise<{ answer: T; reasoningTokens: number | null }> {
    requireKey(target);
    const reasoning = reasoningRequest(target.baseUrl, target.reasoning);
    const body = {
      model: target.model,
      messages: [
        { role: "system", content: prompt.system },
        {
          role: "user",
          content: prompt.followUp
            ? [
                { type: "text", text: prompt.user },
                { type: "text", text: prompt.followUp },
              ]
            : prompt.user,
        },
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
      const answer = read(contentOf(target, res.status, raw, chunked), res.status);
      report(usage);
      return { answer, reasoningTokens };
    } catch (e) {
      // keep what a refused answer said, for the Activity tab
      if (e instanceof ProviderError) report(usage, e, said(raw));
      throw e;
    }
  }

  function contentOf(target: ScriptTarget, status: number, raw: unknown, chunked: boolean): string {
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
      throw new (chunked ? ChunkMisfit : BadAnswer)(
        `${target.name}’s answer was cut off at max output tokens (${cap}); ${remedy}${chunked ? " or use smaller chunks" : ""}`,
        status,
        false,
      );
    }
    return choice.message?.content ?? "";
  }

  const scriptRequest = (
    target: ScriptTarget,
    prompt: RenderedPrompt,
    text: string,
    signal: AbortSignal,
    sent?: (request: SentScript) => void,
    lenient = false,
    repair?: ScriptRepair,
  ) =>
    request(
      target,
      prompt,
      signal,
      sent,
      (content, status) => checkedScript(target.name, content, text, status, lenient, repair),
      true,
    );

  return {
    name: "Chat completions",
    callsProfile: true,
    async ask(input) {
      const { target, signal, sent } = input;
      if (!target) throw new ProviderError(NO_PROFILE, 0, false);
      const { answer } = await request(
        target,
        askPrompt(input),
        signal,
        sent,
        (content, status) => askedJson(target.name, content, status),
        false,
      );
      return answer;
    },
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
      repair,
    }: ScriptInput) {
      if (!target) throw new ProviderError(NO_PROFILE, 0, false);
      progress?.(0, 1);
      const { answer } = await scriptRequest(
        target,
        prompt ?? builtInPrompt(title, cast, text),
        text,
        signal,
        sent,
        lenient,
        repair,
      );
      progress?.(1, 1);
      return answer;
    },
    probe: (target, signal, given) =>
      probeWith(target, signal, given, (prompt, text) =>
        scriptRequest(target, prompt, text, signal),
      ),
  };
}
