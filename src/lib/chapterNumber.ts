// A chapter's reading number: its place among kept chapters, the one a person sees. `Chapter.id`
// counts cover and contents pages too, and stays the key everything is filed under.
import type { Chapter } from "@/types";

/** From 1, by chapter id. A skipped chapter has none. */
export function chapterNumbers(chapters: readonly Pick<Chapter, "id" | "excluded">[]) {
  const numbers = new Map<number, number>();
  for (const c of [...chapters].sort((a, b) => a.id - b.id)) {
    if (!c.excluded) numbers.set(c.id, numbers.size + 1);
  }
  return numbers;
}

/** "ch 2" or "skipped" */
export const chapterRef = (number: number | undefined) =>
  number == null ? "skipped" : `ch ${number}`;

/** "chapter 2", or "this chapter" for a skipped one. */
export const chapterName = (number: number | undefined) =>
  number == null ? "this chapter" : `chapter ${number}`;

/** Zero-padded so titles line up; a dash for a skipped chapter. */
export const numberCell = (n: number | undefined, width = 2): string =>
  n == null ? "–" : String(n).padStart(width, "0");

/** By a piece of the title, or the reading number typed whole ("4" or "04"); never by id. */
export function findsChapter(title: string, n: number | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return (
    title.toLowerCase().includes(needle) ||
    (n != null && /^\d+$/.test(needle) && Number(needle) === n)
  );
}

/** "ch 3–17". Null when none is kept, or numbers are not loaded yet. */
export function numberSpan(
  ids: Iterable<number>,
  numbers: ReadonlyMap<number, number> | undefined,
): string | null {
  let from = Infinity;
  let to = -Infinity;
  for (const id of ids) {
    const n = numbers?.get(id);
    if (n == null) continue;
    from = Math.min(from, n);
    to = Math.max(to, n);
  }
  return from > to ? null : from === to ? `ch ${from}` : `ch ${from}–${to}`;
}
