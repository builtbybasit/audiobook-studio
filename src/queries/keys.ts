// Every query key, in one place. Invalidation matches by prefix: a book owns `["books", id]`, and
// chapter resources put the resource before the chapter number, so `["books", id, "script"]` names
// every chapter's script of a book without touching the prose.
import type { TextFormat } from "@/services/library";

export const keys = {
  jobs: ["jobs"] as const,
  /** every book the library lists, without their chapters */
  shelf: ["shelf"] as const,
  /** a book and its chapters; as a prefix, everything filed under the book */
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
  /** what was heard of every chapter's clips of a book, or one chapter's */
  heard: (bookId: string) => ["books", bookId, "heard"] as const,
  chapterHeard: (bookId: string, chapterId: number) =>
    ["books", bookId, "heard", chapterId] as const,
  cast: (bookId: string) => ["books", bookId, "cast"] as const,
  /** each speaker's spoken lines, chapters and first chapter */
  speakerCounts: (bookId: string) => ["books", bookId, "speakerCounts"] as const,
  /** for each of these names, the chapters whose text names it */
  mentions: (bookId: string, names: readonly string[]) =>
    ["books", bookId, "mentions", ...names] as const,
  exports: (bookId: string) => ["books", bookId, "exports"] as const,
  /** what a book has spent and holds, from the server's ledger */
  spend: (bookId: string) => ["books", bookId, "spend"] as const,
  /** every book's spending at once, for the pages that total the library */
  librarySpend: ["spend"] as const,
  /** every endpoint's settled requests, for the Endpoints page */
  endpointRequests: ["endpoints", "requests"] as const,
  /** each speech endpoint's lines out and held, and cooldowns */
  endpointLive: ["endpoints", "live"] as const,
  /** the local servers the app starts, by `serverKey` */
  localServers: ["endpoints", "servers"] as const,
  /** how alike every cloned voice sounds to the rest, library-wide */
  voiceLikeness: ["endpoints", "likeness"] as const,
  /** the library's voice effects and its thought effect, read together */
  effects: ["effects"] as const,
  /** how many of a book's clips have an old sound (`StaleSound`) */
  staleSound: (bookId: string) => ["books", bookId, "effects", "stale"] as const,
};
