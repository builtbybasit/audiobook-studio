// Covers live in `<AUDIO_DIR>/<bookId>/covers/`, so removing a book removes them, named by a hash
// of their bytes so a url can be cached for good. Only JPEG and PNG, which every player reads and
// ffmpeg embeds without re-encoding; the type is sniffed from the bytes, not the upload's guess.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AudioFiles } from "~/audio/files";
import { BOOK_ID } from "~/lib/http";

export type CoverType = "image/jpeg" | "image/png";

/** A 3000-pixel square JPEG, the size stores ask for, is well under it. */
export const MAX_COVER_BYTES = 10 * 1024 * 1024;

const FILE = /^[a-f0-9]{32}\.(jpg|png)$/;
const EXT: Record<CoverType, "jpg" | "png"> = { "image/jpeg": "jpg", "image/png": "png" };

export function sniffCover(bytes: Uint8Array): CoverType | null {
  const b = bytes;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length > png.length && png.every((x, i) => b[i] === x)) return "image/png";
  return null;
}

export interface CoverFiles {
  /** The same bytes get the same url. */
  write(bookId: string, bytes: Uint8Array, type: CoverType): Promise<{ url: string; file: string }>;
  /** null when the request can't name a cover. */
  path(bookId: string, file: string): string | null;
  /** null for anything but this book's cover url; checked before a build is queued. */
  fileOf(bookId: string, url: string): string | null;
  existing(bookId: string, url: string): Promise<{ path: string; type: CoverType } | null>;
}

export function coverFiles({ dir, base }: Pick<AudioFiles, "dir" | "base">): CoverFiles {
  const prefix = (bookId: string) => `${base}/books/${bookId}/covers/`;
  return {
    async write(bookId, bytes, type) {
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 32);
      const file = `${hash}.${EXT[type]}`;
      const at = join(dir, bookId, "covers");
      await mkdir(at, { recursive: true });
      await writeFile(join(at, file), bytes);
      return { url: prefix(bookId) + file, file };
    },
    path(bookId, file) {
      if (!BOOK_ID.test(bookId) || !FILE.test(file)) return null;
      return join(dir, bookId, "covers", file);
    },
    fileOf(bookId, url) {
      if (!url.startsWith(prefix(bookId))) return null;
      const file = url.slice(prefix(bookId).length);
      return FILE.test(file) ? file : null;
    },
    async existing(bookId, url) {
      const file = this.fileOf(bookId, url);
      const path = file ? this.path(bookId, file) : null;
      if (!file || !path) return null;
      const found = await stat(path).catch(() => null);
      if (!found?.isFile()) return null;
      return { path, type: file.endsWith(".png") ? "image/png" : "image/jpeg" };
    },
  };
}
