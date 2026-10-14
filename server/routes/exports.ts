// A book's audiobooks over HTTP: building one, what has been built, downloading it, forgetting it.
import { create as disposition } from "content-disposition";
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { BuildQueued } from "@/types";
import type { CoverFiles } from "~/covers/files";
import type { Db } from "~/db/client";
import * as ops from "~/exports/ops";
import { enqueueBuild } from "~/jobs/export";
import type { Runner } from "~/jobs/runner";
import { serveFile } from "~/lib/serve";
import { BookParam, IdParam, IntParam } from "~/lib/http";
import { ExportSettingsSchema } from "~/lib/schemas";
import { validate } from "~/lib/validate";
import type { ExportPorts } from "~/providers/encoder";

/** Read off the name, not the encoder: the server may have restarted with another one since. */
const MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4b: "audio/mp4",
  m4a: "audio/mp4",
};

const ExportParam = v.object({ id: v.string(), exportId: IdParam });
const FileParam = v.object({ id: v.string(), exportId: IdParam, position: IntParam });

/** What to build, as what, and which finished version it follows. */
const Build = v.object({
  ids: v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1))), v.minLength(1)),
  settings: ExportSettingsSchema,
  updates: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))), null),
});

export function exportRoutes(
  db: Db,
  runner: Runner,
  ports: ExportPorts,
  covers: CoverFiles,
): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/:id/exports", validate("param", BookParam), (c) =>
    c.json({ exports: ops.bookExports(db, c.req.valid("param").id) }),
  );

  /**
   * Answers the job and its version (`building` at once). Refuses rather than trims, unlike
   * narration: a chapter quietly left out of an audiobook is the failure this page exists to avoid.
   */
  app.post("/:id/exports", validate("param", BookParam), validate("json", Build), (c) => {
    const { ids, settings, updates } = c.req.valid("json");
    const result = enqueueBuild(db, runner, ports, covers, c.req.valid("param").id, {
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
      },
      "build queued",
    );
    return c.json(result satisfies BuildQueued, 202);
  });

  app.get("/:id/exports/:exportId", validate("param", ExportParam), (c) => {
    const { id, exportId } = c.req.valid("param");
    return c.json({ export: ops.bookExport(db, id, exportId) });
  });

  /** By position in the set, since two versions share a name; the name goes back on the way out. */
  app.get("/:id/exports/:exportId/files/:position", validate("param", FileParam), async (c) => {
    const { id, exportId, position } = c.req.valid("param");
    const { path, name } = ops.exportFile(db, id, exportId, position, ports.files);
    // Range requests are how the player seeks; see `fileResponse`.
    const type = MIME[name.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream";
    return serveFile(c, path, type, {
      missing: "That file is no longer on this server",
      immutable: false,
      headers: {
        // Only the last path part: a download has no folder. A header is Latin-1, so a title
        // with an em dash would make `Headers` throw; the name goes in UTF-8 `filename*`, with
        // an ASCII stand-in for older browsers.
        "content-disposition": disposition(name.split("/").at(-1)!),
      },
    });
  });

  app.delete("/:id/exports/:exportId", validate("param", ExportParam), (c) => {
    const { id, exportId } = c.req.valid("param");
    ops.removeExport(db, id, exportId, ports.files);
    return c.json({ removed: exportId });
  });

  return app;
}
