import { bulkOutcome } from "@/lib/bulk";
import type {
  BulkAction,
  BulkSkip,
  Chapter,
  FlagKind,
  Gender,
  Segment,
  SegmentFlag,
} from "@/types";
export const isScripted = (c: Chapter): boolean =>
  c.scripting === "done" || c.scripting === "fallback";
export const isNarrated = (c: Chapter): boolean =>
  c.narration === "done" || c.narration === "stale";
export const norm = (n: string): string =>
  n
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();

export const GENDER: Partial<Record<Gender, string>> = { m: "male", f: "female", n: "neutral" };
export const FLAG_LABEL: Record<FlagKind, string> = {
  pronunciation: "wrong pronunciation",
  delivery: "bad delivery",
  pause: "awkward pause",
  other: "something else",
};
/** One flag as a sentence: "bad delivery — flat, the line should land as a threat". */
export const flagText = (f: SegmentFlag): string =>
  FLAG_LABEL[f.kind] + (f.note ? ` \u2014 ${f.note}` : "");
/** The batch's one-line title, e.g. "Change speaker to Ji Ning". */
export function bulkLabel(a: BulkAction): string {
  if (a.kind === "speaker") return `Change speaker to ${a.speaker}`;
  if (a.kind === "direction")
    return a.mode === "clear"
      ? "Clear directions"
      : `Set direction \u201c${a.direction.trim()}\u201d`;
  return `Flag as ${FLAG_LABEL[a.flag]}${a.replace ? " (replacing existing flags)" : ""}`;
}
/** What the preview's before/after columns read for one line. */
export function beforeOf(s: Segment, a: BulkAction): string {
  if (a.kind === "speaker") return s.speaker;
  if (a.kind === "direction") return s.direction || "no direction";
  return s.flag ? flagText(s.flag) : "not flagged";
}
export function afterOf(s: Segment, a: BulkAction): string {
  if (!bulkOutcome(s, a).changes) return beforeOf(s, a); // a skipped line is left exactly as it is
  if (a.kind === "speaker") return a.speaker;
  if (a.kind === "direction") return a.mode === "clear" ? "no direction" : a.direction.trim();
  return flagText({ kind: a.flag, note: a.note.trim(), at: 0 });
}
/** Why one row is skipped, and what the skipped rows have in common. */
export const SKIP_TEXT: Record<BulkSkip, (s: Segment, a: BulkAction) => string> = {
  "same-speaker": (s) => `already ${s.speaker}`,
  "same-direction": (s) => `already \u201c${s.direction}\u201d`,
  "no-direction": () => "no direction to clear",
  "already-flagged": (s) => `keeping ${s.flag ? FLAG_LABEL[s.flag.kind] : "the existing flag"}`,
  "same-flag": () => "already flagged this way",
};
export const SKIP_SUMMARY: Record<BulkSkip, (a: BulkAction) => string> = {
  "same-speaker": (a) => `already use ${a.kind === "speaker" ? a.speaker : "this speaker"}`,
  "same-direction": (a) =>
    `already read \u201c${a.kind === "direction" ? a.direction.trim() : ""}\u201d`,
  "no-direction": () => "have no direction to clear",
  "already-flagged": () => "are already flagged \u2014 their flags are kept",
  "same-flag": () => "already carry this flag",
};
export const key = (b: string, c: number): string => `${b}:${c}`;
