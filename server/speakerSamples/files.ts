// Voice samples waiting with a speaker, under `<AUDIO_DIR>/<bookId>/samples/`, so removing the
// book's directory removes them too. Named by a hash of their bytes, as kept clone recordings are.
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BOOK_ID } from "~/lib/http";
import type { SampleFormat } from "~/providers/clone";
import { isSampleFile, sampleFileName } from "~/voices/files";

export interface SpeakerSampleFiles {
  /** Answers the file name. */
  write(bookId: string, bytes: Uint8Array, format: SampleFormat): Promise<string>;
  /** null when `file` cannot be a recording. */
  path(bookId: string, file: string): string | null;
  remove(bookId: string, files: readonly string[]): Promise<void>;
}

export function speakerSampleFiles(audioDir: string): SpeakerSampleFiles {
  const dirOf = (bookId: string): string | null =>
    BOOK_ID.test(bookId) ? join(audioDir, bookId, "samples") : null;
  return {
    async write(bookId, bytes, format) {
      const at = dirOf(bookId);
      if (!at) throw new Error(`not a book id: ${bookId}`);
      const file = sampleFileName(bytes, format);
      await mkdir(at, { recursive: true });
      await writeFile(join(at, file), bytes);
      return file;
    },
    path(bookId, file) {
      const at = dirOf(bookId);
      return at && isSampleFile(file) ? join(at, file) : null;
    },
    async remove(bookId, files) {
      const at = dirOf(bookId);
      if (!at) return;
      await Promise.all(files.filter(isSampleFile).map((f) => rm(join(at, f), { force: true })));
      // fails while anything is left, which is the point
      await rmdir(at).catch(() => {});
    },
  };
}
