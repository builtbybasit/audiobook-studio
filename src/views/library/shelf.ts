// Narrowing and ordering the shelf. Pure over a book and the facts gathered about it, so the page
// and the tests agree on which books a filter keeps and which comes first.
import type { Book } from "@/types";
import type { BookFacts } from "@/views/library/bookFacts";

export type ShelfFilter = "all" | "attention" | "running" | "behind" | "done";
export const SHELF_FILTERS: { key: ShelfFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs attention" },
  { key: "running", label: "Running" },
  { key: "behind", label: "Behind" },
  { key: "done", label: "Up to date" },
];
export const asShelfFilter = (v: unknown): ShelfFilter =>
  SHELF_FILTERS.some((f) => f.key === v) ? (v as ShelfFilter) : "all";

/** Each key has the one direction that is useful: newest first, A to Z, most to do first. */
export type ShelfSort = "added" | "title" | "author" | "todo" | "scripted" | "narrated";
export const SHELF_SORTS: { key: ShelfSort; label: string }[] = [
  { key: "added", label: "Recently added" },
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "todo", label: "Most to do" },
  { key: "scripted", label: "Least scripted" },
  { key: "narrated", label: "Least narrated" },
];
export const asShelfSort = (v: unknown): ShelfSort =>
  SHELF_SORTS.some((s) => s.key === v) ? (v as ShelfSort) : "added";

export interface ShelfEntry {
  book: Book;
  facts: BookFacts;
}

const fold = (s: string): string => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/** Title or author contains every word of the query, accents ignored. */
export function matchesQuery(book: Book, q: string): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold(`${book.title} ${book.author}`);
  return words.every((w) => hay.includes(w));
}

/** Something failed, or the next step is a retry or a contents review. */
export const needsAttention = (f: BookFacts): boolean =>
  f.failedJobs > 0 || f.next.tone === "red" || f.next.tone === "zinc";

export function passesFilter(f: BookFacts, filter: ShelfFilter): boolean {
  switch (filter) {
    case "attention":
      return needsAttention(f);
    case "running":
      return f.running || f.building;
    case "behind":
      return f.behind;
    case "done":
      return f.next.tone === "emerald";
    default:
      return true;
  }
}

/**
 * How much is left to do on a book, so "most to do" puts the one that needs a hand first: broken
 * work outranks unstarted work, and a book with nothing to do sinks to the bottom.
 */
export function todoScore(f: BookFacts): number {
  const p = f.progress;
  if (!p.total) return 0;
  const unscripted = (p.total - p.scripted) / p.total;
  const unnarrated = (p.scripted - p.narrated) / p.total;
  let s = unscripted * 2 + unnarrated + (p.stale / p.total) * 1.5;
  if (needsAttention(f)) s += 3;
  else if (f.next.tone === "emerald") s = 0;
  else if (!f.latest) s += 0.5;
  else if (f.behind) s += 0.75;
  return s;
}

/** "just now" and other non-dates sort as the newest. */
const addedKey = (b: Book): string => (/^\d{4}-/.test(b.addedAt) ? b.addedAt : "9999");

export function sortEntries(entries: ShelfEntry[], sort: ShelfSort): ShelfEntry[] {
  const byTitle = (a: ShelfEntry, b: ShelfEntry) =>
    a.book.title.localeCompare(b.book.title, undefined, { sensitivity: "base" });
  const frac = (f: BookFacts, n: number) => (f.progress.total ? n / f.progress.total : 0);
  const cmp: Record<ShelfSort, (a: ShelfEntry, b: ShelfEntry) => number> = {
    added: (a, b) => addedKey(b.book).localeCompare(addedKey(a.book)) || byTitle(a, b),
    title: byTitle,
    author: (a, b) =>
      a.book.author.localeCompare(b.book.author, undefined, { sensitivity: "base" }) ||
      byTitle(a, b),
    todo: (a, b) => todoScore(b.facts) - todoScore(a.facts) || byTitle(a, b),
    scripted: (a, b) =>
      frac(a.facts, a.facts.progress.scripted) - frac(b.facts, b.facts.progress.scripted) ||
      byTitle(a, b),
    narrated: (a, b) =>
      frac(a.facts, a.facts.progress.narrated) - frac(b.facts, b.facts.progress.narrated) ||
      byTitle(a, b),
  };
  return [...entries].sort(cmp[sort]);
}

/** The shelf as the page shows it: narrowed by the query and the filter, then ordered. */
export function shelfView(
  entries: ShelfEntry[],
  { q = "", filter = "all" as ShelfFilter, sort = "added" as ShelfSort } = {},
): ShelfEntry[] {
  return sortEntries(
    entries.filter((e) => matchesQuery(e.book, q) && passesFilter(e.facts, filter)),
    sort,
  );
}

/** How many books each filter would keep, for the chips. */
export function filterCounts(entries: ShelfEntry[], q = ""): Record<ShelfFilter, number> {
  const out = { all: 0, attention: 0, running: 0, behind: 0, done: 0 };
  for (const e of entries) {
    if (!matchesQuery(e.book, q)) continue;
    for (const f of SHELF_FILTERS) if (passesFilter(e.facts, f.key)) out[f.key]++;
  }
  return out;
}
