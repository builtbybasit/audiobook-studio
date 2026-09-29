// The recordings a cloned voice was made from, on disk.
//
// One directory per voice, `<VOICE_DIR>/<key>/`, where the key is a hash of the endpoint and voice
// ids: a provider's voice id is not a name this server chose, and a hash of it can never climb out
// of the directory or collide with another voice's. Each recording is named by a hash of its bytes,
// as a cover is (`server/covers/files.ts`) — the same file picked twice is kept once, and a url whose
// bytes can never change is one a browser may cache for good.
//
// Nothing is re-encoded: a recording is kept exactly as it was picked, and its format is what its
// first bytes said it was when the route read it (`sniffSample`).
//
// Beside them, under `heard/`, is what the demo buttons have played: one file per voice, the
// provider's own recording of it or the endpoint saying the sample sentence, kept so a voice heard
// once is never paid for again. Each is named by a hash of what it was made from — the endpoint's
// model, format and rate for a rendered one — so one made before a change is simply not found, and
// the next one kept for that voice replaces it. It is a cache: a file lost is fetched again.
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SampleFormat } from "~/providers/clone";

const FILE = /^[a-f0-9]{32}\.(wav|mp3|m4a|opus|flac)$/;

const hash = (data: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 32);

/** The directory name one voice's recordings are kept under. */
const keyOf = (endpointId: string, voiceId: string): string => hash(`${endpointId}\0${voiceId}`);

/** Whether `file` is a name a recording could have been kept under. */
export const isSampleFile = (file: string): boolean => FILE.test(file);

/** A sample kept under `heard/`, and which of the names it was asked for by it was kept under. */
export interface HeardSample {
  bytes: Uint8Array;
  format: SampleFormat;
  /** the one of the `made` asked for that it was kept under */
  made: string;
}

/** What the demo buttons have played, kept per endpoint and voice. */
export interface HeardFiles {
  /** The first of these that is kept for the voice, in the order given; null when none is. */
  read(endpointId: string, voiceId: string, made: readonly string[]): Promise<HeardSample | null>;
  /** Keep one for the voice under `made`, in place of anything kept for it before. */
  keep(
    endpointId: string,
    voiceId: string,
    made: string,
    bytes: Uint8Array,
    format: SampleFormat,
  ): Promise<void>;
  /** Forget what was kept for every endpoint but these: the rest have been removed. */
  keepOnly(endpointIds: readonly string[]): Promise<void>;
}

export interface VoiceFiles {
  /** Keep one recording already sniffed as `format`, and say the name it is kept under. */
  write(
    endpointId: string,
    voiceId: string,
    bytes: Uint8Array,
    format: SampleFormat,
  ): Promise<string>;
  /** The path a request names, or null when it names something that cannot be a recording. */
  path(endpointId: string, voiceId: string, file: string): string | null;
  /**
   * Remove these recordings of one voice, and its directory once nothing is left in it. Only the
   * files named, never the directory whole: a keep for the same voice may be writing into it.
   */
  remove(endpointId: string, voiceId: string, files: readonly string[]): Promise<void>;
  heard: HeardFiles;
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
    heard: heardFiles(join(dir, "heard")),
  };
}

/** What is in a directory, or nothing when it is not there. */
const listed = (at: string): Promise<string[]> => readdir(at).catch(() => []);

function heardFiles(dir: string): HeardFiles {
  const voiceDir = (endpointId: string, voiceId: string) =>
    join(dir, hash(endpointId), hash(voiceId));
  return {
    async read(endpointId, voiceId, made) {
      const at = voiceDir(endpointId, voiceId);
      const names = (await listed(at)).filter(isSampleFile);
      for (const m of made) {
        const name = names.find((n) => n.startsWith(`${hash(m)}.`));
        if (!name) continue;
        const bytes = await readFile(join(at, name)).catch(() => null);
        if (bytes)
          return {
            bytes: new Uint8Array(bytes),
            format: name.slice(name.indexOf(".") + 1) as SampleFormat,
            made: m,
          };
      }
      return null;
    },
    async keep(endpointId, voiceId, made, bytes, format) {
      const at = voiceDir(endpointId, voiceId);
      const name = `${hash(made)}.${format}`;
      await mkdir(at, { recursive: true });
      // written aside and moved in, so a read never finds half a file
      const part = join(at, `${name}.part`);
      await writeFile(part, bytes);
      await rename(part, join(at, name));
      const stale = (await listed(at)).filter((n) => n !== name && isSampleFile(n));
      await Promise.all(stale.map((n) => rm(join(at, n), { force: true })));
    },
    async keepOnly(endpointIds) {
      const kept = new Set(endpointIds.map((id) => hash(id)));
      const gone = (await listed(dir)).filter((n) => !kept.has(n));
      await Promise.all(gone.map((n) => rm(join(dir, n), { recursive: true, force: true })));
    },
  };
}
