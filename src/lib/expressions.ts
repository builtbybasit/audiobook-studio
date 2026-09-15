import type {
  Endpoint,
  ExpressionAnnotation,
  ExpressionConfig,
  ExpressionTag,
  LexEntry,
  Segment,
} from "@/types";
import { speak } from "@/lib/speech";
import { splitText } from "@/lib/split";

export const expressionId = (label: string) =>
  label.trim().toLocaleLowerCase().replace(/\s+/g, " ");
export const validToken = (token: string) =>
  /^\[[^\]\r\n[]{1,80}\]$/.test(token) && !!token.slice(1, -1).trim();
export function expressionSupport(ep: Endpoint | null | undefined): ExpressionConfig["status"] {
  const c = ep?.expressions;
  return !ep || !c || c.model !== ep.model || c.baseUrl !== ep.baseUrl ? "unknown" : c.status;
}
export function configErrors(c: ExpressionConfig): string[] {
  if (
    !c ||
    !["unknown", "unsupported", "supported"].includes(c.status) ||
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
  const errors: string[] = [];
  if (!c.tags.length) errors.push("Add at least one supported expression.");
  if (c.tags.some((t) => !t.label.trim() || !t.id || !validToken(t.token)))
    errors.push("Each expression needs a name and one complete tag, such as [laughter].");
  if (
    new Set(c.tags.map((t) => expressionId(t.label))).size !== c.tags.length ||
    new Set(c.tags.map((t) => t.id)).size !== c.tags.length
  )
    errors.push("Expression names must be unique.");
  if (new Set(c.tags.map((t) => t.token)).size !== c.tags.length)
    errors.push("Use each tag syntax only once.");
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
  ranges: { from: number; to: number }[];
}

/** Annotated ranges alone become controls; existing bracketed prose is never interpreted. */
export function expressionPlan(
  s: Pick<Segment, "text" | "expressions">,
  ep: Endpoint | null | undefined,
  lexicon: LexEntry[] = [],
): ExpressionPlan {
  const spoken = speak(s.text, lexicon);
  const annotations = [...(s.expressions ?? [])].sort(
    (a, b) => a.at - b.at || a.annotationId - b.annotationId,
  );
  const issues: ExpressionIssue[] = [];
  const tags: string[] = [];
  const ranges: ExpressionPlan["ranges"] = [];
  const signature: unknown[] = [];
  let text = "";
  let last = 0;
  for (const a of annotations) {
    if (a.omitted) continue;
    const definition = ep?.expressions?.tags.find((t) => t.id === a.id && t.kind === a.kind);
    const status = expressionSupport(ep);
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
                : !definition || !validToken(definition.token)
                  ? "This expression is not in this model's supported list."
                  : "";
    if (!reason && spoken.hits.some((h) => a.at > h.from && a.at < h.to))
      reason = "Move outside this pronunciation replacement.";
    if (!reason && ep?.maxChars && definition!.token.length > ep.maxChars)
      reason = "This tag exceeds the endpoint's character limit.";
    signature.push([a.at, a.id, a.kind, definition?.token ?? a.token, reason]);
    if (reason) {
      issues.push({ annotationId: a.annotationId, label: a.label, reason });
      continue;
    }
    const at =
      a.at +
      spoken.hits
        .filter((h) => h.to <= a.at)
        .reduce((n, h) => n + h.say.length - (h.to - h.from), 0);
    text += spoken.text.slice(last, at);
    if (text.length && !/\s$/.test(text)) text += " ";
    const from = text.length;
    text += definition!.token;
    ranges.push({ from, to: text.length });
    if (at < spoken.text.length && !/^\s/.test(spoken.text.slice(at))) text += " ";
    last = at;
    tags.push(definition!.token);
  }
  text += spoken.text.slice(last);
  return {
    text,
    pronounced: spoken.text,
    hits: spoken.hits,
    tags,
    ranges,
    issues,
    signature: signature.length ? JSON.stringify(signature) : "",
  };
}

export function expressionParts(plan: ExpressionPlan, ep: Pick<Endpoint, "maxChars" | "splitAt">) {
  return splitText(plan.text, ep.maxChars, ep.splitAt, true, plan.ranges);
}

/** Positions the user can choose without typing offsets or splitting a word. */
export function expressionPositions(text: string) {
  return [
    { value: "0", label: "Before the line" },
    ...[...text.matchAll(/\S+/g)]
      .filter((m) => m.index > 0)
      .map((m) => ({
        value: String(m.index),
        label: `Before “${text.slice(m.index, m.index + 32).trim()}${text.length - m.index > 32 ? "…" : ""}”`,
      })),
    { value: String(text.length), label: "After the line" },
  ];
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
