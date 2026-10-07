// A chapter's reading number: where it stands among the chapters the audiobook keeps. The library
// numbers every chapter of the file (`Chapter.id`), cover and contents pages included, so the
// book's "Chapter 2" can be id 4; the reading number leaves skipped chapters out and is the one a
// person sees. The id stays the key everything is filed under — URLs, jobs, histories, the server.
import type { Chapter } from "@/types";

/** Reading numbers by chapter id: the kept chapters in book order, from 1. A skipped one has none. */
export function chapterNumbers(chapters: readonly Pick<Chapter, "id" | "excluded">[]) {
  const numbers = new Map<number, number>();
  for (const c of [...chapters].sort((a, b) => a.id - b.id)) {
    if (!c.excluded) numbers.set(c.id, numbers.size + 1);
  }
  return numbers;
}

/** "ch 2", or "skipped" for a chapter the audiobook leaves out. */
export const chapterRef = (number: number | undefined) =>
  number == null ? "skipped" : `ch ${number}`;

/** "chapter 2", for a sentence; "this chapter" for a skipped one, which has no number to say. */
export const chapterName = (number: number | undefined) =>
  number == null ? "this chapter" : `chapter ${number}`;

/**
 * A reading number as a list's number column shows it, zero-padded to `width` so the titles line
 * up, or a dash for a skipped chapter, which has no number.
 */
export const numberCell = (n: number | undefined, width = 2): string =>
  n == null ? "–" : String(n).padStart(width, "0");

/**
 * Does a search find this chapter: by a piece of its title, or by its reading number typed whole
 * ("4" or "04"). A skipped chapter has no number to be found by, and its id never counts.
 */
export function findsChapter(title: string, n: number | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return (
    title.toLowerCase().includes(needle) ||
    (n != null && /^\d+$/.test(needle) && Number(needle) === n)
  );
}

/**
 * "ch 3–17": the reading numbers a run of chapters spans, its skipped ones left out. Null when none
 * of them is kept, or the book's chapters are not read yet.
 */
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
