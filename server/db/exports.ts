// Every read and write the finished audiobooks make.
//
// A build writes here three times: once when it is queued, so the Audiobooks tab shows a version
// arriving rather than nothing at all; once per file as it lands; and once at the end, when the
// row stops being a promise and becomes what was written — the real running time, the real size
// on disk, and how long each chapter in it plays.
//
// The version this one supersedes is only marked `replaced` by that final write. A build that
// fails or is cancelled must leave the audiobook already on disk exactly as it was, and the
// simplest way to be sure of that is never to touch it until the replacement is finished.
import { and, asc, eq } from "drizzle-orm";

import type { ExportItem, ExportStatus } from "@/types";
import type { Db, Tx } from "~/db/client";
import { exportChapters, exportFiles, exportItems } from "~/db/schema";
import { exportChapterValues, exportFileValues, exportValues, toExportItem } from "~/db/rows";

function assemble(db: Db | Tx, rows: (typeof exportItems.$inferSelect)[]): ExportItem[] {
  return rows.map((row) =>
    toExportItem(
      row,
      db.select().from(exportFiles).where(eq(exportFiles.exportId, row.id)).all(),
      db.select().from(exportChapters).where(eq(exportChapters.exportId, row.id)).all(),
    ),
  );
}

/** Every export of a book, oldest first — the order a build lands in. */
export function listExports(db: Db, bookId: string): ExportItem[] {
  return assemble(
    db,
    db
      .select()
      .from(exportItems)
      .where(eq(exportItems.bookId, bookId))
      .orderBy(asc(exportItems.id))
      .all(),
  );
}

export function getExport(db: Db | Tx, id: number): ExportItem | undefined {
  const row = db.select().from(exportItems).where(eq(exportItems.id, id)).get();
  return row ? assemble(db, [row])[0] : undefined;
}

/** Forget a finished export. Its files and chapter rows cascade; its files on disk do not. */
export function deleteExport(db: Db | Tx, id: number): boolean {
  return (
    db.delete(exportItems).where(eq(exportItems.id, id)).returning({ id: exportItems.id }).all()
      .length > 0
  );
}

/** The tokens an export's files were written under, for taking them off the disk with the row. */
export function exportFileTokens(db: Db | Tx, id: number): string[] {
  return db
    .select({ path: exportFiles.path })
    .from(exportFiles)
    .where(eq(exportFiles.exportId, id))
    .all()
    .flatMap((r) => (r.path ? [r.path] : []));
}

/** The token one file of an export was written under, by its position in the set. */
export function exportFileToken(db: Db | Tx, id: number, position: number): string | null {
  return (
    db
      .select({ path: exportFiles.path })
      .from(exportFiles)
      .where(and(eq(exportFiles.exportId, id), eq(exportFiles.position, position)))
      .get()?.path ?? null
  );
}

// ---------- what a build writes ----------

/**
 * The row a queued build puts up straight away, before a byte is written.
 *
 * Its id is the database's, not the caller's: the export it names has to be addressable in the
 * same breath the job that builds it is, and the job carries the id in its `exportRun` so a
 * retry knows what it was making.
 */
export function insertBuild(tx: Tx, draft: Omit<ExportItem, "id">, createdAt: number): number {
  const { id: _assigned, ...values } = exportValues({ ...draft, id: 0 }, createdAt);
  const id = tx.insert(exportItems).values(values).returning({ id: exportItems.id }).get().id;
  const e: ExportItem = { ...draft, id };
  e.files.forEach((f, position) =>
    tx
      .insert(exportFiles)
      .values(exportFileValues(id, f, position))
      .run(),
  );
  const rows = exportChapterValues(e);
  if (rows.length) tx.insert(exportChapters).values(rows).run();
  return id;
}

export function setBuildProgress(db: Db | Tx, id: number, progress: number): void {
  db.update(exportItems)
    .set({ progress: Math.max(0, Math.min(100, progress)) })
    .where(eq(exportItems.id, id))
    .run();
}

/** What one output file turned out to be, once it has been written. */
export interface WrittenFile {
  position: number;
  token: string;
  duration: number;
  /** MB */
  size: number;
  chapters: { id: number; seconds: number }[];
}

/** The file one output is being written to, claimed before the first byte goes into it. */
export function setBuildFile(db: Db | Tx, id: number, position: number, token: string): void {
  db.update(exportFiles)
    .set({ path: token })
    .where(and(eq(exportFiles.exportId, id), eq(exportFiles.position, position)))
    .run();
}

/** Forget where an export's files were: what a build that failed or was interrupted leaves. */
export function clearBuildFiles(db: Db | Tx, id: number): void {
  db.update(exportFiles).set({ path: null }).where(eq(exportFiles.exportId, id)).run();
}

/**
 * The build is done: the row stops describing what was asked for and describes what is there.
 *
 * Each chapter's running time lands here too, and its signature is rewritten with it: what an
 * export is out of date against is the audio it was actually built from, which is not always the
 * audio the build was queued against.
 */
export function finishBuild(
  tx: Tx,
  id: number,
  written: readonly WrittenFile[],
  signatures: ReadonlyMap<number, string>,
): void {
  let duration = 0;
  let size = 0;
  for (const f of written) {
    duration += f.duration;
    size += f.size;
    tx.update(exportFiles)
      .set({ path: f.token, duration: f.duration, size: f.size })
      .where(and(eq(exportFiles.exportId, id), eq(exportFiles.position, f.position)))
      .run();
    for (const c of f.chapters)
      tx.update(exportChapters)
        .set({
          duration: c.seconds,
          ...(signatures.has(c.id) ? { signature: signatures.get(c.id)! } : {}),
        })
        .where(and(eq(exportChapters.exportId, id), eq(exportChapters.chapterId, c.id)))
        .run();
  }
  tx.update(exportItems)
    .set({
      status: "done",
      progress: 100,
      error: null,
      duration: Math.round(duration * 100) / 100,
      size: Math.round(size * 100) / 100,
    })
    .where(eq(exportItems.id, id))
    .run();
}

export function setBuildStatus(
  db: Db | Tx,
  id: number,
  status: ExportStatus,
  error?: string,
): void {
  db.update(exportItems)
    .set({ status, error: error ?? null })
    .where(eq(exportItems.id, id))
    .run();
}
