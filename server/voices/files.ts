// The recordings a cloned voice was made from, on disk.
//
// One directory per voice, `<VOICE_DIR>/<key>/`, where the key is a hash of the endpoint and voice
// ids: a provider's voice id is not a name this server chose, and a hash of it can never climb out
// of the directory or collide with another voice's. Each recording is named by a hash of its bytes,
// as a cover is (`server/covers/files.ts`) — the same file picked twice is kept once, and a url whose
// bytes can never change is one a browser may cache for good.
//
// Nothing is re-encoded: a recording is kept exactly as it was picked, and its format is what its
// first bytes said it was when the route read it (`sniffRecording`).
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RecordingFormat } from "~/providers/clone";

const FILE = /^[a-f0-9]{32}\.(wav|mp3|m4a|opus|flac)$/;

const hash = (data: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 32);

/** The directory name one voice's recordings are kept under. */
const keyOf = (endpointId: string, voiceId: string): string => hash(`${endpointId}\0${voiceId}`);

/** Whether `file` is a name a recording could have been kept under. */
export const isSampleFile = (file: string): boolean => FILE.test(file);

export interface VoiceFiles {
  /** Keep one recording already sniffed as `format`, and say the name it is kept under. */
  write(
    endpointId: string,
    voiceId: string,
    bytes: Uint8Array,
    format: RecordingFormat,
  ): Promise<string>;
  /** The path a request names, or null when it names something that cannot be a recording. */
  path(endpointId: string, voiceId: string, file: string): string | null;
  /**
   * Remove these recordings of one voice, and its directory once nothing is left in it. Only the
   * files named, never the directory whole: a keep for the same voice may be writing into it.
   */
  remove(endpointId: string, voiceId: string, files: readonly string[]): Promise<void>;
}

/** Recordings under `dir` — `VOICE_DIR` in the server, a temporary directory in a test. */
export function voiceFiles(dir: string): VoiceFiles {
  return {
    async write(endpointId, voiceId, bytes, format) {
      const file = `${hash(bytes)}.${format}`;
      const at = join(dir, keyOf(endpointId, voiceId));
      await mkdir(at, { recursive: true });
      await writeFile(join(at, file), bytes);
      return file;
    },
    path(endpointId, voiceId, file) {
      if (!FILE.test(file)) return null;
      return join(dir, keyOf(endpointId, voiceId), file);
    },
    async remove(endpointId, voiceId, files) {
      const at = join(dir, keyOf(endpointId, voiceId));
      await Promise.all(files.filter(isSampleFile).map((f) => rm(join(at, f), { force: true })));
      // refused while anything is still in it, which is the point
      await rmdir(at).catch(() => {});
    },
  };
}
