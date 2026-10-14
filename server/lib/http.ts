// URL and request helpers. The error shape lives in `errors.ts`, so domain code needn't know HTTP.
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";

import { uploadBodyBytes } from "~/env";
import { fail } from "~/lib/errors";

export { fail, type ApiError } from "~/lib/errors";

/** Latin letters that NFKD doesn't reduce to ASCII, spelled out as English writes them. */
const LETTERS: Record<string, string> = {
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  ß: "ss",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

/**
 * `moonlight-ledger` from `Moonlight Ledger.epub`. Always ASCII: the id is a directory name and
 * part of every clip url, and the file modules refuse anything else.
 */
export function slugify(s: string, empty = "book"): string {
  const slug = s
    .replace(/\.epub$/i, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[æœøłßđðþı]/g, (ch) => LETTERS[ch])
    // `philosophers-stone`, not `philosopher-s-stone`
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug || empty;
}

/** A book id safe in a file path: nothing in it can climb a directory. */
export const BOOK_ID = /^[A-Za-z0-9_-]+$/;

/** A whole number in a path segment: a 400, not the 404 `Number("3x")` or `Number("")` gives. */
export const IntParam = v.pipe(
  v.string(),
  v.regex(/^-?\d+$/, "must be a whole number"),
  v.transform(Number),
  v.integer(),
);

/** A chapter number or a volume id in a path: whole and positive. */
export const IdParam = v.pipe(IntParam, v.minValue(1, "must be positive"));

/** Most chapters one batch read names; a long book is asked for in several. */
export const MAX_BATCH = 500;

/** `?id=…` repeated; one arrives as a string, several as a list. */
export const ChapterIds = v.pipe(
  v.union([v.string(), v.array(v.string())]),
  v.transform((ids) => [ids].flat()),
  v.array(IdParam),
  v.minLength(1, "must name a chapter"),
  v.maxLength(MAX_BATCH, `at most ${MAX_BATCH} chapters`),
);

export const BookParam = v.object({ id: v.string() });

/**
 * A 413 naming `setting`, in two halves: `body` refuses early as the request streams in (allowing
 * the multipart envelope), and `file` is the exact limit, checked once the form is read.
 */
export function uploadLimit(mb: number, setting: string, what: "file" | "script" = "file") {
  const refuse = (detail = ""): never =>
    fail(
      413,
      `That file is larger than the ${mb} MB limit`,
      `${detail}Raise ${setting} if this is a ${what} you expect to import.`,
    );
  return {
    body: bodyLimit({ maxSize: uploadBodyBytes(mb), onError: () => refuse() }),
    file(file: File): void {
      if (file.size > mb * 1024 * 1024)
        refuse(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. `);
    },
  };
}
