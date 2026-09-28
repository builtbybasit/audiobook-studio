// Keeping, reading and forgetting the recordings a cloned voice was made from.
//
// The bytes go to disk first and the rows second, so a row never names a file that is not there;
// files a change leaves unnamed are removed after the commit, in the background, the way a removed
// book's clips are. A leftover file is a warning in the log, never a failed request.
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
  consentText: string;
  samples: SampleUpload[];
  /** the voice is already in a saved configuration */
  attached: boolean;
}

/**
 * Write the recordings, then the rows; the files a replacement left behind go afterwards. A keep
 * that fails part way takes back the files it wrote, except any a row already names — the same
 * bytes kept for this voice before are that row's, not this call's.
 */
export async function keepSampleFiles(db: Db, files: VoiceFiles, keep: KeepRequest): Promise<void> {
  const samples: KeptSample[] = [];
  let left: string[];
  try {
    for (const sample of keep.samples) {
      const bytes = new Uint8Array(await sample.blob.arrayBuffer());
      const file = await files.write(keep.endpointId, keep.voiceId, bytes, sample.format);
      samples.push({ file, name: sample.name, format: sample.format, bytes: bytes.length });
    }
    left = db.transaction((tx) =>
      keepSamples(tx, {
        endpointId: keep.endpointId,
        voiceId: keep.voiceId,
        title: keep.title,
        at: Date.now(),
        consentText: keep.consentText,
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

/** Every voice of one saved endpoint that has recordings kept. */
export function keptFor(db: Db, id: string): KeptVoiceSamples[] {
  if (!readEndpoint(db, id))
    throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  return readKeptFor(db, id);
}

/** One voice's kept recordings; a voice with none is not found. */
export function keptOf(db: Db, id: string, voiceId: string): KeptVoiceSamples {
  const kept = readKept(db, id, voiceId);
  if (!kept) throw notFound("This voice has no recordings kept", `voice: ${voiceId}`);
  return kept;
}

/**
 * Forget one voice's recordings and keep the voice. They are hidden at once and removed by a save
 * after the grace period, so the forget's Undo (`restoreSampleFiles`) can bring them back until then.
 */
export function forgetSampleFiles(db: Db, id: string, voiceId: string): void {
  if (!db.transaction((tx) => forgetSamples(tx, id, voiceId, Date.now())))
    throw notFound("This voice has no recordings kept", `voice: ${voiceId}`);
}

/** Take back a forget; its recordings are answered as they were. */
export function restoreSampleFiles(db: Db, id: string, voiceId: string): KeptVoiceSamples {
  if (!db.transaction((tx) => restoreSamples(tx, id, voiceId)))
    throw notFound("These recordings are gone for good", `voice: ${voiceId}`);
  return keptOf(db, id, voiceId);
}

/** Where one kept recording is on disk, and what it is served as. */
export function sampleFile(
  db: Db,
  files: VoiceFiles,
  id: string,
  voiceId: string,
  file: string,
): { path: string; type: string } {
  const path = files.path(id, voiceId, file);
  const sample = path ? readKept(db, id, voiceId)?.samples.find((s) => s.file === file) : undefined;
  if (!path || !sample) throw notFound("There is no such recording", `file: ${file}`);
  return { path, type: SAMPLE_MIME[sample.format] };
}

/** After a save: remove from disk the recordings `reconcileClones` dropped — only those. */
export function removeDropped(files: VoiceFiles, gone: readonly DroppedSamples[]): void {
  for (const g of gone)
    inBackground(files.remove(g.endpointId, g.voiceId, g.files), "voice samples left on disk", {
      endpointId: g.endpointId,
      voiceId: g.voiceId,
    });
}
