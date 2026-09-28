// Voice samples waiting with a book's speakers, over HTTP: kept when an import is applied, listed,
// served, discarded and restored. See docs/script-transfer.md, slice 3, and `speakerSamples/store`.
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { AudioFiles } from "~/audio/files";
import type { Db } from "~/db/client";
import { env, scriptBodyBytes } from "~/env";
import { fail, notFound } from "~/lib/errors";
import { IdParam } from "~/lib/http";
import { fileResponse } from "~/lib/serve";
import { validate } from "~/lib/validate";
import { RECORDING_MIME } from "~/providers/clone";
import { speakerSampleFiles } from "~/speakerSamples/files";
import * as store from "~/speakerSamples/store";

const BookParam = v.object({ id: v.string() });
const SampleParam = v.object({ id: v.string(), sampleId: IdParam });
const FileParam = v.object({ ...SampleParam.entries, file: v.string() });
const StoreForm = v.object({
  file: v.instance(File),
  /** a JSON array of the speakers whose recordings to keep */
  speakers: v.string(),
});

const Speakers = v.array(v.pipe(v.string(), v.nonEmpty()));

export function speakerSampleRoutes(
  db: Db,
  audio: AudioFiles,
  options: store.SampleOptions = {},
): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();
  const files = speakerSampleFiles(audio.dir);

  app.get("/:id/speaker-samples", validate("param", BookParam), (c) =>
    c.json({ samples: store.listSamples(db, files, c.req.valid("param").id, options) }),
  );

  /**
   * Keep the recordings an applied import carried, for the speakers the page names. The same file
   * the plan was made from comes back, and is read and judged again here: the plan route wrote
   * nothing, and a request is not trusted to say what a file holds.
   */
  app.post(
    "/:id/speaker-samples",
    bodyLimit({
      maxSize: scriptBodyBytes(),
      onError: () =>
        fail(
          413,
          `That file is larger than the ${env.MAX_SCRIPT_UPLOAD_MB} MB limit`,
          "Raise MAX_SCRIPT_UPLOAD_MB if this is a script you expect to import.",
        ),
    }),
    validate("param", BookParam),
    validate("form", StoreForm),
    async (c) => {
      const { file, speakers } = c.req.valid("form");
      let names: string[];
      try {
        names = v.parse(Speakers, JSON.parse(speakers));
      } catch {
        fail(400, "`speakers` must be a JSON array of names");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stored = await store.storeSamples(
        db,
        files,
        c.req.valid("param").id,
        { name: file.name, bytes },
        names,
        options,
      );
      c.var.logger.info(
        {
          speakers: stored.map((s) => s.speaker),
          recordings: stored.flatMap((s) => s.samples).length,
        },
        "voice samples kept",
      );
      return c.json({ stored }, 201);
    },
  );

  app.get("/:id/speaker-samples/:sampleId/files/:file", validate("param", FileParam), async (c) => {
    const { id, sampleId, file } = c.req.valid("param");
    const { path, format } = store.sampleFile(db, files, id, sampleId, file);
    const found = Bun.file(path);
    if (!(await found.exists())) throw notFound("There is no recording by that name");
    return fileResponse(c.req.raw, found, {
      "content-type": RECORDING_MIME[format],
      // the name is the bytes' hash, so what it names can never change
      "cache-control": "private, max-age=31536000, immutable",
    });
  });

  /** Discard: hidden now, removed a day later unless the toast's Undo restores it first. */
  app.delete("/:id/speaker-samples/:sampleId", validate("param", SampleParam), (c) => {
    const { id, sampleId } = c.req.valid("param");
    return c.json(store.discardSamples(db, id, sampleId, options));
  });

  app.post("/:id/speaker-samples/:sampleId/restore", validate("param", SampleParam), (c) => {
    const { id, sampleId } = c.req.valid("param");
    return c.json({ sample: store.restoreSamples(db, id, sampleId) });
  });

  return app;
}
