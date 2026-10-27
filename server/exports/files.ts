// Built audiobooks on disk: one directory per book, each file named by an opaque token. The chosen
// name is on the row, so a rebuild never overwrites the current version and a failed one leaves it
// playable.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { removeTree } from "~/audio/files";
import { BOOK_ID } from "~/lib/http";

const TOKEN = /^[a-f0-9-]+\.[a-z0-9]+$/;

export interface AudiobookFiles {
  readonly dir: string;
  reserve(bookId: string, ext: string): Promise<{ token: string; path: string }>;
  /** null when the row can't name a file */
  path(bookId: string, token: string): string | null;
  /** this book's chapter audio kept between builds; removed with the book */
  cache(bookId: string): string | null;
  /** A file already gone is not an error. */
  remove(bookId: string, tokens: readonly string[]): Promise<void>;
  removeBook(bookId: string): Promise<void>;
}

export function audiobookFiles(dir: string): AudiobookFiles {
  return {
    dir,
    async reserve(bookId, ext) {
      const token = `${crypto.randomUUID()}.${ext}`;
      await mkdir(join(dir, bookId), { recursive: true });
      const path = join(dir, bookId, token);
      // claimed now, so a build that dies before writing still leaves row and file agreeing
      await writeFile(path, new Uint8Array());
      return { token, path };
    },
    path(bookId, token) {
      if (!BOOK_ID.test(bookId) || !TOKEN.test(token)) return null;
      return join(dir, bookId, token);
    },
    cache(bookId) {
      return BOOK_ID.test(bookId) ? join(dir, bookId, "cache") : null;
    },
    async remove(bookId, tokens) {
      for (const token of tokens) {
        const path = this.path(bookId, token);
        if (path) await rm(path, { force: true });
      }
    },
    async removeBook(bookId) {
      if (!BOOK_ID.test(bookId)) return;
      await removeTree(join(dir, bookId));
    },
  };
}
