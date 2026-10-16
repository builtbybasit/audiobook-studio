// Operations on finished audiobooks. Building one is a job: `server/jobs/export.ts`.
import type { ExportItem } from "@/types";
import type { Db } from "~/db/client";
import * as exports from "~/db/exports";
import type { AudiobookFiles } from "~/exports/files";
import { conflict, notFound } from "~/lib/errors";
import { requireBook } from "~/library/ops";
import { inBackground } from "~/lib/background";
import { withChanges } from "~/jobs/export";

/** As the page reads them: what moved since each was built, and where its files are. */
function listed(db: Db, bookId: string, items: ExportItem[], files: AudiobookFiles): ExportItem[] {
  return withChanges(db, bookId, items).map((e) => ({
    ...e,
    files: e.files.map((f, position) => {
      const token = exports.exportFileToken(db, e.id, position);
      const path = token ? files.path(bookId, token) : null;
      return path ? { ...f, path } : f;
    }),
  }));
}

export function bookExports(db: Db, bookId: string, files: AudiobookFiles): ExportItem[] {
  requireBook(db, bookId);
  return listed(db, bookId, exports.listExports(db, bookId), files);
}

/** Another book's export is a 404. */
export function bookExport(db: Db, bookId: string, id: number): ExportItem {
  requireBook(db, bookId);
  const e = exports.getExport(db, id);
  if (!e || e.bookId !== bookId) throw notFound("No such export");
  return e;
}

/** Refuses a build in progress (its job would write into a missing row); cancel it instead. */
export function removeExport(db: Db, bookId: string, id: number, files?: AudiobookFiles): void {
  const e = bookExport(db, bookId, id);
  if (e.status === "building")
    throw conflict(
      `${e.filename} is still being built`,
      "Cancel the build from the Queue; a cancelled build removes the version it was making.",
    );
  const tokens = exports.exportFileTokens(db, id);
  exports.deleteExport(db, id);
  inBackground(files?.remove(bookId, tokens), "could not remove an audiobook's files", {
    book: bookId,
    export: id,
  });
}

/** Addressed through its export row, so no request can reach a file this book did not produce. */
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
  // a superseded version stays on disk until forgotten, so it can still be downloaded
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
