// A book's finished audiobooks over HTTP: what has been built, and forgetting one.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import * as ops from "~/exports/ops";
import { IdParam } from "~/lib/http";
import { validate } from "~/lib/validate";

const BookParam = v.object({ id: v.string() });
const ExportParam = v.object({ id: v.string(), exportId: IdParam });

export function exportRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/:id/exports", validate("param", BookParam), (c) =>
    c.json({ exports: ops.bookExports(db, c.req.valid("param").id) }),
  );

  app.get("/:id/exports/:exportId", validate("param", ExportParam), (c) => {
    const { id, exportId } = c.req.valid("param");
    return c.json({ export: ops.bookExport(db, id, exportId) });
  });

  app.delete("/:id/exports/:exportId", validate("param", ExportParam), (c) => {
    const { id, exportId } = c.req.valid("param");
    ops.removeExport(db, id, exportId);
    return c.json({ removed: exportId });
  });

  return app;
}
