// Where rendered audio lives on disk, and how a clip's `url` finds it again.
//
// A clip row holds a url and nothing else about the file, so this module is the only place that
// knows the layout: one directory per book, one file per render, named by a token that means
// nothing. Not the chapter number and not the line, because both are addresses that move — a
// renumbering must not move files, and a token that is never reused means the route can tell the
// browser to cache a clip forever. The book id is in the path so that removing a book is removing
// a directory, which is the whole of the cleanup story.
//
// The url is under the API base of the library that rendered the clip — `/api`, or `/demo/api` for
// the demo — and it is stored with the clip, so a clip is only ever served by the library that
// holds it.
//
// `path` is the one function that turns a request into a filesystem path, and it refuses anything
// that is not exactly a book id and a token: there is no request that legitimately reads outside a
// book's directory, so none is allowed to try.
//
// A clip is kept in the format it came back in, and its extension is the only record of which:
// `.wav`, `.mp3` or `.opus` (`AUDIO_EXT`). The route serves each by its extension, and the export
// decides by it whether a clip needs decoding before it can be stitched.
//
// Whatever reads a clip's bytes asks for them through `ready` rather than `path`, because a library
// may hold clips whose files it has not written yet: the demo is seeded with thousands of narrated
// lines and makes each one's file the first time something reads it (`audio/demoClips.ts`). The
// real library makes nothing, so there `ready` is `path` — a file that is gone stays gone.
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AudioFormat } from "@/types";
import { AUDIO_EXT } from "@/lib/endpointShapes";
import { BOOK_ID } from "~/lib/http";

const FILE = new RegExp(`^[a-f0-9-]+\\.(${Object.values(AUDIO_EXT).join("|")})$`);

const BY_EXT = new Map(
  (Object.entries(AUDIO_EXT) as [AudioFormat, string][]).map(([format, ext]) => [ext, format]),
);

/** The format a clip's file name, path or url says it is in, or null when it names none kept here. */
export function formatOfFile(name: string): AudioFormat | null {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? null : (BY_EXT.get(name.slice(dot + 1).toLowerCase()) ?? null);
}

/**
 * The bytes the clip a url names should hold, for a library that can make a clip's file again from
 * its row; null when no clip names that url, or none this can make.
 */
export type MakeClip = (bookId: string, url: string) => Uint8Array | null;

export interface AudioFiles {
  /** the directory everything is under, for the boot log */
  readonly dir: string;
  /** the library's API base its urls are under: `/api`, or `/demo/api` */
  readonly base: string;
  /** Keep one render, under its format's extension, and say where a browser can fetch it. */
  write(bookId: string, bytes: Uint8Array, format: AudioFormat): Promise<{ url: string }>;
  /** The file a request names, or null when the request names something that cannot be a file. */
  path(bookId: string, file: string): string | null;
  /**
   * `path`, for a caller about to read the file: one this library knows how to make and has not
   * made yet is written first. What comes back may still name nothing — a name no clip holds, a
   * file removed by hand — and the caller answers that as it answers a missing file.
   */
  ready(bookId: string, file: string): Promise<string | null>;
  /** Some of a book's clips, by file name; one already gone is not an error. */
  remove(bookId: string, files: readonly string[]): Promise<void>;
  /** Everything a book's clips left on disk; a book that left nothing is not an error. */
  removeBook(bookId: string): Promise<void>;
}

export function audioFiles(dir: string, base = "/api", make?: MakeClip): AudioFiles {
  // One write per file however many ask for it at once: the player, a build and a second tab can
  // all reach the same unmade clip together, and the later ones wait on the first.
  const making = new Map<string, Promise<void>>();
  const urlOf = (bookId: string, file: string) => `${base}/audio/${bookId}/${file}`;

  /** Write the clip at `path` unless it is there by now, under a name nothing reads until it is whole. */
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
      const file = `${crypto.randomUUID()}.${AUDIO_EXT[format]}`;
      await mkdir(join(dir, bookId), { recursive: true });
      await writeFile(join(dir, bookId, file), bytes);
      return { url: urlOf(bookId, file) };
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
