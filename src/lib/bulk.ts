// Bulk script corrections, decided per segment (pure). The Search page previews with `bulkOutcome`;
// the store applies through the single-edit actions. Label-free so the store can import it.
import { DIRECTIONS } from "@/lib/cast";
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
  // a flag is kept unless the batch replaces it, and the same kind and note changes nothing
  if (!a.replace) return { changes: false, skip: "already-flagged" };
  return s.flag.kind === a.flag && s.flag.note === a.note.trim()
    ? { changes: false, skip: "same-flag" }
    : { changes: true, skip: null };
}

/** Flagging does not change what would be sent, so it invalidates nothing. */
export function bulkInvalidates(a: BulkAction): boolean {
  return a.kind !== "flag";
}

/** What a bulk correction touches, without the clip, so a background render keeps a preview valid. */
export function scriptFingerprint(s: Segment | undefined): string {
  if (!s) return "gone";
  return JSON.stringify([s.speaker, dirOf(s), s.flag?.kind ?? "", s.flag?.note ?? ""]);
}
/** Plus the clip: undo leaves a line alone whose audio moved on since the batch. */
export function segmentFingerprint(s: Segment | undefined): string {
  if (!s) return "gone";
  return JSON.stringify([scriptFingerprint(s), s.audio.status]);
}

/** The book's directions, most-used first, then unused presets. */
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
