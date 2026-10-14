// A file on disk as a response, with `Range` support. Bun ignores `Range` on a `Response` built in
// a fetch handler, so without this `<audio>` can't seek and Safari may refuse the media outright.
import type { BunFile } from "bun";
import type { Context } from "hono";
import parseRange from "range-parser";

import { notFound, type ApiError } from "~/lib/errors";

export interface ServeOptions {
  /** the 404's message when there is no such file */
  missing: string;
  detail?: string;
  /** true (default) when the name is the bytes' hash and can be cached for good */
  immutable?: boolean;
  headers?: Record<string, string>;
}

/** Every route serving a file on disk goes through this, for uniform caching and 404s. */
export async function serveFile(
  c: Context,
  path: string | null | undefined,
  type: string,
  { missing, detail, immutable = true, headers }: ServeOptions,
): Promise<Response> {
  const found = path ? Bun.file(path) : null;
  if (!found || !(await found.exists())) throw notFound(missing, detail);
  return fileResponse(c.req.raw, found, {
    "content-type": type,
    "cache-control": immutable
      ? "private, max-age=31536000, immutable"
      : "private, max-age=0, must-revalidate",
    ...headers,
  });
}

/**
 * One byte range: 206. Out of the file: 416. Anything else (none, malformed, multiple ranges, which
 * a media element never asks for): the whole file, 200.
 */
export function fileResponse(
  req: Request,
  file: BunFile,
  headers: Record<string, string>,
): Response {
  const size = file.size;
  const base = { ...headers, "accept-ranges": "bytes" };
  const header = req.headers.get("range");
  // explicit, because a `HEAD` reuses the `GET` route with the body stripped and Bun would count 0
  const whole = { ...base, "content-length": String(size) };
  if (!header) return new Response(file, { headers: whole });

  const ranges = parseRange(size, header, { combine: true });
  if (ranges === -1)
    return Response.json(
      {
        error: {
          code: "range_not_satisfiable",
          message: "That part of the file does not exist",
          detail: `Asked for ${header}; the file is ${size} bytes.`,
        },
      } satisfies ApiError,
      { status: 416, headers: { ...base, "content-range": `bytes */${size}` } },
    );
  if (ranges === -2 || ranges.type !== "bytes" || ranges.length !== 1)
    return new Response(file, { headers: whole });

  const [{ start, end }] = ranges;
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...base,
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
    },
  });
}
