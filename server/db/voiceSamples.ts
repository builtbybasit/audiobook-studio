// Every read and write of the recordings kept for a cloned voice.
//
// The rows are tied to a voice by value, not by a foreign key: a save of the endpoints replaces
// every voice row, so `reconcileClones` is what decides, after each save, which kept recordings
// still have a voice and which do not.
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

import type { KeptSample, KeptVoiceSamples } from "@/types";
import type { Db, Tx } from "~/db/client";
import type { EndpointConfig } from "~/db/endpoints";
import { clonedVoices, voiceSamples } from "~/db/schema";

/**
 * How long kept recordings wait before a save may remove them: a clone for the page to save its
 * voice, a removed voice for its Undo or its return, a forget for its Undo.
 */
export const GRACE_MS = 24 * 60 * 60 * 1000;

/** A voice whose recordings went, and the files its rows named, for the caller to remove. */
export interface DroppedSamples {
  endpointId: string;
  voiceId: string;
  files: string[];
}

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

/** A voice's recordings as every read sees them: not forgotten. */
const whereShown = (endpointId: string, voiceId: string) =>
  and(whereVoice(endpointId, voiceId), isNull(clonedVoices.forgottenAt));

/** The recordings kept for one voice, or undefined when there are none. */
export function readKept(
  db: Db | Tx,
  endpointId: string,
  voiceId: string,
): KeptVoiceSamples | undefined {
  const voice = db.select().from(clonedVoices).where(whereShown(endpointId, voiceId)).get();
  if (!voice) return undefined;
  return { ...keptOf(voice), samples: samplesOf(db, endpointId, voiceId) };
}

/** Every voice of one endpoint that has recordings kept. */
export function readKeptFor(db: Db | Tx, endpointId: string): KeptVoiceSamples[] {
  return db
    .select()
    .from(clonedVoices)
    .where(and(eq(clonedVoices.endpointId, endpointId), isNull(clonedVoices.forgottenAt)))
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

/** The recordings a voice's rows name, forgotten or not. */
export function samplesOf(db: Db | Tx, endpointId: string, voiceId: string): KeptSample[] {
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

/**
 * Forget the recordings kept for one voice: hidden from every read now, removed by a save after
 * the grace period, and back with `restoreSamples` until then. True when there were any.
 */
export function forgetSamples(tx: Tx, endpointId: string, voiceId: string, now: number): boolean {
  return (
    tx
      .update(clonedVoices)
      .set({ forgottenAt: now })
      .where(whereShown(endpointId, voiceId))
      .returning({ id: clonedVoices.voiceId })
      .all().length > 0
  );
}

/** Take back a forget whose recordings a save has not removed yet. True when there was one. */
export function restoreSamples(tx: Tx, endpointId: string, voiceId: string): boolean {
  return (
    tx
      .update(clonedVoices)
      .set({ forgottenAt: null })
      .where(and(whereVoice(endpointId, voiceId), isNotNull(clonedVoices.forgottenAt)))
      .returning({ id: clonedVoices.voiceId })
      .all().length > 0
  );
}

/**
 * Line the kept recordings up with a configuration just saved, in the same transaction. Answers
 * with the voices whose recordings went, and the files their rows named, for the caller to remove
 * from disk after the commit.
 *
 * - A voice the configuration holds is **attached**, and no longer missing.
 * - An attached voice the configuration no longer holds is **missing** from this save on. Removing
 *   a voice or an endpoint offers Undo and a settings import can bring a voice back, so it keeps
 *   its recordings — and gets them back if it returns — until a save after the grace period, when
 *   they go: consent was given for making that voice, not for keeping a person's recordings after
 *   it.
 * - An unattached voice is spared: the clone answered before the page saved the voice it made, and
 *   a save in that moment is not a removal. One that has waited past the grace period is a voice
 *   the page never kept, and it goes.
 * - A forgotten voice goes once its grace period has passed, whatever the configuration holds.
 */
export function reconcileClones(tx: Tx, config: EndpointConfig, now: number): DroppedSamples[] {
  const held = new Set(config.endpoints.flatMap((e) => e.voices.map((v) => `${e.id}\0${v.id}`)));
  const gone: DroppedSamples[] = [];
  const expired = (since: number | null): boolean => since != null && now - since > GRACE_MS;
  for (const v of tx.select().from(clonedVoices).all()) {
    const where = whereVoice(v.endpointId, v.voiceId);
    const isHeld = held.has(`${v.endpointId}\0${v.voiceId}`);
    const drop =
      expired(v.forgottenAt) ||
      (!isHeld && (v.attached ? expired(v.missingSince) : expired(v.madeAt)));
    if (drop) {
      const files = samplesOf(tx, v.endpointId, v.voiceId).map((s) => s.file);
      tx.delete(clonedVoices).where(where).run();
      gone.push({ endpointId: v.endpointId, voiceId: v.voiceId, files });
    } else if (isHeld && (!v.attached || v.missingSince != null))
      tx.update(clonedVoices).set({ attached: true, missingSince: null }).where(where).run();
    else if (!isHeld && v.attached && v.missingSince == null)
      tx.update(clonedVoices).set({ missingSince: now }).where(where).run();
  }
  return gone;
}
