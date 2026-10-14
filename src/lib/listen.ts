// Reading along: which word of a line is being said. A word is lit only when the transcriber timed
// it (`HeardLine.words`); a time is never guessed from the clip's length.
import type { HeardLine, Segment } from "@/types";

/** `[from, to, start, end]`: UTF-16 offsets into the line's text (`to` exclusive), seconds into its clip */
export type WordMark = [number, number, number, number];

/** `mark` is the word's index in the marks; null for the text between. */
export interface Piece {
  text: string;
  mark: number | null;
}

/** Null when there are none to trust, including when the text was edited since the check. */
export function marksFor(
  segment: Pick<Segment, "text">,
  heard: Pick<HeardLine, "text" | "words"> | undefined,
): WordMark[] | null {
  if (!heard?.words?.length || heard.text !== segment.text) return null;
  return heard.words;
}

/** The pieces joined are exactly the text; overlapping or overrunning marks are cut to fit. */
export function piecesOf(text: string, marks: readonly WordMark[]): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  marks.forEach(([from, to], i) => {
    const a = Math.min(Math.max(at, from), text.length);
    const b = Math.min(Math.max(a, to), text.length);
    if (a > at) out.push({ text: text.slice(at, a), mark: null });
    if (b > a) out.push({ text: text.slice(a, b), mark: i });
    at = Math.max(at, b);
  });
  if (at < text.length) out.push({ text: text.slice(at), mark: null });
  return out;
}

/** -1 between words. A binary search: it runs on every animation frame while a line plays. */
export function markAt(marks: readonly WordMark[], t: number): number {
  let lo = 0;
  let hi = marks.length - 1;
  let found = -1; // the last mark that starts at or before t
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid][2] <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 && t < marks[found][3] ? found : -1;
}
