// Where rendered audio lives on disk, and how a clip's `url` finds it again.
//
// A clip row holds a url and nothing else about the file, so this module is the only place that
// knows the layout: one directory per book, one file per render, named by a token that means
// nothing. Not the chapter number and not the line, because both are addresses that move — a
// renumbering must not move files, and a token that is never reused means the route can tell the
// browser to cache a clip forever. The book id is in the path so that removing a book is removing
// a directory, which is the whole of the cleanup story.
//
// `path` is the one function that turns a request into a filesystem path, and it refuses anything
// that is not exactly a book id and a token: there is no request that legitimately reads outside a
// book's directory, so none is allowed to try.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BOOK_ID } from "~/lib/http";

const FILE = /^[a-f0-9-]+\.wav$/;

export interface AudioFiles {
  /** the directory everything is under, for the boot log */
  readonly dir: string;
  /** Keep one render, and say where a browser can fetch it. */
  write(bookId: string, bytes: Uint8Array, ext: "wav"): Promise<{ url: string }>;
  /** The file a request names, or null when the request names something that cannot be a file. */
  path(bookId: string, file: string): string | null;
  /** Everything a book's clips left on disk; a book that left nothing is not an error. */
  removeBook(bookId: string): Promise<void>;
}

export function audioFiles(dir: string): AudioFiles {
  return {
    dir,
    async write(bookId, bytes, ext) {
      const file = `${crypto.randomUUID()}.${ext}`;
      await mkdir(join(dir, bookId), { recursive: true });
      await writeFile(join(dir, bookId, file), bytes);
      return { url: `/api/audio/${bookId}/${file}` };
    },
    path(bookId, file) {
      if (!BOOK_ID.test(bookId) || !FILE.test(file)) return null;
      return join(dir, bookId, file);
    },
    async removeBook(bookId) {
      if (!BOOK_ID.test(bookId)) return;
      await rm(join(dir, bookId), { recursive: true, force: true });
    },
  };
}
