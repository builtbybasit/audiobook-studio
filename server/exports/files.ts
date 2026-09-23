// Where a built audiobook lives on disk, and how a download finds it again.
//
// The same arrangement the clips have, for the same reasons: one directory per book, one file per
// output file, named by a token that means nothing. The name the listener chose is on the row, not
// on the file, because two versions of one audiobook have the same name and a rebuild must not
// write over the version that is still current — an export that fails halfway has to leave the
// last good one playable.
//
// Built files are kept apart from the clips rather than beside them. A clip is an input a rebuild
// reads again; an audiobook is a deliverable, and the two answer different questions about how
// much disk a book is using.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BOOK_ID } from "~/lib/http";

const TOKEN = /^[a-f0-9-]+\.[a-z0-9]+$/;

export interface AudiobookFiles {
  /** the directory everything is under, for the boot log */
  readonly dir: string;
  /** Somewhere to write one output file, and the token it is found again by. */
  reserve(bookId: string, ext: string): Promise<{ token: string; path: string }>;
  /** The file a row names, or null when the row names something that cannot be a file. */
  path(bookId: string, token: string): string | null;
  /** Forget the files one export left behind. A file already gone is not an error. */
  remove(bookId: string, tokens: readonly string[]): Promise<void>;
  /** Everything a book's audiobooks left on disk. */
  removeBook(bookId: string): Promise<void>;
}

export function audiobookFiles(dir: string): AudiobookFiles {
  return {
    dir,
    async reserve(bookId, ext) {
      const token = `${crypto.randomUUID()}.${ext}`;
      await mkdir(join(dir, bookId), { recursive: true });
      const path = join(dir, bookId, token);
      // Claim the name before the encoder is handed it, so a build that dies before its first
      // write still leaves a row and a file that agree with each other.
      await writeFile(path, new Uint8Array());
      return { token, path };
    },
    path(bookId, token) {
      if (!BOOK_ID.test(bookId) || !TOKEN.test(token)) return null;
      return join(dir, bookId, token);
    },
    async remove(bookId, tokens) {
      for (const token of tokens) {
        const path = this.path(bookId, token);
        if (path) await rm(path, { force: true });
      }
    },
    async removeBook(bookId) {
      if (!BOOK_ID.test(bookId)) return;
      await rm(join(dir, bookId), { recursive: true, force: true });
    },
  };
}
