// Chapter audio kept between builds, and the AAC arithmetic that joins it without a re-encode.
// Each chapter is its own AAC stream: 1024 samples of encoder priming, then its samples, padded with
// silence to whole frames. Every join sits in the chapter gap with at least a frame of digital
// silence each side, so the two frames that overlap across it encode nothing and decode to exact
// silence; the priming of the later chapter plays as part of the gap.
import { createHash } from "node:crypto";
import { readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** samples in an AAC-LC frame, and ffmpeg's priming */
export const FRAME = 1024;
/** keys made under an older layout never match */
const LAYOUT = 1;
/** unused this long, an entry goes */
const KEEP_DAYS = 14;

export const keyOf = (...parts: (string | number)[]): string =>
  createHash("sha256")
    .update([LAYOUT, ...parts].join("\n"))
    .digest("hex")
    .slice(0, 32);

/** The silence a chapter after the first starts with, so its join adds up to the `gap` asked for. */
export const leadOf = (gap: number): number => gap - 2.5 * FRAME;

/** The shortest gap with a frame of silence each side of a join; shorter is encoded in one pass. */
export const joinable = (gap: number): boolean => leadOf(gap) >= FRAME;

/** Silence after a chapter: at least a frame, then up to the frame boundary. */
export const tailOf = (samples: number): number => FRAME + ((FRAME - (samples % FRAME)) % FRAME);

/** Frames in an ADTS stream, or null where it is not one raw AAC block per frame end to end. */
export function adtsFrames(b: Uint8Array): number | null {
  let n = 0;
  let at = 0;
  while (at + 7 <= b.byteLength) {
    if (b[at] !== 0xff || (b[at + 1] & 0xf6) !== 0xf0 || (b[at + 6] & 3) !== 0) return null;
    const length = ((b[at + 3] & 3) << 11) | (b[at + 4] << 3) | (b[at + 5] >> 5);
    if (length < 7) return null;
    at += length;
    n++;
  }
  return at === b.byteLength ? n : null;
}

export interface Segment {
  /** samples of silence before the chapter */
  lead: number;
  /** the chapter's own samples */
  audio: number;
  /** lead, audio and tail: whole frames */
  samples: number;
  /** the ADTS file's size, so a damaged one is a miss */
  bytes: number;
}

/** Entries are files named by key; written whole or not at all, and touched when used. */
export function segmentStore(dir: string) {
  const touch = (path: string) => {
    const now = new Date();
    return utimes(path, now, now).catch(() => {});
  };
  const read = async <T>(name: string): Promise<T | null> => {
    try {
      const value = JSON.parse(await readFile(join(dir, name), "utf8")) as T;
      await touch(join(dir, name));
      return value;
    } catch {
      return null;
    }
  };
  /** a path to write to and rename into place; `.tmp` marks it unfinished */
  const draft = (name: string): string =>
    join(dir, `${name}.${process.pid}-${crypto.randomUUID()}.tmp`);
  const write = async (name: string, value: unknown): Promise<void> => {
    const tmp = draft(name);
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, join(dir, name));
  };
  return {
    dir,
    read,
    write,
    draft,
    audio: (key: string): string => join(dir, `${key}.aac`),
    /** a segment whose audio is on disk at the size it was written */
    async segment(key: string): Promise<Segment | null> {
      const meta = await read<Segment>(`${key}.json`);
      const size = await stat(join(dir, `${key}.aac`)).then(
        (s) => s.size,
        () => -1,
      );
      if (!meta || size !== meta.bytes) return null;
      await touch(join(dir, `${key}.aac`));
      return meta;
    },
    async keep(key: string, tmp: string, meta: Segment): Promise<void> {
      await rename(tmp, join(dir, `${key}.aac`));
      await write(`${key}.json`, meta);
    },
  };
}

export type SegmentStore = ReturnType<typeof segmentStore>;

export const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Removes entries unused for `KEEP_DAYS`, and drafts whose process is gone. Never throws. */
export async function pruneSegments(dir: string, now = Date.now()): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const gone = name.endsWith(".tmp")
      ? !alive(Number(/\.(\d+)-[^.]+\.tmp$/.exec(name)?.[1]))
      : await stat(path).then(
          (s) => now - s.mtimeMs > KEEP_DAYS * 86_400_000,
          () => false,
        );
    if (gone) await rm(path, { force: true }).catch(() => {});
  }
}
