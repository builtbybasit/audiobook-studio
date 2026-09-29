// Writing a whole world into the schema, and reading it back out.
//
// This exists for one question — does the schema actually hold the domain — and the seeded world is
// the reference answer, because it is the same data every screen in the app is built against. The
// world's own parts are written by the demo library's seed (`server/demo/world.ts`), which writes
// the same world into the demo's database, so the round trip proves the writer the demo uses; what
// the world does not hold — a chapter's history, a ledger row — is written here.
import { and, asc, eq } from "drizzle-orm";

import type {
  Chapter,
  Character,
  ChapterHistory,
  ExportItem,
  Job,
  LexEntry,
  RequestRecord,
} from "@/types";
import type { Db } from "~/db/client";
import * as rows from "~/db/rows";

// the world's books, casts, exports and jobs, as the demo's seed writes them
export { writeBook, writeCast, writeExport, writeJob } from "~/demo/world";
// the dictionary, by the module the lexicon route writes through
export { replaceLexicon as writeLexicon } from "~/db/cast";
// A chapter's script is read and written by the server's own module; the round-trip test drives
// the same code the scripting job does rather than a copy of it.
export { readScript, writeScript } from "~/db/script";
// and the endpoints by the module the endpoints route writes through
export {
  readEndpoints,
  readProfiles,
  writeCredentials,
  writeEndpoint,
  writeProfile,
} from "~/db/endpoints";
import {
  chapters,
  characters,
  exportChapters,
  exportFiles,
  exportItems,
  jobEvents,
  jobs,
  lexiconEntries,
  requests,
  scriptHeads,
  scriptVersions,
} from "~/db/schema";

// ---------- writing ----------

export function writeHistory(
  db: Db,
  bookId: string,
  chapterId: number,
  history: ChapterHistory,
): void {
  db.insert(scriptHeads)
    .values(rows.scriptHeadValues(bookId, chapterId, history))
    .run();
  for (const v of history.versions)
    db.insert(scriptVersions)
      .values(rows.scriptVersionValues(bookId, chapterId, v))
      .run();
}

/**
 * Append one request to the ledger.
 *
 * The chapter is stored by its own id rather than by its number, so the lookup here is the same one
 * a repository would do: the caller knows which chapter number the work was for, and the row keeps
 * the identity that survives a renumbering.
 */
export function writeRequest(db: Db, r: RequestRecord): void {
  const uid =
    r.bookId && r.chapterId != null
      ? (db
          .select({ uid: chapters.uid })
          .from(chapters)
          .where(and(eq(chapters.bookId, r.bookId), eq(chapters.id, r.chapterId)))
          .get()?.uid ?? null)
      : null;
  db.insert(requests).values(rows.requestValues(r, uid)).run();
}

// ---------- reading ----------

export function readChapters(db: Db, bookId: string): Chapter[] {
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.id))
    .all()
    .map(rows.toChapter);
}

export function readCast(db: Db, bookId: string): Character[] {
  return db
    .select()
    .from(characters)
    .where(eq(characters.bookId, bookId))
    .orderBy(asc(characters.position))
    .all()
    .map(rows.toCharacter);
}

export function readLexicon(db: Db, bookId: string): LexEntry[] {
  return db
    .select()
    .from(lexiconEntries)
    .where(eq(lexiconEntries.bookId, bookId))
    .orderBy(asc(lexiconEntries.position))
    .all()
    .map(rows.toLexEntry);
}

export function readHistory(db: Db, bookId: string, chapterId: number): ChapterHistory | null {
  const head = db
    .select()
    .from(scriptHeads)
    .where(and(eq(scriptHeads.bookId, bookId), eq(scriptHeads.chapterId, chapterId)))
    .get();
  if (!head) return null;
  const versions = db
    .select()
    .from(scriptVersions)
    .where(and(eq(scriptVersions.bookId, bookId), eq(scriptVersions.chapterId, chapterId)))
    .all();
  return rows.toChapterHistory(head, versions);
}

export function readExport(db: Db, id: number): ExportItem | null {
  const row = db.select().from(exportItems).where(eq(exportItems.id, id)).get();
  if (!row) return null;
  return rows.toExportItem(
    row,
    db.select().from(exportFiles).where(eq(exportFiles.exportId, id)).all(),
    db.select().from(exportChapters).where(eq(exportChapters.exportId, id)).all(),
  );
}

export function readJob(db: Db, id: number): Job | null {
  const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!row) return null;
  return rows.toJob(row, db.select().from(jobEvents).where(eq(jobEvents.jobId, id)).all());
}

/** The ledger, with each row's chapter resolved to the number that chapter goes by now. */
export function readRequests(db: Db): RequestRecord[] {
  return db
    .select()
    .from(requests)
    .leftJoin(chapters, eq(requests.chapterUid, chapters.uid))
    .all()
    .map((r) => rows.toRequestRecord(r.requests, r.chapters?.id ?? null));
}
