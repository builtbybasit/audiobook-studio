// Keeping, reading and forgetting a cloned voice's samples. Bytes go to disk before rows, so a row
// never names a missing file; files left unnamed are removed in the background after the commit.
import type { KeptSample, KeptVoiceSamples } from "@/types";
import type { Db } from "~/db/client";
import { readEndpoint } from "~/db/endpoints";
import {
  forgetSamples,
  keepSamples,
  readKept,
  readKeptFor,
  restoreSamples,
  samplesOf,
  type DroppedSamples,
} from "~/db/voiceSamples";
import { inBackground } from "~/lib/background";
import { notFound } from "~/lib/errors";
import { SAMPLE_MIME, type SampleUpload } from "~/providers/clone";
import type { VoiceFiles } from "~/voices/files";

export interface KeepRequest {
  endpointId: string;
  voiceId: string;
  title: string;
  samples: SampleUpload[];
  /** the voice is already in a saved configuration */
  attached: boolean;
}

/**
 * A keep that fails part way takes back the files it wrote, except any a row already names: the
 * same bytes kept for this voice before are that row's.
 */
export async function keepSampleFiles(db: Db, files: VoiceFiles, keep: KeepRequest): Promise<void> {
  const samples: KeptSample[] = [];
  let left: string[];
  try {
    for (const sample of keep.samples) {
      const bytes = new Uint8Array(await sample.blob.arrayBuffer());
      const file = await files.write(keep.endpointId, keep.voiceId, bytes, sample.format);
      samples.push({
        file,
        name: sample.name,
        format: sample.format,
        bytes: bytes.length,
        ...(sample.transcript ? { transcript: sample.transcript } : {}),
      });
    }
    left = db.transaction((tx) =>
      keepSamples(tx, {
        endpointId: keep.endpointId,
        voiceId: keep.voiceId,
        title: keep.title,
        at: Date.now(),
        attached: keep.attached,
        samples,
      }),
    );
  } catch (cause) {
    const named = new Set(samplesOf(db, keep.endpointId, keep.voiceId).map((s) => s.file));
    const stray = samples.map((s) => s.file).filter((f) => !named.has(f));
    if (stray.length)
      inBackground(
        files.remove(keep.endpointId, keep.voiceId, stray),
        "voice samples left on disk",
        {
          endpointId: keep.endpointId,
          voiceId: keep.voiceId,
        },
      );
    throw cause;
  }
  if (left.length)
    inBackground(files.remove(keep.endpointId, keep.voiceId, left), "voice samples left on disk", {
      endpointId: keep.endpointId,
      voiceId: keep.voiceId,
    });
}

export function keptFor(db: Db, id: string): KeptVoiceSamples[] {
  if (!readEndpoint(db, id))
    throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  return readKeptFor(db, id);
}

export function keptOf(db: Db, id: string, voiceId: string): KeptVoiceSamples {
  const kept = readKept(db, id, voiceId);
  if (!kept) throw notFound("This voice has no samples kept", `voice: ${voiceId}`);
  return kept;
}

/** Hidden at once, removed by a save after the grace period; Undo is `restoreSampleFiles`. */
export function forgetSampleFiles(db: Db, id: string, voiceId: string): void {
  if (!db.transaction((tx) => forgetSamples(tx, id, voiceId, Date.now())))
    throw notFound("This voice has no samples kept", `voice: ${voiceId}`);
}

export function restoreSampleFiles(db: Db, id: string, voiceId: string): KeptVoiceSamples {
  if (!db.transaction((tx) => restoreSamples(tx, id, voiceId)))
    throw notFound("These samples are gone for good", `voice: ${voiceId}`);
  return keptOf(db, id, voiceId);
}

export function sampleFile(
  db: Db,
  files: VoiceFiles,
  id: string,
  voiceId: string,
  file: string,
): { path: string; type: string } {
  const path = files.path(id, voiceId, file);
  const sample = path ? readKept(db, id, voiceId)?.samples.find((s) => s.file === file) : undefined;
  if (!path || !sample) throw notFound("There is no such sample", `file: ${file}`);
  return { path, type: SAMPLE_MIME[sample.format] };
}

/** After a save: remove only the samples `reconcileClones` dropped. */
export function removeDropped(files: VoiceFiles, gone: readonly DroppedSamples[]): void {
  for (const g of gone)
    inBackground(files.remove(g.endpointId, g.voiceId, g.files), "voice samples left on disk", {
      endpointId: g.endpointId,
      voiceId: g.voiceId,
    });
}
