// Rendered clips over HTTP. `AudioFiles.ready` decides what may be read; a refusal is the same 404
// as a missing file. A token is never reused, so a clip may be cached forever.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import { AUDIO_MIME } from "@/lib/endpointShapes";
import { formatOfFile, type AudioFiles } from "~/audio/files";
import { notFound } from "~/lib/errors";
import { serveFile } from "~/lib/serve";
import { validate } from "~/lib/validate";

const FileParam = v.object({ bookId: v.string(), file: v.string() });

export function audioRoutes(files: AudioFiles): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/:bookId/:file", validate("param", FileParam), async (c) => {
    const { bookId, file } = c.req.valid("param");
    const format = formatOfFile(file);
    if (!format) throw notFound("No such audio file");
    // `ready`, not `path`: an unplayed demo clip is made now. Range requests: see `fileResponse`.
    return serveFile(c, await files.ready(bookId, file), AUDIO_MIME[format], {
      missing: "No such audio file",
    });
  });

  return app;
}
