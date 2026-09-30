// A book's script as a file: written out for someone to keep or send, and read back into another
// copy of the same book. See docs/script-transfer.md.
import { create as disposition } from "content-disposition";
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { ScriptExportSamples, ScriptImportPlan } from "@/types";
import type { AudioFiles } from "~/audio/files";
import type { Db } from "~/db/client";
import { env } from "~/env";
import { fail } from "~/lib/errors";
import { BookParam, uploadLimit } from "~/lib/http";
import { validate } from "~/lib/validate";
import type { Providers } from "~/providers/target";
import { planScriptImport } from "~/script/importPlan";
import { buildScriptExport, exportSamples } from "~/script/transfer";
import type { VoiceFiles } from "~/voices/files";

/** `?samples=1` asks for the voice samples too; anything else, or nothing, leaves them out. */
const ExportQuery = v.object({ samples: v.optional(v.string()) });
const ImportForm = v.object({ file: v.instance(File) });

export function transferRoutes(
  db: Db,
  providers: Providers,
  audio: AudioFiles,
  voiceFiles?: VoiceFiles,
): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();
  const scriptLimit = uploadLimit(env.MAX_SCRIPT_UPLOAD_MB, "MAX_SCRIPT_UPLOAD_MB", "script");

  /** Whose voice recordings "Include voice samples" would hand over, and how much, before it is ticked. */
  app.get("/:id/script-export/samples", validate("param", BookParam), (c) =>
    c.json(exportSamples(db, c.req.valid("param").id, audio.dir) satisfies ScriptExportSamples),
  );

  /**
   * The whole book's script, as `<book>.script.zip`. Built on request: it is small, and never stale.
   * With `?samples=1` it carries the recordings of its speakers' cloned voices as well — asked for
   * each time, because they are recordings of a person.
   */
  app.get(
    "/:id/script-export",
    validate("param", BookParam),
    validate("query", ExportQuery),
    async (c) => {
      const withSamples = c.req.valid("query").samples === "1";
      const { name, bytes } = await buildScriptExport(db, c.req.valid("param").id, {
        samples: withSamples ? { voices: voiceFiles, audioDir: audio.dir } : undefined,
      });
      return c.body(bytes, 200, {
        "content-type": "application/zip",
        // `filename*` for a title a Latin-1 header cannot hold; see the audiobook download
        "content-disposition": disposition(name),
        "cache-control": "no-store",
      });
    },
  );

  /**
   * What importing a script file into this book would do — and nothing more. The plan is the
   * answer; applying it is the page's, through the paths a restore already writes by, so this
   * route never writes a line.
   *
   * Held to a limit of its own, `MAX_SCRIPT_UPLOAD_MB`: a script without audio is text and nowhere
   * near it, but one that carries voice samples is mostly recordings, which barely compress.
   */
  app.post(
    "/:id/script-import",
    scriptLimit.body,
    validate("param", BookParam),
    validate("form", ImportForm),
    async (c) => {
      const { file } = c.req.valid("form");
      scriptLimit.file(file);
      if (!file.size) fail(400, "That file is empty");
      c.var.logger.assign({ name: "script-import", file: file.name, bytes: file.size });
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The app's own lister, so a test's stands in for the network when a voice is looked up
      return c.json(
        (await planScriptImport(
          db,
          c.req.valid("param").id,
          { name: file.name, bytes },
          { voices: providers.voices, signal: c.req.raw.signal },
        )) satisfies ScriptImportPlan,
      );
    },
  );

  return app;
}
