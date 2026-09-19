// What the finished audiobooks do, as operations. Reading and forgetting only: a build is a job,
// and this server has no handler for one yet.
import type { ExportItem } from "@/types";
import type { Db } from "~/db/client";
import * as exports from "~/db/exports";
import { notFound } from "~/lib/errors";
import { requireBook } from "~/library/ops";

export function bookExports(db: Db, bookId: string): ExportItem[] {
  requireBook(db, bookId);
  return exports.listExports(db, bookId);
}

/** The export, which must belong to this book: a path that names another book's export is a 404. */
export function bookExport(db: Db, bookId: string, id: number): ExportItem {
  requireBook(db, bookId);
  const e = exports.getExport(db, id);
  if (!e || e.bookId !== bookId) throw notFound("No such export");
  return e;
}

export function removeExport(db: Db, bookId: string, id: number): void {
  bookExport(db, bookId, id);
  exports.deleteExport(db, id);
}
