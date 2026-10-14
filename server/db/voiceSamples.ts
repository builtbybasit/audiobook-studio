// Samples kept for cloned voices. Tied to a voice by value, not foreign key, since an endpoints
// save replaces every voice row; `reconcileClones` decides after each save which survive.
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

import type { KeptSample, KeptVoiceSamples } from "@/types";
import type { Db, Tx } from "~/db/client";
import type { EndpointConfig } from "~/db/endpoints";
import { clonedVoices, voiceSamples } from "~/db/schema";

/** How long kept samples wait before a save may remove them (room for the page's save or Undo). */
export const GRACE_MS = 24 * 60 * 60 * 1000;

export interface DroppedSamples {
  endpointId: string;
  voiceId: string;
  files: string[];
}

export interface KeepSamples {
  endpointId: string;
  voiceId: string;
  title: string;
  at: number;
  /** the voice is already in a saved configuration */
  attached: boolean;
  samples: KeptSample[];
}

const whereVoice = (endpointId: string, voiceId: string) =>
  and(eq(clonedVoices.endpointId, endpointId), eq(clonedVoices.voiceId, voiceId));

const whereShown = (endpointId: string, voiceId: string) =>
  and(whereVoice(endpointId, voiceId), isNull(clonedVoices.forgottenAt));

export function readKept(
  db: Db | Tx,
  endpointId: string,
  voiceId: string,
): KeptVoiceSamples | undefined {
  const voice = db.select().from(clonedVoices).where(whereShown(endpointId, voiceId)).get();
  if (!voice) return undefined;
  return { ...keptOf(voice), samples: samplesOf(db, endpointId, voiceId) };
}

/** What a script export carries: not forgotten, and the voice not missing from the config. */
export function readCarried(
  db: Db | Tx,
  endpointId: string,
  voiceId: string,
): KeptVoiceSamples | undefined {
  const voice = db
    .select()
    .from(clonedVoices)
    .where(and(whereShown(endpointId, voiceId), isNull(clonedVoices.missingSince)))
    .get();
  if (!voice) return undefined;
  return { ...keptOf(voice), samples: samplesOf(db, endpointId, voiceId) };
}

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
  };
}

export function samplesOf(db: Db | Tx, endpointId: string, voiceId: string): KeptSample[] {
  return db
    .select()
    .from(voiceSamples)
    .where(and(eq(voiceSamples.endpointId, endpointId), eq(voiceSamples.voiceId, voiceId)))
    .orderBy(asc(voiceSamples.position))
    .all()
    .map((s) => ({
      file: s.file,
      name: s.name,
      format: s.format,
      bytes: s.bytes,
      ...(s.transcript ? { transcript: s.transcript } : {}),
    }));
}

/** Replaces a voice's samples; returns the dropped files for the caller to delete after commit. */
export function keepSamples(tx: Tx, keep: KeepSamples): string[] {
  const before = samplesOf(tx, keep.endpointId, keep.voiceId).map((s) => s.file);
  tx.delete(clonedVoices).where(whereVoice(keep.endpointId, keep.voiceId)).run();
  tx.insert(clonedVoices)
    .values({
      endpointId: keep.endpointId,
      voiceId: keep.voiceId,
      title: keep.title,
      madeAt: keep.at,
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

/** Hidden now, removed by a save after `GRACE_MS`, and back with `restoreSamples` until then. */
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
 * Runs in the save's transaction; returns what went, for the caller to delete after commit.
 * - In the config: attached, not missing.
 * - Attached but gone from the config: missing; kept for Undo/import until `GRACE_MS` passes.
 * - Unattached (clone not yet saved by the page): spared until `GRACE_MS`, then dropped.
 * - Forgotten: dropped after `GRACE_MS`, whatever the config holds.
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
