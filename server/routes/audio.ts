// Rendered clips over HTTP: the file a clip's `url` names, and nothing else.
//
// The route trusts `AudioFiles.path` to decide what a request may read, and answers a request it
// refuses with the same 404 a missing file gets — a caller learns that there is no such clip, not
// which of the two reasons applies. A token is never reused, so what is served under a url never
// changes and the browser is told it may keep it. A clip is served as the format its extension
// says it is in — WAV, MP3, or Opus in Ogg, which is what an audio element plays it as.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import { AUDIO_MIME } from "@/lib/endpointShapes";
import { formatOfFile, type AudioFiles } from "~/audio/files";
import { notFound } from "~/lib/errors";
import { fileResponse } from "~/lib/serve";
import { validate } from "~/lib/validate";

const FileParam = v.object({ bookId: v.string(), file: v.string() });

export function audioRoutes(files: AudioFiles): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();

  app.get("/:bookId/:file", validate("param", FileParam), async (c) => {
    const { bookId, file } = c.req.valid("param");
    const path = files.path(bookId, file);
    const format = formatOfFile(file);
    const found = path && format ? Bun.file(path) : null;
    if (!found || !format || !(await found.exists())) throw notFound("No such audio file");
    // A part at a time when the player asks for one, which is how it seeks; see `fileResponse`.
    return fileResponse(c.req.raw, found, {
      "content-type": AUDIO_MIME[format],
      "cache-control": "private, max-age=31536000, immutable",
    });
  });

  return app;
}
