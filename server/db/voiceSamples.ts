// Every read and write of the recordings kept for a cloned voice.
//
// The rows are tied to a voice by value, not by a foreign key: a save of the endpoints replaces
// every voice row, so `reconcileClones` is what decides, after each save, which kept recordings
// still have a voice and which do not.
import { and, asc, eq } from "drizzle-orm";

import type { KeptSample, KeptVoiceSamples } from "@/types";
import type { Db, Tx } from "~/db/client";
import type { EndpointConfig } from "~/db/endpoints";
import { clonedVoices, voiceSamples } from "~/db/schema";

/** How long a clone waits for the page to save its voice before a save without it drops it. */
export const UNATTACHED_GRACE_MS = 24 * 60 * 60 * 1000;

/** What to keep: the voice, the consent it was kept under, and the recordings already on disk. */
export interface KeepSamples {
  endpointId: string;
  voiceId: string;
  title: string;
  at: number;
  consentText: string;
  /** a voice already in a saved configuration, as when an older voice is given its recordings */
  attached: boolean;
  samples: KeptSample[];
}

const whereVoice = (endpointId: string, voiceId: string) =>
  and(eq(clonedVoices.endpointId, endpointId), eq(clonedVoices.voiceId, voiceId));

/** The recordings kept for one voice, or undefined when there are none. */
export function readKept(
  db: Db | Tx,
  endpointId: string,
  voiceId: string,
): KeptVoiceSamples | undefined {
  const voice = db.select().from(clonedVoices).where(whereVoice(endpointId, voiceId)).get();
  if (!voice) return undefined;
  return { ...keptOf(voice), samples: samplesOf(db, endpointId, voiceId) };
}

/** Every voice of one endpoint that has recordings kept. */
export function readKeptFor(db: Db | Tx, endpointId: string): KeptVoiceSamples[] {
  return db
    .select()
    .from(clonedVoices)
    .where(eq(clonedVoices.endpointId, endpointId))
    .orderBy(asc(clonedVoices.madeAt))
    .all()
    .map((v) => ({ ...keptOf(v), samples: samplesOf(db, endpointId, v.voiceId) }));
}

function keptOf(v: typeof clonedVoices.$inferSelect): Omit<KeptVoiceSamples, "samples"> {
  return {
    voiceId: v.voiceId,
    title: v.title,
    madeAt: v.madeAt,
    consentAt: v.consentAt,
    consentText: v.consentText,
  };
}

function samplesOf(db: Db | Tx, endpointId: string, voiceId: string): KeptSample[] {
  return db
    .select()
    .from(voiceSamples)
    .where(and(eq(voiceSamples.endpointId, endpointId), eq(voiceSamples.voiceId, voiceId)))
    .orderBy(asc(voiceSamples.position))
    .all()
    .map((s) => ({ file: s.file, name: s.name, format: s.format, bytes: s.bytes }));
}

/**
 * Keep these recordings for a voice, in place of any it had. Answers with the files the voice had
 * that it no longer names, for the caller to remove from disk once the rows are committed.
 */
export function keepSamples(tx: Tx, keep: KeepSamples): string[] {
  const before = samplesOf(tx, keep.endpointId, keep.voiceId).map((s) => s.file);
  tx.delete(clonedVoices).where(whereVoice(keep.endpointId, keep.voiceId)).run();
  tx.insert(clonedVoices)
    .values({
      endpointId: keep.endpointId,
      voiceId: keep.voiceId,
      title: keep.title,
      madeAt: keep.at,
      consentAt: keep.at,
      consentText: keep.consentText,
      attached: keep.attached,
    })
    .run();
  // the same bytes picked twice are one file, and one row
  const seen = new Set<string>();
  const unique = keep.samples.filter((s) => !seen.has(s.file) && seen.add(s.file));
  if (unique.length)
    tx.insert(voiceSamples)
      .values(
        unique.map((s, position) => ({
          endpointId: keep.endpointId,
          voiceId: keep.voiceId,
          ...s,
          position,
        })),
      )
      .run();
  return before.filter((f) => !seen.has(f));
}

/** Forget the recordings kept for one voice. True when there were any. */
export function forgetSamples(tx: Tx, endpointId: string, voiceId: string): boolean {
  return (
    tx
      .delete(clonedVoices)
      .where(whereVoice(endpointId, voiceId))
      .returning({ id: clonedVoices.voiceId })
      .all().length > 0
  );
}

/**
 * Line the kept recordings up with a configuration just saved, in the same transaction. Answers
 * with the voices whose recordings went, for the caller to remove from disk after the commit.
 *
 * - A voice the configuration holds is **attached**: from now on, a save without it removes it.
 * - An attached voice the configuration no longer holds was removed on the page, and its
 *   recordings go with it — consent was given for making that voice, not for keeping a person's
 *   recordings after it.
 * - An unattached voice is spared: the clone answered before the page saved the voice it made, and
 *   a save in that moment is not a removal. One that has waited longer than a day is a voice the
 *   page never kept, and it goes.
 */
export function reconcileClones(
  tx: Tx,
  config: EndpointConfig,
  now: number,
): { endpointId: string; voiceId: string }[] {
  const held = new Set(config.endpoints.flatMap((e) => e.voices.map((v) => `${e.id}\0${v.id}`)));
  const gone: { endpointId: string; voiceId: string }[] = [];
  for (const v of tx.select().from(clonedVoices).all()) {
    const key = { endpointId: v.endpointId, voiceId: v.voiceId };
    if (held.has(`${v.endpointId}\0${v.voiceId}`)) {
      if (!v.attached)
        tx.update(clonedVoices)
          .set({ attached: true })
          .where(whereVoice(v.endpointId, v.voiceId))
          .run();
    } else if (v.attached || now - v.madeAt > UNATTACHED_GRACE_MS) {
      tx.delete(clonedVoices).where(whereVoice(v.endpointId, v.voiceId)).run();
      gone.push(key);
    }
  }
  return gone;
}
