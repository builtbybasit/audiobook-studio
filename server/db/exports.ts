// Every read and write the finished audiobooks make.
//
// Only reading and forgetting, so far: a build is a job, and this server has no handler for one
// yet. The rows exist and are proven against the seeded world, and the routes over them are what
// the Export page reads in backend mode — empty until there is something that writes them.
import { asc, eq } from "drizzle-orm";

import type { ExportItem } from "@/types";
import type { Db } from "~/db/client";
import { exportChapters, exportFiles, exportItems } from "~/db/schema";
import { toExportItem } from "~/db/rows";

function assemble(db: Db, rows: (typeof exportItems.$inferSelect)[]): ExportItem[] {
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

export function getExport(db: Db, id: number): ExportItem | undefined {
  const row = db.select().from(exportItems).where(eq(exportItems.id, id)).get();
  return row ? assemble(db, [row])[0] : undefined;
}

/** Forget a finished export. Its files and chapter rows cascade. */
export function deleteExport(db: Db, id: number): boolean {
  return (
    db.delete(exportItems).where(eq(exportItems.id, id)).returning({ id: exportItems.id }).all()
      .length > 0
  );
}
