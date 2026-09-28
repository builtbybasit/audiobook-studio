// Voice samples waiting with a speaker, on disk.
//
// Under the book's own audio directory, `<AUDIO_DIR>/<bookId>/samples/`, so removing the book —
// which removes that directory whole — removes them with nothing else to remember. Each recording
// is named by a hash of its bytes, as a cover and a kept clone recording are: the same file carried
// twice is kept once, and a name that is a hash can never climb out of its directory.
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BOOK_ID } from "~/lib/http";
import type { SampleFormat } from "~/providers/clone";

const FILE = /^[a-f0-9]{32}\.(wav|mp3|m4a|opus|flac)$/;

const hash = (data: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 32);

export interface SpeakerSampleFiles {
  /** Keep one recording already sniffed as `format`, and say the name it is kept under. */
  write(bookId: string, bytes: Uint8Array, format: SampleFormat): Promise<string>;
  /** The path a request names, or null when it names something that cannot be a recording. */
  path(bookId: string, file: string): string | null;
  /** Remove these recordings of one book, and the directory once nothing is left in it. */
  remove(bookId: string, files: readonly string[]): Promise<void>;
}

/** Waiting recordings under `audioDir` — `AUDIO_DIR` in the server, a temporary one in a test. */
export function speakerSampleFiles(audioDir: string): SpeakerSampleFiles {
  const dirOf = (bookId: string): string | null =>
    BOOK_ID.test(bookId) ? join(audioDir, bookId, "samples") : null;
  return {
    async write(bookId, bytes, format) {
      const at = dirOf(bookId);
      if (!at) throw new Error(`not a book id: ${bookId}`);
      const file = `${hash(bytes)}.${format}`;
      await mkdir(at, { recursive: true });
      await writeFile(join(at, file), bytes);
      return file;
    },
    path(bookId, file) {
      const at = dirOf(bookId);
      return at && FILE.test(file) ? join(at, file) : null;
    },
    async remove(bookId, files) {
      const at = dirOf(bookId);
      if (!at) return;
      await Promise.all(
        files.filter((f) => FILE.test(f)).map((f) => rm(join(at, f), { force: true })),
      );
      // refused while anything is still in it, which is the point
      await rmdir(at).catch(() => {});
    },
  };
}
