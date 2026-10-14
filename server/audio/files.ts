// Rendered audio on disk: `<dir>/<bookId>/<token>.<ext>`, the only place that knows the layout.
// The token is never reused (renumbering moves no files; clips cache forever), and the extension
// is the only record of the format. `path` refuses anything but a book id and a token.
// Readers go through `ready`, which makes a demo clip's file on first read (`audio/demoClips.ts`).
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AudioFormat } from "@/types";
import { AUDIO_EXT } from "@/lib/endpointShapes";
import { BOOK_ID } from "~/lib/http";

const FILE = new RegExp(`^[a-f0-9-]+\\.(${Object.values(AUDIO_EXT).join("|")})$`);

const BY_EXT = new Map(
  (Object.entries(AUDIO_EXT) as [AudioFormat, string][]).map(([format, ext]) => [ext, format]),
);

/** The format a clip's file name, path or url says it is in, or null. */
export function formatOfFile(name: string): AudioFormat | null {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : (BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? null);
}

/** Does not check the url is this library's; `AudioFiles.find` does. */
export const fileName = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

/** Remakes a clip's bytes from its row; null when no clip names that url. */
export type MakeClip = (bookId: string, url: string) => Uint8Array | null;

export interface AudioFiles {
  readonly dir: string;
  /** the API base urls are under: `/api`, or `/demo/api` */
  readonly base: string;
  write(bookId: string, bytes: Uint8Array, format: AudioFormat): Promise<{ url: string }>;
  /** A new name, for a caller that writes the file itself (the effect runner's batch). */
  fresh(bookId: string, format: AudioFormat): Promise<{ path: string; url: string }>;
  /** null when the request names something that cannot be a file. */
  path(bookId: string, file: string): string | null;
  /** `path`, after making a makeable file that is missing. The path may still name nothing. */
  ready(bookId: string, file: string): Promise<string | null>;
  /**
   * The file a clip url names, made as `ready` would; undefined for another library's url, a book
   * other than `bookId`, a bad name, or a missing file.
   */
  find(url: string, bookId?: string): Promise<string | undefined>;
  /** A file already gone is not an error. */
  remove(bookId: string, files: readonly string[]): Promise<void>;
  removeBook(bookId: string): Promise<void>;
}

export function audioFiles(dir: string, base = "/api", make?: MakeClip): AudioFiles {
  // One write per file: concurrent readers of the same unmade clip wait on the first.
  const making = new Map<string, Promise<void>>();
  const urlOf = (bookId: string, file: string) => `${base}/audio/${bookId}/${file}`;

  /** Written under a temporary name, so nothing reads it until it is whole. */
  const makeAt = async (path: string, bookId: string, file: string): Promise<void> => {
    if (await Bun.file(path).exists()) return;
    const bytes = make?.(bookId, urlOf(bookId, file));
    if (!bytes) return;
    await mkdir(join(dir, bookId), { recursive: true });
    const part = `${path}.${crypto.randomUUID()}.part`;
    await writeFile(part, bytes);
    await rename(part, path);
  };

  return {
    dir,
    base,
    async write(bookId, bytes, format) {
      const { path, url } = await this.fresh(bookId, format);
      await writeFile(path, bytes);
      return { url };
    },
    async fresh(bookId, format) {
      const file = `${crypto.randomUUID()}.${AUDIO_EXT[format]}`;
      await mkdir(join(dir, bookId), { recursive: true });
      return { path: join(dir, bookId, file), url: urlOf(bookId, file) };
    },
    path(bookId, file) {
      if (!BOOK_ID.test(bookId) || !FILE.test(file)) return null;
      return join(dir, bookId, file);
    },
    async ready(bookId, file) {
      const path = this.path(bookId, file);
      if (!path || !make || (await Bun.file(path).exists())) return path;
      let pending = making.get(path);
      if (!pending) {
        pending = makeAt(path, bookId, file).finally(() => making.delete(path));
        making.set(path, pending);
      }
      await pending;
      return path;
    },
    async find(url, bookId) {
      const prefix = `${base}/audio/`;
      if (!url.startsWith(prefix)) return undefined;
      const [book, file, ...rest] = url.slice(prefix.length).split("/");
      if (rest.length || file === undefined || (bookId !== undefined && book !== bookId))
        return undefined;
      const path = await this.ready(book, file);
      return path && (await Bun.file(path).exists()) ? path : undefined;
    },
    async remove(bookId, files) {
      for (const file of files) {
        const path = this.path(bookId, file);
        if (path) await rm(path, { force: true });
      }
    },
    async removeBook(bookId) {
      if (!BOOK_ID.test(bookId)) return;
      await rm(join(dir, bookId), { recursive: true, force: true });
    },
  };
}
