// Bulk script corrections: the part that can be decided from a segment alone.
// Nothing here mutates and nothing here reaches the store — the Search page previews a batch with
// `bulkOutcome` before anything is applied, and the store applies it through the same per-segment
// actions a single edit uses. Labels live where `FLAG_LABEL` lives; this file stays label-free so
// the store can import it.
import { DIRECTIONS } from "@/mock/data";
import type { BulkAction, BulkOutcome, Segment, SegmentMap } from "@/types";
import type { UiOption } from "@/ui/types";

const dirOf = (s: Segment): string => s.direction || "";

/** Would this action change this line, and if not, why not? */
export function bulkOutcome(s: Segment, a: BulkAction): BulkOutcome {
  if (a.kind === "speaker")
    return s.speaker === a.speaker
      ? { changes: false, skip: "same-speaker" }
      : { changes: true, skip: null };
  if (a.kind === "direction") {
    if (a.mode === "clear")
      return dirOf(s) ? { changes: true, skip: null } : { changes: false, skip: "no-direction" };
    return dirOf(s) === a.direction.trim()
      ? { changes: false, skip: "same-direction" }
      : { changes: true, skip: null };
  }
  if (!s.flag) return { changes: true, skip: null };
  // an existing flag is kept unless the batch explicitly replaces it, and replacing a flag with the
  // same kind and the same note changes nothing either
  if (!a.replace) return { changes: false, skip: "already-flagged" };
  return s.flag.kind === a.flag && s.flag.note === a.note.trim()
    ? { changes: false, skip: "same-flag" }
    : { changes: true, skip: null };
}

/** True when applying the action invalidates a clip that was already rendered from this line.
 *  Flagging says something about the audio; it does not change what would be sent. */
export function bulkInvalidates(a: BulkAction): boolean {
  return a.kind !== "flag";
}

/** Everything a bulk correction reads or writes on a line. An open preview watches this: an edit
 *  made elsewhere invalidates what it promised, while a clip finishing in the background does not. */
export function scriptFingerprint(s: Segment | undefined): string {
  if (!s) return "gone";
  return JSON.stringify([s.speaker, dirOf(s), s.flag?.kind ?? "", s.flag?.note ?? ""]);
}
/** The same, plus the clip: undo compares against this, so a line whose audio moved on since the
 *  batch — re-rendered, retaken, re-narrated — is left alone rather than rolled back. */
export function segmentFingerprint(s: Segment | undefined): string {
  if (!s) return "gone";
  return JSON.stringify([scriptFingerprint(s), s.audio.status]);
}

/** Directions offered by the pickers: the ones this book already uses, most-used first, then the
 *  presets it has not used yet. Free text is allowed on top of these. */
export function directionOptions(segments: SegmentMap, bookId: string): UiOption[] {
  const used = new Map<string, number>();
  for (const k of Object.keys(segments))
    if (k.startsWith(bookId + ":"))
      for (const x of segments[k])
        if (x.direction) used.set(x.direction, (used.get(x.direction) ?? 0) + 1);
  return [
    ...[...used.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([d, n]) => ({ value: d, label: d, group: "Used in this book", hint: n + "×" })),
    ...DIRECTIONS.filter((d) => !used.has(d)).map((d) => ({
      value: d,
      label: d,
      group: "Presets",
    })),
  ];
}
