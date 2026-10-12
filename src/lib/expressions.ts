import type {
  Endpoint,
  ExpressionAnnotation,
  ExpressionConfig,
  ExpressionTag,
  LexEntry,
  Pacing,
  PauseWord,
  ScriptedTag,
  Segment,
  TagBracket,
} from "@/types";
import { BRACKETS, tagSyntaxOf, type TagSyntax } from "@/lib/providers";
import { DEFAULT_PACING, sayable, secs, speak } from "@/lib/speech";
import { splitText, type SplitPart } from "@/lib/split";

export const expressionId = (label: string) =>
  label.trim().toLocaleLowerCase().replace(/\s+/g, " ");
/**
 * Whether `token` is one whole tag in one of `brackets`, the ones the Expressions tab is set to.
 * Nothing is a tag for a model set to none: a bracketed word sent to it would be read out as words.
 */
export const validToken = (token: string, brackets: readonly TagBracket[]) =>
  brackets.some((b) => BRACKETS[b].form.test(token));
/** A tag from what was typed for it: put in the first of `brackets` unless typed in brackets. */
export function tagToken(typed: string, brackets: readonly TagBracket[]): string {
  const t = typed.trim();
  if (!t || !brackets.length || /^[([<]/.test(t)) return t;
  const { open, close } = BRACKETS[brackets[0]];
  return `${open}${t}${close}`;
}
/** What a tag says, its name: `[laughing nervously]` → `laughing nervously`. */
export const tagWords = (token: string) => token.trim().slice(1, -1).trim();
/** A tag made from words typed for it, named by them. */
export function typedTag(typed: string, brackets: readonly TagBracket[]): ExpressionTag {
  const token = tagToken(typed, brackets);
  const label = tagWords(token);
  return { id: expressionId(label), label, token, kind: "sound" };
}
/** The words a pause is written with, by the scripting model (`[[long pause]]`) or in a file. */
export const PAUSE_WORDS: readonly PauseWord[] = ["pause", "long pause"];
const pauseWord = (words: string): PauseWord | undefined =>
  PAUSE_WORDS.find((w) => w === expressionId(words));
/** A pause at `at`: as long as the book makes `word`, or `seconds` of its own. */
export const pauseAnnotation = (
  word: PauseWord,
  at: number,
  annotationId: number,
  seconds?: number,
): ExpressionAnnotation => ({
  id: word,
  label: word,
  token: "",
  kind: "pause",
  annotationId,
  at,
  ...(seconds != null ? { seconds } : {}),
});
/** How long a pause is: its own length, or its word's in the book's `pacing`. */
export const pauseSeconds = (a: Pick<ExpressionAnnotation, "id" | "seconds">, pacing: Pacing) =>
  a.seconds ?? (a.id === "long pause" ? pacing.inlineLong : pacing.inlineShort);
/**
 * A tag the scripting model wrote, as a line keeps it: its words, sent in whichever bracket the
 * voice takes — or, written as `pause` or `long pause`, a pause of the book's length for it.
 */
export function scriptedAnnotation(t: ScriptedTag, annotationId: number): ExpressionAnnotation {
  const word = pauseWord(t.label);
  if (word) return { ...pauseAnnotation(word, t.at, annotationId), scripted: true };
  return {
    id: expressionId(t.label),
    label: t.label,
    token: "",
    kind: "sound",
    annotationId,
    at: t.at,
    scripted: true,
  };
}
/**
 * What `a` is sent as to a model configured with `c`: the listed tag of its name, or on a model
 * taking any words what was typed — a scripted tag's words in the model's first bracket. A scripted
 * tag is matched by name alone, and takes the listed tag's kind. Empty when neither.
 */
export function tokenFor(
  a: ExpressionAnnotation,
  c: ExpressionConfig | undefined,
): { token: string; kind: ExpressionAnnotation["kind"] } {
  const listed = c?.tags.find((t) => t.id === a.id && (a.scripted || t.kind === a.kind));
  if (listed) return { token: listed.token, kind: listed.kind };
  const typed = a.scripted ? tagToken(a.label, c?.brackets ?? []) : a.token;
  return { token: c?.open ? typed : "", kind: a.kind };
}
/**
 * A line's text cut at its tags' places, for drawing each tag as a chip among the words. Tags at one
 * place keep the order they are given in.
 */
export function piecesOf<T extends { at: number }>(
  text: string,
  tags: readonly T[],
): ({ text: string } | { tag: T })[] {
  const out: ({ text: string } | { tag: T })[] = [];
  let at = 0;
  for (const tag of [...tags].sort((a, b) => a.at - b.at)) {
    const pos = Math.max(at, Math.min(tag.at, text.length));
    if (pos > at) out.push({ text: text.slice(at, pos) });
    out.push({ tag });
    at = pos;
  }
  out.push({ text: text.slice(at) });
  return out;
}
/** What a chip among the words says: a tag's name, or a pause's length in the book's `pacing`. */
export const chipText = (a: ExpressionAnnotation, pacing: Pacing): string =>
  a.kind === "pause" ? secs(pauseSeconds(a, pacing)) : a.label;
/**
 * How a placed tag or pause is drawn among the words: its chip's class beside `expression-chip`,
 * and what hovering it says — omitted, asking for review (`issue`), left out for this voice
 * (`skipped`, a scripted tag's), or sent.
 */
export function chipLook(
  a: ExpressionAnnotation,
  issue?: string,
  skipped?: string,
  pacing: Pacing = DEFAULT_PACING,
): { class: string; title: string } {
  const name = a.kind === "pause" ? `${a.label}, ${chipText(a, pacing)}` : a.label;
  if (a.omitted)
    return { class: "expression-chip-omitted", title: `${name} — omitted from narration` };
  if (issue) return { class: "expression-chip-issue", title: issue };
  if (skipped) return { class: "expression-chip-skipped", title: `${name} — left out: ${skipped}` };
  return { class: "", title: a.token ? `${name} · ${a.token}` : name };
}
/**
 * The tag names the speech endpoints list on their confirmed Expressions tabs, each once: what
 * `{{expressions}}` tells a scripting model, so the words it writes are ones a voice has.
 */
export const expressionNames = (endpoints: readonly Endpoint[]): string[] => [
  ...new Map(
    endpoints
      .filter((e) => expressionSupport(e) === "supported")
      .flatMap((e) => e.expressions!.tags)
      .map((t) => [t.id, t.label]),
  ).values(),
];
/** Where a model's tab starts: the brackets its provider's docs show, and whether any words go in. */
export function expressionDefaults(e: Pick<Endpoint, "baseUrl" | "model">): ExpressionConfig {
  const syntax = tagSyntaxOf(e);
  return {
    status: "unknown",
    model: e.model,
    baseUrl: e.baseUrl,
    brackets: [...(syntax?.brackets ?? [])],
    open: syntax?.open ?? false,
    tags: [],
  };
}
/**
 * The brackets `ep`'s model reads as its own tags: those confirmed on its Expressions tab, or until
 * then those its provider's docs show — the model reads them either way.
 */
export const tagBracketsOf = (ep: Endpoint | null | undefined): readonly TagBracket[] =>
  !ep
    ? []
    : expressionSupport(ep) === "unknown"
      ? expressionDefaults(ep).brackets
      : ep.expressions!.brackets;
/** A config saved before brackets were asked for takes the ones its provider's docs show. */
export function withBrackets(
  c: Omit<ExpressionConfig, "brackets" | "open"> & Partial<ExpressionConfig>,
): ExpressionConfig {
  const d = expressionDefaults(c);
  return { ...c, brackets: c.brackets ?? d.brackets, open: c.open ?? d.open };
}
const KIND_WORDS: Record<ExpressionTag["kind"], string> = {
  sound: "vocal sounds",
  delivery: "delivery instructions",
};
/** Why a tag of `kind` cannot be sent to a model with `syntax`; empty when it can. */
const kindProblem = (kind: ExpressionTag["kind"], syntax: TagSyntax | null): string =>
  !syntax || syntax.kinds.includes(kind)
    ? ""
    : `This model takes only ${syntax.kinds.map((k) => KIND_WORDS[k]).join(" and ")} inline; give the rest as the line's direction.`;
export function expressionSupport(ep: Endpoint | null | undefined): ExpressionConfig["status"] {
  const c = ep?.expressions;
  return !ep || !c || c.model !== ep.model || c.baseUrl !== ep.baseUrl ? "unknown" : c.status;
}
export function configErrors(c: ExpressionConfig): string[] {
  if (
    !c ||
    !["unknown", "unsupported", "supported"].includes(c.status) ||
    !Array.isArray(c.brackets) ||
    c.brackets.some((b) => !Object.hasOwn(BRACKETS, b)) ||
    typeof c.open !== "boolean" ||
    !Array.isArray(c.tags) ||
    c.tags.some(
      (t) =>
        !t ||
        typeof t.label !== "string" ||
        typeof t.token !== "string" ||
        typeof t.id !== "string" ||
        !["sound", "delivery"].includes(t.kind),
    )
  )
    return ["Invalid expression configuration."];
  if (c.status !== "supported") return [];
  if (!c.brackets.length) return ["Choose the brackets this model's tags are written in."];
  // the kinds are the provider's, read from the base URL and model the config was saved for
  const syntax = tagSyntaxOf({ baseUrl: String(c.baseUrl ?? ""), model: String(c.model ?? "") });
  const example =
    syntax && validToken(syntax.example, c.brackets)
      ? syntax.example
      : tagToken("laughs", c.brackets);
  const errors: string[] = [];
  if (!c.open && !c.tags.length) errors.push("Add at least one tag, or let any words in.");
  if (c.tags.some((t) => !t.label.trim() || !t.id || !validToken(t.token, c.brackets)))
    errors.push(`Write each tag whole in the chosen brackets, such as ${example}.`);
  const wrongKind = c.tags.map((t) => kindProblem(t.kind, syntax)).find(Boolean);
  if (wrongKind) errors.push(wrongKind);
  if (
    new Set(c.tags.map((t) => expressionId(t.label))).size !== c.tags.length ||
    new Set(c.tags.map((t) => t.id)).size !== c.tags.length
  )
    errors.push("Expression names must be unique.");
  if (new Set(c.tags.map((t) => t.token)).size !== c.tags.length)
    errors.push("Use each tag only once.");
  return errors;
}

export interface ExpressionIssue {
  annotationId: number;
  label: string;
  reason: string;
}
export interface ExpressionPlan {
  text: string;
  pronounced: string;
  hits: ReturnType<typeof speak>["hits"];
  /** every tag written into `text`, a pause's included */
  tags: string[];
  signature: string;
  issues: ExpressionIssue[];
  /** scripted tags this voice cannot take, left out without holding the line, and why */
  skipped: ExpressionIssue[];
  ranges: { from: number; to: number }[];
  /**
   * The pauses the voice has no tag for, by where in `text` they fall: the line is spoken in parts
   * cut there, with this much silence between them (`expressionParts`).
   */
  pauses: { at: number; seconds: number }[];
}

/**
 * Annotated ranges alone become controls; existing bracketed prose is never interpreted, and only
 * what a voice can say of it is sent (`sayable`), so no voice can take it for a tag either.
 *
 * A pause is the voice's own pause tag where its provider's docs give one (`TagSyntax.pause`) and
 * the model has not been set to take no tags; otherwise it is silence, which `expressionParts`
 * cuts the line at. Either way it is sent: it needs no tag set up, so it never waits for one.
 */
export function expressionPlan(
  s: Pick<Segment, "text" | "expressions">,
  ep: Endpoint | null | undefined,
  lexicon: LexEntry[] = [],
  pacing: Pacing = DEFAULT_PACING,
): ExpressionPlan {
  const spoken = speak(s.text, lexicon);
  // the prose the voice is given: what the dictionary made of it, kept to what can be said — before
  // the tags go in, whose brackets the whitelist would take out
  const voiced = sayable(spoken.text, tagBracketsOf(ep));
  const annotations = [...(s.expressions ?? [])].sort(
    (a, b) => a.at - b.at || a.annotationId - b.annotationId,
  );
  const status = expressionSupport(ep);
  const syntax = ep ? tagSyntaxOf(ep) : null;
  const issues: ExpressionIssue[] = [];
  const skipped: ExpressionIssue[] = [];
  const tags: string[] = [];
  const ranges: ExpressionPlan["ranges"] = [];
  const pauses: ExpressionPlan["pauses"] = [];
  const signature: unknown[] = [];
  let text = "";
  let last = 0;
  for (const a of annotations) {
    if (a.omitted) continue;
    const config = ep?.expressions;
    const pause = a.kind === "pause";
    // a listed tag is sent as the list now spells it; on an open model, words typed on the line
    // are sent as they were typed
    const { token: tagToken, kind } = pause ? { token: "", kind: a.kind } : tokenFor(a, config);
    let reason = a.needsReview
      ? "Text changed here; choose the position again."
      : !Number.isInteger(a.at) || a.at < 0 || a.at > s.text.length
        ? "Position is outside this line."
        : a.at > 0 &&
            a.at < s.text.length &&
            /[\uD800-\uDBFF]/.test(s.text[a.at - 1]) &&
            /[\uDC00-\uDFFF]/.test(s.text[a.at])
          ? "Choose a position between complete characters."
          : !ep
            ? "Assign a voice to choose a TTS model."
            : pause
              ? ""
              : status === "unknown"
                ? "Expression support has not been confirmed for this model."
                : status === "unsupported"
                  ? "This model is configured without expression support."
                  : !tagToken
                    ? "This expression is not in this model's supported list."
                    : !validToken(tagToken, config!.brackets)
                      ? "This tag is not in the brackets this model takes."
                      : kindProblem(kind as ExpressionTag["kind"], syntax);
    // inside a dictionary entry, a hand-placed tag asks to be moved; one the scripting model wrote
    // goes before the entry, which is a word or a name said as one
    const inside = spoken.hits.find((h) => a.at > h.from && a.at < h.to);
    const place = inside && a.scripted ? inside.from : a.at;
    if (!reason && inside && !a.scripted) reason = "Move outside this pronunciation replacement.";
    const at = voiced.at(
      place +
        spoken.hits
          .filter((h) => h.to <= place)
          .reduce((n, h) => n + h.say.length - (h.to - h.from), 0),
    );
    const seconds = pause ? pauseSeconds(a, pacing) : 0;
    // a pause is the provider's tag for it, where there is one that fits here and the model was
    // not set to take no tags; otherwise silence, written into no text
    const edge = !voiced.text.slice(0, at).trim() || !voiced.text.slice(at).trim();
    const token = !pause
      ? tagToken
      : seconds > 0 && status !== "unsupported" && syntax?.pause && !(edge && syntax.pauseInside)
        ? (syntax.pause(seconds) ?? "")
        : "";
    if (!reason && ep?.maxChars && token.length > ep.maxChars)
      reason = "This tag exceeds the endpoint's character limit.";
    signature.push(
      pause
        ? [a.at, a.id, a.kind, token || `${seconds}s`, reason]
        : [a.at, a.id, a.kind, token || a.token, reason],
    );
    if (reason) {
      (a.scripted ? skipped : issues).push({
        annotationId: a.annotationId,
        label: a.label,
        reason,
      });
      continue;
    }
    text += voiced.text.slice(last, at);
    last = at;
    if (!token) {
      if (seconds > 0) pauses.push({ at: text.length, seconds });
      continue;
    }
    if (text.length && !/\s$/.test(text)) text += " ";
    const from = text.length;
    text += token;
    ranges.push({ from, to: text.length });
    if (at < voiced.text.length && !/^\s/.test(voiced.text.slice(at))) text += " ";
    tags.push(token);
  }
  text += voiced.text.slice(last);
  return {
    text,
    pronounced: spoken.text,
    hits: spoken.hits,
    tags,
    ranges,
    pauses,
    issues,
    skipped,
    signature: signature.length ? JSON.stringify(signature) : "",
  };
}

/**
 * Where a line's reading is cut for `ep`: at each pause the voice has no tag for, where the parts
 * are joined with that silence between them, and within each stretch at `maxChars` (`splitText`,
 * no tag cut). A pause with no words on one side of it is silence before the first part or after
 * the last, and pauses with no words between them are one silence.
 */
export function expressionParts(
  plan: ExpressionPlan,
  ep: Pick<Endpoint, "maxChars" | "splitAt">,
): SplitPart[] {
  const parts: SplitPart[] = [];
  let from = 0;
  let before = 0;
  const stretch = (to: number, after: number): void => {
    const piece = plan.text.slice(from, to);
    if (!piece.trim()) {
      if (parts.length) parts.at(-1)!.after = (parts.at(-1)!.after ?? 0) + after;
      else before += after;
    } else {
      const ranges = plan.ranges
        .filter((r) => r.from >= from && r.to <= to)
        .map((r) => ({ from: r.from - from, to: r.to - from }));
      const cut = splitText(piece, ep.maxChars, ep.splitAt, true, ranges).map((c) => ({
        ...c,
        from: c.from + from,
        to: c.to + from,
      }));
      if (before) cut[0].before = before;
      if (after) cut.at(-1)!.after = after;
      before = 0;
      parts.push(...cut);
    }
    from = to;
  };
  for (const p of plan.pauses) stretch(p.at, p.seconds);
  stretch(plan.text.length, 0);
  return parts.length ? parts : splitText(plan.text, ep.maxChars, ep.splitAt, true, plan.ranges);
}

/** Keep unaffected anchors; edited ranges require the user's position choice before rendering. */
export function remapExpressions(
  list: ExpressionAnnotation[],
  before: string,
  after: string,
): ExpressionAnnotation[] {
  if (before === after) return list;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.at(-1 - suffix) === after.at(-1 - suffix)
  )
    suffix++;
  return list.map((a) =>
    a.at < prefix
      ? a
      : a.at > before.length - suffix
        ? { ...a, at: a.at + after.length - before.length }
        : { ...a, at: Math.min(prefix, after.length), needsReview: true },
  );
}

export const annotationFrom = (
  tag: ExpressionTag,
  at: number,
  annotationId: number,
): ExpressionAnnotation => ({ ...tag, at, annotationId });
