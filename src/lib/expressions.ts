import type {
  Endpoint,
  ExpressionAnnotation,
  ExpressionConfig,
  ExpressionTag,
  LexEntry,
  Segment,
  TagBracket,
} from "@/types";
import { BRACKETS, tagSyntaxOf, type TagSyntax } from "@/lib/providers";
import type { ScriptedTag } from "@/lib/prompt";
import { sayable, speak } from "@/lib/speech";
import { splitText } from "@/lib/split";

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
/** A tag the scripting model wrote, as a line keeps it: its words, sent in whichever bracket the voice takes. */
export const scriptedAnnotation = (t: ScriptedTag, annotationId: number): ExpressionAnnotation => ({
  id: expressionId(t.label),
  label: t.label,
  token: "",
  kind: "sound",
  annotationId,
  at: t.at,
  scripted: true,
});
/**
 * What `a` is sent as to a model configured with `c`: the listed tag of its name, or on a model
 * taking any words what was typed — a scripted tag's words in the model's first bracket. A scripted
 * tag is matched by name alone, and takes the listed tag's kind. Empty when neither.
 */
export function tokenFor(
  a: ExpressionAnnotation,
  c: ExpressionConfig | undefined,
): { token: string; kind: ExpressionTag["kind"] } {
  const listed = c?.tags.find((t) => t.id === a.id && (a.scripted || t.kind === a.kind));
  if (listed) return { token: listed.token, kind: listed.kind };
  const typed = a.scripted ? tagToken(a.label, c?.brackets ?? []) : a.token;
  return { token: c?.open ? typed : "", kind: a.kind };
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
  tags: string[];
  signature: string;
  issues: ExpressionIssue[];
  /** scripted tags this voice cannot take, left out without holding the line, and why */
  skipped: ExpressionIssue[];
  ranges: { from: number; to: number }[];
}

/**
 * Annotated ranges alone become controls; existing bracketed prose is never interpreted, and only
 * what a voice can say of it is sent (`sayable`), so no voice can take it for a tag either.
 */
export function expressionPlan(
  s: Pick<Segment, "text" | "expressions">,
  ep: Endpoint | null | undefined,
  lexicon: LexEntry[] = [],
): ExpressionPlan {
  const spoken = speak(s.text, lexicon);
  // the prose the voice is given: what the dictionary made of it, kept to what can be said — before
  // the tags go in, whose brackets the whitelist would take out
  const voiced = sayable(spoken.text, tagBracketsOf(ep));
  const annotations = [...(s.expressions ?? [])].sort(
    (a, b) => a.at - b.at || a.annotationId - b.annotationId,
  );
  const issues: ExpressionIssue[] = [];
  const skipped: ExpressionIssue[] = [];
  const tags: string[] = [];
  const ranges: ExpressionPlan["ranges"] = [];
  const signature: unknown[] = [];
  let text = "";
  let last = 0;
  for (const a of annotations) {
    if (a.omitted) continue;
    const config = ep?.expressions;
    // a listed tag is sent as the list now spells it; on an open model, words typed on the line
    // are sent as they were typed
    const { token, kind } = tokenFor(a, config);
    const status = expressionSupport(ep);
    const syntax = ep ? tagSyntaxOf(ep) : null;
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
            : status === "unknown"
              ? "Expression support has not been confirmed for this model."
              : status === "unsupported"
                ? "This model is configured without expression support."
                : !token
                  ? "This expression is not in this model's supported list."
                  : !validToken(token, config!.brackets)
                    ? "This tag is not in the brackets this model takes."
                    : kindProblem(kind, syntax);
    if (!reason && spoken.hits.some((h) => a.at > h.from && a.at < h.to))
      reason = "Move outside this pronunciation replacement.";
    if (!reason && ep?.maxChars && token.length > ep.maxChars)
      reason = "This tag exceeds the endpoint's character limit.";
    signature.push([a.at, a.id, a.kind, token || a.token, reason]);
    if (reason) {
      (a.scripted ? skipped : issues).push({
        annotationId: a.annotationId,
        label: a.label,
        reason,
      });
      continue;
    }
    const at = voiced.at(
      a.at +
        spoken.hits
          .filter((h) => h.to <= a.at)
          .reduce((n, h) => n + h.say.length - (h.to - h.from), 0),
    );
    text += voiced.text.slice(last, at);
    if (text.length && !/\s$/.test(text)) text += " ";
    const from = text.length;
    text += token;
    ranges.push({ from, to: text.length });
    if (at < voiced.text.length && !/^\s/.test(voiced.text.slice(at))) text += " ";
    last = at;
    tags.push(token);
  }
  text += voiced.text.slice(last);
  return {
    text,
    pronounced: spoken.text,
    hits: spoken.hits,
    tags,
    ranges,
    issues,
    skipped,
    signature: signature.length ? JSON.stringify(signature) : "",
  };
}

export function expressionParts(plan: ExpressionPlan, ep: Pick<Endpoint, "maxChars" | "splitAt">) {
  return splitText(plan.text, ep.maxChars, ep.splitAt, true, plan.ranges);
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
