// Talking to the API: one client, one error, for every service that goes over the wire.
//
// The library service and the jobs service ask different questions of the same server, and the
// part that is the same — where it is, what a failure looks like, what to do when something other
// than the API answers — is here so it is written once. A service holds one of these and says what
// it wants in terms of paths and bodies.
import type { ApiErrorCode } from "@/types";

/** A failure the API described. `detail` is the longer explanation a panel can expand to. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
    /** the server's stable name for what went wrong; absent when something else answered */
    readonly code?: ApiErrorCode,
  ) {
    super(message);
  }
}

/**
 * Just the part of `fetch` this client calls.
 *
 * Narrower than `typeof fetch` on purpose: the global carries extras that differ between runtimes,
 * and requiring them would mean a test could not hand over a plain function.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What the API returns when something goes wrong; see `server/lib/errors.ts`. */
interface ErrorBody {
  error?: { code?: ApiErrorCode; message?: string; detail?: string };
}

/** Enough of an unexpected response to recognise it by, without pasting a page into a toast. */
function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max) + "…";
}

// Not everything that answers this URL is the API. A proxy, a dev server or a gateway in front
// of it answers with HTML, and parsing that would throw a `SyntaxError` out of a method whose
// whole contract is that it throws `ApiError` — so the page would report a JavaScript fault
// where it should be saying the server is unreachable.
function parseJson(text: string): { body: unknown; parsed: boolean } {
  try {
    return { body: text ? JSON.parse(text) : null, parsed: true };
  } catch {
    return { body: null, parsed: false };
  }
}

/** A response that is not ok, as the error the API's JSON body describes. */
function refusal(res: Response, text: string): ApiError {
  const { body, parsed } = parseJson(text);
  const { error } = (parsed ? (body ?? {}) : {}) as ErrorBody;
  return new ApiError(
    error?.message ?? `Request failed (${res.status})`,
    res.status,
    error?.detail ?? (parsed ? undefined : excerpt(text)),
    error?.code,
  );
}

export class HttpClient {
  constructor(
    readonly base = "/api",
    private readonly fetch: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  private async reach(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetch(`${this.base}${path}`, init);
    } catch (cause) {
      // The server is not answering. Saying so is the whole point: the alternative is a UI that
      // looks like an empty library rather than one that cannot be reached.
      throw new ApiError(
        "Could not reach the server",
        0,
        cause instanceof Error ? cause.message : undefined,
      );
    }
  }

  async send<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.reach(path, init);
    const text = await res.text();
    if (!res.ok) throw refusal(res, text);
    const { body, parsed } = parseJson(text);
    if (!parsed)
      throw new ApiError(
        "The server did not answer with JSON",
        res.status,
        excerpt(text) || "The response was empty.",
      );
    return body as T;
  }

  /**
   * POST JSON and take a file back rather than JSON: the bytes and the response's headers. A
   * refusal is still the API's JSON error, and is thrown as `send` throws it.
   */
  async postForFile(path: string, body: unknown): Promise<{ blob: Blob; headers: Headers }> {
    const res = await this.reach(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw refusal(res, await res.text());
    return { blob: await res.blob(), headers: res.headers };
  }

  get<T>(path: string): Promise<T> {
    return this.send<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>(path, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Change part of something: what the body leaves out is left alone. */
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** `multipart/form-data`: the file under `file`, and only the fields that have something in them. */
  postForm<T>(path: string, file: File, fields: Record<string, string | undefined>): Promise<T> {
    const form = new FormData();
    form.set("file", file);
    for (const [k, v] of Object.entries(fields)) if (v?.trim()) form.set(k, v.trim());
    return this.send<T>(path, { method: "POST", body: form });
  }

  delete<T>(path: string): Promise<T> {
    return this.send<T>(path, { method: "DELETE" });
  }
}

/** A path segment, made safe. */
export const seg = (s: string): string => encodeURIComponent(s);
