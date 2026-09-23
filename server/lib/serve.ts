// A file on disk as a response, a part of it at a time when the client asks for one.
//
// `<audio>` does not download a clip and then play it. It asks for the part it needs next, with a
// `Range` header, and it only knows it may do that because the first answer said
// `Accept-Ranges: bytes`. Bun does not answer ranges for a `Response` built in a fetch handler — it
// sends the whole file with a 200 whatever was asked — so a long clip or a WAV audiobook could not
// be seeked at all, and Safari may refuse media served that way outright. The header is parsed by
// `range-parser`, the one Express's `send` uses; the slicing is Bun's own, which reads only the
// bytes the slice covers.
import type { BunFile } from "bun";
import parseRange from "range-parser";

import type { ApiError } from "~/lib/errors";

/**
 * The file, or the part of it the request's `Range` names.
 *
 * - no `Range`, or one this does not answer: the whole file, 200. A server may always ignore
 *   `Range`, and does here for a malformed header, a unit other than bytes and a request for
 *   several ranges at once, which a media element never makes.
 * - one range inside the file: that part, 206, with the `Content-Range` saying where it sits.
 * - a range the file does not reach: 416, with the size, so the client can ask again.
 *
 * `headers` are the file's own — its type, how long it may be kept — and go on every answer.
 */
export function fileResponse(
  req: Request,
  file: BunFile,
  headers: Record<string, string>,
): Response {
  const size = file.size;
  const base = { ...headers, "accept-ranges": "bytes" };
  const header = req.headers.get("range");
  // The length said outright, not left to the body: a `HEAD` is answered by the `GET` route with
  // the body taken off, and Bun would then count what is left, which is nothing.
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
