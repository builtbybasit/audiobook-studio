// Reading along: which word of a line is being said, from what a check by ear heard.
//
// A word is lit only when the transcriber put a time on it (`HeardLine.words`). Nothing here guesses
// a word's time from the clip's length: a line with no marks lights up whole, and a word the
// transcriber did not hear has no mark, so while it plays no word is lit and the line still is.
import type { HeardLine, Segment } from "@/types";

/** `[from, to, start, end]`: UTF-16 offsets into the line's text (`to` exclusive), seconds into its clip */
export type WordMark = [number, number, number, number];

/** A run of a line's text: a heard word (`mark` is its index in the marks) or the text between two. */
export interface Piece {
  text: string;
  mark: number | null;
}

/**
 * The line's word marks, or null when there are none to trust: never checked, checked by an
 * endpoint that gave no word times, or checked before the line's text was edited — its offsets
 * point into words the line no longer has.
 */
export function marksFor(
  segment: Pick<Segment, "text">,
  heard: Pick<HeardLine, "text" | "words"> | undefined,
): WordMark[] | null {
  if (!heard?.words?.length || heard.text !== segment.text) return null;
  return heard.words;
}

/**
 * The line's text cut at its marks, every character in exactly one piece and in order, so the
 * pieces joined are the text. A mark that overlaps the one before it, or runs past the end, is cut
 * to fit rather than allowed to repeat or invent text.
 */
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

/**
 * The mark being said `t` seconds into the clip, or -1 between words, before the first and after
 * the last. The marks are in the order they were said, so this is a binary search: it runs on
 * every animation frame while a line plays.
 */
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
