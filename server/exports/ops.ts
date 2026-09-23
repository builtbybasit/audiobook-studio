// What the finished audiobooks do, as operations: listing them, forgetting one, and handing one
// over to be downloaded. Building one is a job, and lives in `server/jobs/export.ts`.
import type { ExportItem } from "@/types";
import type { Db } from "~/db/client";
import * as exports from "~/db/exports";
import type { AudiobookFiles } from "~/exports/files";
import { conflict, notFound } from "~/lib/errors";
import { requireBook } from "~/library/ops";
import { inBackground } from "~/lib/background";

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

/**
 * Forget an export, and take its files off the disk with it.
 *
 * A build in progress is refused rather than deleted: the job would go on writing into a row that
 * is no longer there. Cancelling it from the Queue is what removes one of those, and that path
 * clears up after itself.
 */
export function removeExport(db: Db, bookId: string, id: number, files?: AudiobookFiles): void {
  const e = bookExport(db, bookId, id);
  if (e.status === "building")
    throw conflict(
      `${e.filename} is still being built`,
      "Cancel the build from the Queue; a cancelled build removes the version it was making.",
    );
  const tokens = exports.exportFileTokens(db, id);
  exports.deleteExport(db, id);
  // Nothing is waiting on the disk, and a response that did would be slower for no one's benefit.
  inBackground(files?.remove(bookId, tokens), "could not remove an audiobook's files", {
    book: bookId,
    export: id,
  });
}

/**
 * One file of a finished audiobook, as something to send.
 *
 * The file is addressed through the export that owns it rather than by its name on disk, so a
 * download is a claim about a book and a version that the row has to agree with — there is no
 * path a request can build to a file this book did not produce.
 */
export function exportFile(
  db: Db,
  bookId: string,
  id: number,
  position: number,
  files: AudiobookFiles,
): { path: string; name: string } {
  const e = bookExport(db, bookId, id);
  const file = e.files[position];
  if (!file) throw notFound("No such file in this audiobook");
  // A superseded version is still a finished audiobook and stays on disk until it is forgotten,
  // so it can still be saved; only one that was never written cannot.
  if (e.status !== "done" && e.status !== "replaced")
    throw conflict(
      `${e.filename} has not been built`,
      e.status === "building"
        ? "It is still being built. The Queue says how far it has got."
        : "This version was never finished, so there is nothing to download.",
    );
  const token = exports.exportFileToken(db, id, position);
  const path = token ? files.path(bookId, token) : null;
  if (!path) throw notFound("That file is no longer on this server");
  return { path, name: file.name };
}
