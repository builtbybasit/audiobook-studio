// Speaker fingerprints of kept samples, and the samples a voice comparison covers.
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";

import type { Db } from "~/db/client";
import { clonedVoices, sampleFingerprints, voiceSamples } from "~/db/schema";

export interface ComparedSample {
  endpointId: string;
  voiceId: string;
  file: string;
}

/**
 * Samples of voices the saved config holds: a forgotten voice is hidden, and one missing from the
 * config is kept only for Undo, so neither is a voice the page can show.
 */
export function comparedSamples(db: Db): ComparedSample[] {
  return db
    .select({
      endpointId: voiceSamples.endpointId,
      voiceId: voiceSamples.voiceId,
      file: voiceSamples.file,
    })
    .from(voiceSamples)
    .innerJoin(
      clonedVoices,
      and(
        eq(clonedVoices.endpointId, voiceSamples.endpointId),
        eq(clonedVoices.voiceId, voiceSamples.voiceId),
      ),
    )
    .where(and(isNull(clonedVoices.forgottenAt), isNull(clonedVoices.missingSince)))
    .orderBy(asc(voiceSamples.endpointId), asc(voiceSamples.voiceId), asc(voiceSamples.position))
    .all();
}

/** Only `model`'s rows: another model's vectors don't compare with these. */
export function readFingerprints(db: Db, model: string): Map<string, Float32Array> {
  const rows = db
    .select({ file: sampleFingerprints.file, vector: sampleFingerprints.vector })
    .from(sampleFingerprints)
    .where(eq(sampleFingerprints.model, model))
    .all();
  // copied out: a Buffer's offset need not be 4-aligned
  return new Map(rows.map((r) => [r.file, new Float32Array(new Uint8Array(r.vector).buffer)]));
}

export function writeFingerprints(
  db: Db,
  model: string,
  made: ReadonlyMap<string, Float32Array>,
  now = Date.now(),
): void {
  if (!made.size) return;
  db.insert(sampleFingerprints)
    .values(
      [...made].map(([file, v]) => ({
        file,
        model,
        vector: Buffer.from(v.buffer, v.byteOffset, v.byteLength),
        madeAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: sampleFingerprints.file,
      set: { model, vector: sql`excluded.vector`, madeAt: now },
    })
    .run();
}

/** Rows for files no voice keeps any more; a forgotten voice's stay for its Undo. */
export function dropUnkept(db: Db): void {
  db.delete(sampleFingerprints)
    .where(
      notInArray(
        sampleFingerprints.file,
        db.select({ file: voiceSamples.file }).from(voiceSamples),
      ),
    )
    .run();
}
