// A book's audiobooks over HTTP: building one, what has been built, downloading it, forgetting it.
import { create as disposition } from "content-disposition";
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import * as ops from "~/exports/ops";
import { enqueueBuild } from "~/jobs/export";
import type { Runner } from "~/jobs/runner";
import { notFound } from "~/lib/errors";
import { fileResponse } from "~/lib/serve";
import { IdParam, IntParam } from "~/lib/http";
import { ExportSettingsSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";
import type { ExportPorts } from "~/providers/encoder";

/**
 * What a built file is served as, by what it turned out to be.
 *
 * Read off the name rather than asked of the encoder, because the encoder is chosen per build and
 * the server may have been restarted with a different one since this file was written.
 */
const MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4b: "audio/mp4",
  m4a: "audio/mp4",
};

const BookParam = v.object({ id: v.string() });
const ExportParam = v.object({ id: v.string(), exportId: IdParam });
const FileParam = v.object({ id: v.string(), exportId: IdParam, position: IntParam });

/** What to build, what to build it as, and which finished version it is the next one of. */
const Build = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
  settings: ExportSettingsSchema,
  updates: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))), null),
});

export function exportRoutes(db: Db, runner: Runner, ports: ExportPorts): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/:id/exports", validate("param", BookParam), (c) =>
    c.json({ exports: ops.bookExports(db, c.req.valid("param").id) }),
  );

  /**
   * Queue a build: the job, and the version it is making, which goes up as `building` at once so
   * the Audiobooks tab shows it arriving. Unlike a bulk narration run this refuses rather than
   * trims — a chapter quietly left out of an audiobook is the failure this page exists to avoid —
   * so the answer is either a build or the one reason it cannot happen.
   */
  app.post("/:id/exports", validate("param", BookParam), validate("json", Build), (c) => {
    const { ids, settings, updates } = c.req.valid("json");
    const result = enqueueBuild(db, runner, ports, c.req.valid("param").id, {
      ids,
      settings,
      updates,
    });
    c.var.logger.info(
      {
        export: result.export.id,
        version: result.export.version,
        files: result.export.files.length,
        chapters: ids.length,
        reused: result.export.reused ?? 0,
      },
      "build queued",
    );
    return c.json(result, 202);
  });

  app.get("/:id/exports/:exportId", validate("param", ExportParam), (c) => {
    const { id, exportId } = c.req.valid("param");
    return c.json({ export: ops.bookExport(db, id, exportId) });
  });

  /**
   * One file of a finished audiobook, to save.
   *
   * By position in the set rather than by name, because a name is the listener's and two versions
   * of an audiobook share one; the name is put back on the way out, in the header that decides
   * what the browser calls the download.
   */
  app.get("/:id/exports/:exportId/files/:position", validate("param", FileParam), async (c) => {
    const { id, exportId, position } = c.req.valid("param");
    const { path, name } = ops.exportFile(db, id, exportId, position, ports.files);
    const found = Bun.file(path);
    if (!(await found.exists())) throw notFound("That file is no longer on this server");
    // A part at a time when the player asks for one, which is how it seeks; see `fileResponse`.
    return fileResponse(c.req.raw, found, {
      "content-type": MIME[name.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream",
      // A set is written to a folder, so a file in one carries the folder in its name; a
      // download has nowhere to put that and the last part is what it should be called.
      //
      // A header is Latin-1, and a title is not: an em dash, a curly apostrophe or a Chinese
      // title would make `Headers` throw and the download a 500. The name goes in the
      // `filename*` a browser reads in UTF-8, with an ASCII stand-in for anything older.
      "content-disposition": disposition(name.split("/").at(-1)!),
      "cache-control": "private, max-age=0, must-revalidate",
    });
  });

  app.delete("/:id/exports/:exportId", validate("param", ExportParam), (c) => {
    const { id, exportId } = c.req.valid("param");
    ops.removeExport(db, id, exportId, ports.files);
    return c.json({ removed: exportId });
  });

  return app;
}
