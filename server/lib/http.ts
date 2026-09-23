// Small things about being on the wire.
//
// The error shape and the helpers that raise one live in `errors.ts`, so a domain operation can
// refuse something without knowing it is being served over HTTP. This file keeps what is only ever
// about a URL or a request.
import * as v from "valibot";

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
