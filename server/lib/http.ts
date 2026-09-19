// Small things about being on the wire.
//
// The error shape and the helpers that raise one live in `errors.ts`, so a domain operation can
// refuse something without knowing it is being served over HTTP. This file keeps what is only ever
// about a URL or a request.
import * as v from "valibot";

export { fail, type ApiError } from "~/lib/errors";

/** `moonlight-ledger` from `Moonlight Ledger.epub` — a readable id, not a UUID. */
export function slugify(s: string): string {
  const slug = s
    .normalize("NFKD")
    .replace(/\.epub$/i, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "book";
}

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
