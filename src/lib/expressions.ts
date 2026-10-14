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
/** Whether `token` is one whole tag in one of `brackets`; with none, nothing is a tag. */
export const validToken = (token: string, brackets: readonly TagBracket[]) =>
  brackets.some((b) => BRACKETS[b].form.test(token));
/** Wrapped in the first of `brackets` unless typed in brackets. */
export function tagToken(typed: string, brackets: readonly TagBracket[]): string {
  const t = typed.trim();
  if (!t || !brackets.length || /^[([<]/.test(t)) return t;
  const { open, close } = BRACKETS[brackets[0]];
  return `${open}${t}${close}`;
}
/** `[laughing nervously]` → `laughing nervously`. */
export const tagWords = (token: string) => token.trim().slice(1, -1).trim();
export function typedTag(typed: string, brackets: readonly TagBracket[]): ExpressionTag {
  const token = tagToken(typed, brackets);
  const label = tagWords(token);
  return { id: expressionId(label), label, token, kind: "sound" };
}
/** As the scripting model (`[[long pause]]`) or a file writes a pause. */
export const PAUSE_WORDS: readonly PauseWord[] = ["pause", "long pause"];
const pauseWord = (words: string): PauseWord | undefined =>
  PAUSE_WORDS.find((w) => w === expressionId(words));
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
export const pauseSeconds = (a: Pick<ExpressionAnnotation, "id" | "seconds">, pacing: Pacing) =>
  a.seconds ?? (a.id === "long pause" ? pacing.inlineLong : pacing.inlineShort);
/** A scripted tag as a line keeps it; `pause` and `long pause` become pauses. */
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
 * The listed tag of `a`'s name (a scripted tag matches by name alone), else on an open model what
 * was typed. Empty when neither.
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
/** A line's text cut at its tags' places, for drawing chips. Ties keep their given order. */
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
export const chipText = (a: ExpressionAnnotation, pacing: Pacing): string =>
  a.kind === "pause" ? secs(pauseSeconds(a, pacing)) : a.label;
/** A chip's class beside `expression-chip`, and its hover title. */
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
/** `{{expressions}}`: tag names on confirmed Expressions tabs, each once. */
export const expressionNames = (endpoints: readonly Endpoint[]): string[] => [
  ...new Map(
    endpoints
      .filter((e) => expressionSupport(e) === "supported")
      .flatMap((e) => e.expressions!.tags)
      .map((t) => [t.id, t.label]),
  ).values(),
];
/** Where a model's Expressions tab starts, from its provider's docs. */
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
/** Confirmed on the Expressions tab, else the provider's docs': the model reads them either way. */
export const tagBracketsOf = (ep: Endpoint | null | undefined): readonly TagBracket[] =>
  !ep
    ? []
    : expressionSupport(ep) === "unknown"
      ? expressionDefaults(ep).brackets
      : ep.expressions!.brackets;
/** Missing brackets and `open` come from the provider's docs. */
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
/** Empty when a tag of `kind` can be sent. */
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
  /** scripted tags this voice cannot take: left out without holding the line */
  skipped: ExpressionIssue[];
  ranges: { from: number; to: number }[];
  /** pauses with no tag: the line is cut there with this much silence (`expressionParts`) */
  pauses: { at: number; seconds: number }[];
}

/**
 * Only annotations become tags; bracketed prose is never interpreted, and `sayable` strips what a
 * voice could take for one. A pause uses the provider's pause tag (`TagSyntax.pause`) if any, else
 * silence; it never waits for a tag to be set up.
 */
export function expressionPlan(
  s: Pick<Segment, "text" | "expressions">,
  ep: Endpoint | null | undefined,
  lexicon: LexEntry[] = [],
  pacing: Pacing = DEFAULT_PACING,
): ExpressionPlan {
  const spoken = speak(s.text, lexicon);
  // before the tags go in, whose brackets `sayable` would take out
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
    // the provider's pause tag where one fits here, else silence
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
 * Cut at each untagged pause (joined with that silence), then at `maxChars` (no tag cut). Leading
 * or trailing pauses become silence before or after; adjacent pauses merge.
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
