// A book's script as a file: exported, and imported into another copy of the same book.
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

/** Only `?samples=1` asks for the voice samples too. */
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

  /** What "Include voice samples" would hand over, before it is ticked. */
  app.get("/:id/script-export/samples", validate("param", BookParam), (c) =>
    c.json(
      exportSamples(
        db,
        c.req.valid("param").id,
        audio.dir,
        voiceFiles,
      ) satisfies ScriptExportSamples,
    ),
  );

  /**
   * `<book>.script.zip`, built on request. Samples are asked for each time, because they are
   * recordings of a person.
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
   * The plan for importing a script file; never writes. Its own limit, `MAX_SCRIPT_UPLOAD_MB`,
   * because voice samples barely compress.
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
      // the app's own voice lister; a test passes its own
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
