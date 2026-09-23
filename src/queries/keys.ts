// The keys every query is filed under, in one place, so an invalidation can name what it means.
//
// Keys are arrays and an invalidation matches by prefix, so the layout is the point: everything a
// book owns sits under `["books", id]`, and everything a chapter's number addresses — its text,
// its script, its history — sits under the book with the resource *before* the chapter number.
// `["books", id, "script"]` therefore names every chapter's script of one book, which is what a
// rename that moved lines in every chapter has to invalidate, without touching the prose.
import type { TextFormat } from "@/services/library";

export const keys = {
  jobs: ["jobs"] as const,
  book: (bookId: string) => ["books", bookId] as const,
  chapterText: (bookId: string, chapterId: number, format: TextFormat) =>
    ["books", bookId, "text", chapterId, format] as const,
  /** every chapter's script of a book, or one chapter's */
  scripts: (bookId: string) => ["books", bookId, "script"] as const,
  chapterScript: (bookId: string, chapterId: number) =>
    ["books", bookId, "script", chapterId] as const,
  histories: (bookId: string) => ["books", bookId, "history"] as const,
  chapterHistory: (bookId: string, chapterId: number) =>
    ["books", bookId, "history", chapterId] as const,
  cast: (bookId: string) => ["books", bookId, "cast"] as const,
  exports: (bookId: string) => ["books", bookId, "exports"] as const,
  /** what a book has spent and holds, from the server's ledger */
  spend: (bookId: string) => ["books", bookId, "spend"] as const,
  /** every book's spending at once, for the pages that total the library */
  librarySpend: ["spend"] as const,
  /** every endpoint's settled requests, for the Endpoints page */
  endpointRequests: ["endpoints", "requests"] as const,
};
