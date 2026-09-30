// Small things about being on the wire.
//
// The error shape and the helpers that raise one live in `errors.ts`, so a domain operation can
// refuse something without knowing it is being served over HTTP. This file keeps what is only ever
// about a URL or a request.
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";

import { uploadBodyBytes } from "~/env";
import { fail } from "~/lib/errors";

export { fail, type ApiError } from "~/lib/errors";

/**
 * Latin letters that are not an ASCII letter with a mark on it, so taking the marks off leaves them
 * as they were. Spelled out the way English writes them when it has no such letter.
 */
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
 * `moonlight-ledger` from `Moonlight Ledger.epub` — a readable id, not a UUID.
 *
 * **ASCII, always.** The id is a directory name and part of every clip's and audiobook's url, and
 * the file modules refuse anything else — so an id that kept the `ß` of a title was a book whose
 * audio was written and then could never be fetched or removed. Accents come off (`Pokémon` →
 * `pokemon`, where the combining mark used to become a hyphen: `poke-mon`), the few letters
 * without a base letter are spelled out, and anything left that is not a letter or a digit is a
 * separator; an apostrophe is dropped. A title with nothing ASCII in it at all is a `book`.
 */
export function slugify(s: string): string {
  const slug = s
    .replace(/\.epub$/i, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[æœøłßđðþı]/g, (ch) => LETTERS[ch])
    // `philosophers-stone`, not `philosopher-s-stone`: an apostrophe joins a word, it does not end one.
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug || "book";
}

/**
 * What a book id in a file path may be: everything `slugify` makes, and the ids books were given
 * before it was ASCII-only, as long as they were ASCII too. Nothing in it can climb a directory.
 */
export const BOOK_ID = /^[A-Za-z0-9_-]+$/;

/**
 * A whole number in a path segment.
 *
 * Path parameters arrive as strings. `Number("3x")` is `NaN` and `Number("")` is `0`, and either
 * one handed to a query looks up nothing and answers 404 for a request that was never well formed.
 */
export const IntParam = v.pipe(
  v.string(),
  v.regex(/^-?\d+$/, "must be a whole number"),
  v.transform(Number),
  v.integer(),
);

/** A chapter number or a volume id in a path: whole and positive. */
export const IdParam = v.pipe(IntParam, v.minValue(1, "must be positive"));

/** A route under `/api/books/:id`: the book's id, which the operation looks up and refuses. */
export const BookParam = v.object({ id: v.string() });

/**
 * A route's limit on a file upload of up to `mb` megabytes, in two halves with one refusal (a 413
 * that names `setting` as the way to raise it).
 *
 * `body` refuses the request as it arrives — from its `content-length` when it says, and by
 * counting when it does not — rather than after the whole of it has been buffered to be looked at.
 * It has to allow a megabyte more than the file, for the multipart envelope (`uploadBodyBytes`),
 * so it is not the limit itself: `file` is, asked of the file once the form is read, so a file a
 * few bytes over is refused and not let through by the envelope's allowance. The server's own
 * ceiling (`maxRequestBodySize`) sits just above every such limit, as a backstop that answers in
 * Bun's words; these are what answer in the API's.
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
