// Keeping, reading and forgetting the recordings a cloned voice was made from.
//
// The bytes go to disk first and the rows second, so a row never names a file that is not there;
// files a change leaves unnamed are removed after the commit, in the background, the way a removed
// book's clips are. A leftover file is a warning in the log, never a failed request.
import type { KeptSample, KeptVoiceSamples } from "@/types";
import { canCloneVoices } from "@/lib/endpointShapes";
import type { Db } from "~/db/client";
import { readEndpoint } from "~/db/endpoints";
import { forgetSamples, keepSamples, readKept, readKeptFor } from "~/db/voiceSamples";
import { inBackground } from "~/lib/background";
import { badRequest, notFound } from "~/lib/errors";
import { RECORDING_MIME, type RecordingFormat } from "~/providers/clone";
import type { VoiceFiles } from "~/voices/files";

/** One recording as the route read it: the bytes' own format, found before anything was sent. */
export interface KeptClip {
  name: string;
  blob: Blob;
  format: RecordingFormat;
}

export interface KeepRequest {
  endpointId: string;
  voiceId: string;
  title: string;
  consentText: string;
  clips: KeptClip[];
  /** the voice is already in a saved configuration */
  attached: boolean;
}

/** Write the recordings, then the rows; the files a replacement left behind go afterwards. */
export async function keepClips(db: Db, files: VoiceFiles, keep: KeepRequest): Promise<void> {
  const samples: KeptSample[] = [];
  for (const clip of keep.clips) {
    const bytes = new Uint8Array(await clip.blob.arrayBuffer());
    const file = await files.write(keep.endpointId, keep.voiceId, bytes, clip.format);
    samples.push({ file, name: clip.name, format: clip.format, bytes: bytes.length });
  }
  const left = db.transaction((tx) =>
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
  if (left.length)
    inBackground(files.remove(keep.endpointId, keep.voiceId, left), "voice samples left on disk", {
      endpointId: keep.endpointId,
      voiceId: keep.voiceId,
    });
}

/** A saved speech endpoint whose provider keeps cloned voices, or the refusal that says why not. */
function clonableEndpoint(db: Db, id: string) {
  const ep = readEndpoint(db, id);
  if (!ep) throw notFound("There is no saved speech endpoint by that id", `id: ${id}`);
  if (!canCloneVoices(ep))
    throw badRequest(`${ep.name} cannot make a voice from recordings, so it keeps none`);
  return ep;
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
 * Give a voice already on a saved endpoint the recordings it was made from, in place of any it had
 * — for a voice cloned before recordings were kept. Nothing is sent to the provider.
 */
export async function replaceClips(
  db: Db,
  files: VoiceFiles,
  request: Omit<KeepRequest, "attached" | "title">,
): Promise<KeptVoiceSamples> {
  const ep = clonableEndpoint(db, request.endpointId);
  const voice = ep.voices.find((v) => v.id === request.voiceId);
  if (!voice)
    throw notFound(`${ep.name} has no saved voice by that id`, `voice: ${request.voiceId}`);
  await keepClips(db, files, { ...request, title: voice.label, attached: true });
  return keptOf(db, request.endpointId, request.voiceId);
}

/** Forget one voice's recordings and keep the voice. */
export function forgetClips(db: Db, files: VoiceFiles, id: string, voiceId: string): void {
  if (!db.transaction((tx) => forgetSamples(tx, id, voiceId)))
    throw notFound("This voice has no recordings kept", `voice: ${voiceId}`);
  inBackground(files.remove(id, voiceId), "voice samples left on disk", { id, voiceId });
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
  return { path, type: RECORDING_MIME[sample.format] };
}

/** After a save: remove from disk the recordings of voices `reconcileClones` dropped. */
export function removeDropped(
  files: VoiceFiles,
  gone: readonly { endpointId: string; voiceId: string }[],
): void {
  for (const g of gone)
    inBackground(files.remove(g.endpointId, g.voiceId), "voice samples left on disk", g);
}
