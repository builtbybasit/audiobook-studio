// Cover images: where they live on disk, what counts as one, and how a url finds the file again.
//
// A cover is kept beside the book's clips, in `<AUDIO_DIR>/<bookId>/covers/`, so the removal that
// takes a book's directory takes its covers with it and nothing else has to remember them. The file
// is named by a hash of its bytes: the same image uploaded twice is one file under one url, and a
// url whose bytes can never change is one a browser may cache for good.
//
// **Only JPEG and PNG.** Those are what an M4B's cover atom and an MP3's picture frame are read as
// by every player that shows a cover at all, and what ffmpeg copies in without re-encoding. The
// type is read from the first bytes rather than taken from the upload's name or its content type,
// both of which are only what the browser guessed.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BOOK_ID } from "~/lib/http";

export type CoverType = "image/jpeg" | "image/png";

/** The largest cover kept. A 3000-pixel square JPEG, the size stores ask for, is well under it. */
export const MAX_COVER_BYTES = 10 * 1024 * 1024;

const FILE = /^[a-f0-9]{32}\.(jpg|png)$/;
const EXT: Record<CoverType, "jpg" | "png"> = { "image/jpeg": "jpg", "image/png": "png" };

/** What an image's first bytes say it is, or null when they say neither JPEG nor PNG. */
export function sniffCover(bytes: Uint8Array): CoverType | null {
  const b = bytes;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length > png.length && png.every((x, i) => b[i] === x)) return "image/png";
  return null;
}

export const coverUrl = (bookId: string, file: string): string =>
  `/api/books/${bookId}/covers/${file}`;

/**
 * The file a cover url of this book names, or null when it names anything else: another book's
 * cover, a path that is not one, a data URL. Asked before a build is queued, so a cover the server
 * could never find is a refusal rather than a build that fails later.
 */
export function coverFileOf(bookId: string, url: string): string | null {
  const prefix = `/api/books/${bookId}/covers/`;
  if (!url.startsWith(prefix)) return null;
  const file = url.slice(prefix.length);
  return FILE.test(file) ? file : null;
}

export interface CoverFiles {
  /** Keep an image already sniffed as a cover, and say its url. The same bytes, the same url. */
  write(bookId: string, bytes: Uint8Array, type: CoverType): Promise<{ url: string; file: string }>;
  /** The file a request names, or null when the request names something that cannot be one. */
  path(bookId: string, file: string): string | null;
  /** The file a cover url of this book names, when it is on disk. */
  existing(bookId: string, url: string): Promise<{ path: string; type: CoverType } | null>;
}

/** Covers under `dir` — the audio directory, so a book's covers go with its clips. */
export function coverFiles(dir: string): CoverFiles {
  return {
    async write(bookId, bytes, type) {
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 32);
      const file = `${hash}.${EXT[type]}`;
      const at = join(dir, bookId, "covers");
      await mkdir(at, { recursive: true });
      await writeFile(join(at, file), bytes);
      return { url: coverUrl(bookId, file), file };
    },
    path(bookId, file) {
      if (!BOOK_ID.test(bookId) || !FILE.test(file)) return null;
      return join(dir, bookId, "covers", file);
    },
    async existing(bookId, url) {
      const file = coverFileOf(bookId, url);
      const path = file ? this.path(bookId, file) : null;
      if (!file || !path) return null;
      const found = await stat(path).catch(() => null);
      if (!found?.isFile()) return null;
      return { path, type: file.endsWith(".png") ? "image/png" : "image/jpeg" };
    },
  };
}
