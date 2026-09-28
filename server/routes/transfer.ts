// A book's script as a file: written out for someone to keep or send, and read back into another
// copy of the same book. See docs/script-transfer.md.
import { create as disposition } from "content-disposition";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import { env, importBodyBytes } from "~/env";
import { fail } from "~/lib/errors";
import { validate } from "~/lib/validate";
import type { Providers } from "~/providers/target";
import { planScriptImport } from "~/script/importPlan";
import { buildScriptExport } from "~/script/transfer";

const BookParam = v.object({ id: v.string() });
const ImportForm = v.object({ file: v.instance(File) });

export function transferRoutes(db: Db, providers: Providers): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  /** The whole book's script, as `<book>.script.zip`. Built on request: it is small, and never stale. */
  app.get("/:id/script-export", validate("param", BookParam), async (c) => {
    const { name, bytes } = await buildScriptExport(db, c.req.valid("param").id);
    return c.body(bytes, 200, {
      "content-type": "application/zip",
      // `filename*` for a title a Latin-1 header cannot hold; see the audiobook download
      "content-disposition": disposition(name),
      "cache-control": "no-store",
    });
  });

  /**
   * What importing a script file into this book would do — and nothing more. The plan is the
   * answer; applying it is the page's, through the paths a restore already writes by, so this
   * route never writes a line.
   *
   * Held to the EPUB's upload limit: a script without audio is text, and compresses like it.
   */
  app.post(
    "/:id/script-import",
    bodyLimit({
      maxSize: importBodyBytes(),
      onError: () =>
        fail(
          413,
          `That file is larger than the ${env.MAX_UPLOAD_MB} MB limit`,
          "Raise MAX_UPLOAD_MB if this is a script you expect to import.",
        ),
    }),
    validate("param", BookParam),
    validate("form", ImportForm),
    async (c) => {
      const { file } = c.req.valid("form");
      if (file.size > env.MAX_UPLOAD_MB * 1024 * 1024)
        fail(
          413,
          `That file is larger than the ${env.MAX_UPLOAD_MB} MB limit`,
          `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Raise MAX_UPLOAD_MB if this is a script you expect to import.`,
        );
      if (!file.size) fail(400, "That file is empty");
      c.var.logger.assign({ name: "script-import", file: file.name, bytes: file.size });
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The app's own lister, so a test's stands in for the network when a voice is looked up
      return c.json(
        await planScriptImport(
          db,
          c.req.valid("param").id,
          { name: file.name, bytes },
          { voices: providers.voices, signal: c.req.raw.signal },
        ),
      );
    },
  );

  return app;
}
