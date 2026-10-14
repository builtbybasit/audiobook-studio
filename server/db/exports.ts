// Finished audiobooks. A build writes when queued, per file, and at the end with real sizes and
// times. Only that final write marks the previous version `replaced`, so a failed or cancelled
// build leaves the existing audiobook untouched.
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

/** Oldest first. */
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

/** File and chapter rows cascade; files on disk do not. */
export function deleteExport(db: Db | Tx, id: number): boolean {
  return (
    db.delete(exportItems).where(eq(exportItems.id, id)).returning({ id: exportItems.id }).all()
      .length > 0
  );
}

export function exportFileTokens(db: Db | Tx, id: number): string[] {
  return db
    .select({ path: exportFiles.path })
    .from(exportFiles)
    .where(eq(exportFiles.exportId, id))
    .all()
    .flatMap((r) => (r.path ? [r.path] : []));
}

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

/** Put up when queued; the job carries the id in its `exportRun` so a retry knows its row. */
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

export interface WrittenFile {
  position: number;
  token: string;
  duration: number;
  /** MB */
  size: number;
  chapters: { id: number; seconds: number }[];
}

/** Claimed before the first byte is written. */
export function setBuildFile(db: Db | Tx, id: number, position: number, token: string): void {
  db.update(exportFiles)
    .set({ path: token })
    .where(and(eq(exportFiles.exportId, id), eq(exportFiles.position, position)))
    .run();
}

/** For a build that failed or was interrupted. */
export function clearBuildFiles(db: Db | Tx, id: number): void {
  db.update(exportFiles).set({ path: null }).where(eq(exportFiles.exportId, id)).run();
}

/**
 * Records what was written. Chapter signatures are rewritten too: staleness is measured against
 * the audio actually built from, not the audio queued against.
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
