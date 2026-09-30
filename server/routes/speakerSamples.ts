// Voice samples waiting with a book's speakers, over HTTP: kept when an import is applied, listed,
// served, discarded and restored. See docs/script-transfer.md, slice 3, and `speakerSamples/store`.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { StoredSamples } from "@/types";
import type { AudioFiles } from "~/audio/files";
import type { Db } from "~/db/client";
import { env } from "~/env";
import { fail } from "~/lib/errors";
import { BookParam, IdParam, uploadLimit } from "~/lib/http";
import { serveFile } from "~/lib/serve";
import { validate } from "~/lib/validate";
import { SAMPLE_MIME } from "~/providers/clone";
import { speakerSampleFiles } from "~/speakerSamples/files";
import * as store from "~/speakerSamples/store";

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
  const scriptLimit = uploadLimit(env.MAX_SCRIPT_UPLOAD_MB, "MAX_SCRIPT_UPLOAD_MB", "script");
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
    scriptLimit.body,
    validate("param", BookParam),
    validate("form", StoreForm),
    async (c) => {
      const { file, speakers } = c.req.valid("form");
      scriptLimit.file(file);
      let names: string[];
      try {
        names = v.parse(Speakers, JSON.parse(speakers));
      } catch {
        fail(400, "`speakers` must be a JSON array of names");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { stored, replaced } = await store.storeSamples(
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
          replaced,
        },
        "voice samples kept",
      );
      // `replaced`: rows put aside for these speakers, which the import's Undo restores
      return c.json({ stored, replaced } satisfies StoredSamples, 201);
    },
  );

  // the name is the bytes' hash, so what it names can never change
  app.get("/:id/speaker-samples/:sampleId/files/:file", validate("param", FileParam), (c) => {
    const { id, sampleId, file } = c.req.valid("param");
    const { path, format } = store.sampleFile(db, files, id, sampleId, file);
    return serveFile(c, path, SAMPLE_MIME[format], {
      missing: "There is no recording by that name",
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
