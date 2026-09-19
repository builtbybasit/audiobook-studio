// What a failure looks like on the wire.
//
// One shape for every error the API returns, so the client has one thing to read and the UI can
// put a provider's words in front of a person without guessing where they are. `message` is meant
// to be shown; `detail` is the longer explanation a panel can expand to.
import { HTTPException } from "hono/http-exception";

export interface ApiError {
  error: { message: string; detail?: string };
}

/** Fail this request with a message the UI can show as it stands. */
export function fail(
  status: 400 | 404 | 409 | 413 | 415 | 500,
  message: string,
  detail?: string,
): never {
  throw new HTTPException(status, {
    res: Response.json({ error: { message, ...(detail ? { detail } : {}) } } satisfies ApiError, {
      status,
    }),
  });
}

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
