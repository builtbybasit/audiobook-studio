// A cloned voice's recordings on disk, `<VOICE_DIR>/<hash of endpoint and voice ids>/`, each named
// by a hash of its bytes, kept as picked. `heard/` caches what the demo buttons played, one file per
// voice named by a hash of what made it, so a voice heard once is never paid for again.
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SampleFormat } from "~/providers/clone";

const FILE = /^[a-f0-9]{32}\.(wav|mp3|m4a|opus|flac)$/;

const hash = (data: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 32);

/** A provider's voice id is not ours to trust as a path; a hash cannot climb out or collide. */
const keyOf = (endpointId: string, voiceId: string): string => hash(`${endpointId}\0${voiceId}`);

/** Also used for a speaker's waiting recordings (`~/speakerSamples/files`). */
export const isSampleFile = (file: string): boolean => FILE.test(file);

export const sampleFileName = (bytes: Uint8Array, format: SampleFormat): string =>
  `${hash(bytes)}.${format}`;

export interface HeardSample {
  bytes: Uint8Array;
  format: SampleFormat;
  /** which of the `made` asked for it was kept under */
  made: string;
}

export interface HeardFiles {
  /** The first of `made` kept for the voice; null when none is. */
  read(endpointId: string, voiceId: string, made: readonly string[]): Promise<HeardSample | null>;
  /** Drops anything kept for the voice before, but what `alsoKept` names. */
  keep(
    endpointId: string,
    voiceId: string,
    made: string,
    bytes: Uint8Array,
    format: SampleFormat,
    alsoKept?: readonly string[],
  ): Promise<void>;
  /** Forget every endpoint but these. */
  keepOnly(endpointIds: readonly string[]): Promise<void>;
}

export interface VoiceFiles {
  /** Answers the file name. */
  write(
    endpointId: string,
    voiceId: string,
    bytes: Uint8Array,
    format: SampleFormat,
  ): Promise<string>;
  /** null when `file` cannot be a recording. */
  path(endpointId: string, voiceId: string, file: string): string | null;
  /** Only the files named, never the directory whole: a keep may be writing into it. */
  remove(endpointId: string, voiceId: string, files: readonly string[]): Promise<void>;
  heard: HeardFiles;
}

export function voiceFiles(dir: string): VoiceFiles {
  return {
    async write(endpointId, voiceId, bytes, format) {
      const file = sampleFileName(bytes, format);
      const at = join(dir, keyOf(endpointId, voiceId));
      await mkdir(at, { recursive: true });
      await writeFile(join(at, file), bytes);
      return file;
    },
    path(endpointId, voiceId, file) {
      if (!isSampleFile(file)) return null;
      return join(dir, keyOf(endpointId, voiceId), file);
    },
    async remove(endpointId, voiceId, files) {
      const at = join(dir, keyOf(endpointId, voiceId));
      await Promise.all(files.filter(isSampleFile).map((f) => rm(join(at, f), { force: true })));
      // fails while anything is left, which is the point
      await rmdir(at).catch(() => {});
    },
    heard: heardFiles(join(dir, "heard")),
  };
}

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
    async keep(endpointId, voiceId, made, bytes, format, alsoKept = []) {
      const at = voiceDir(endpointId, voiceId);
      const name = `${hash(made)}.${format}`;
      await mkdir(at, { recursive: true });
      // written aside and moved in, so a read never finds half a file
      const part = join(at, `${name}.part`);
      await writeFile(part, bytes);
      await rename(part, join(at, name));
      const keeping = new Set([made, ...alsoKept].map(hash));
      const stale = (await listed(at)).filter(
        (n) => isSampleFile(n) && !keeping.has(n.slice(0, n.indexOf("."))),
      );
      await Promise.all(stale.map((n) => rm(join(at, n), { force: true })));
    },
    async keepOnly(endpointIds) {
      const kept = new Set(endpointIds.map((id) => hash(id)));
      const gone = (await listed(dir)).filter((n) => !kept.has(n));
      await Promise.all(gone.map((n) => rm(join(dir, n), { recursive: true, force: true })));
    },
  };
}
