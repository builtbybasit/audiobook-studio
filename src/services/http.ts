// The one HTTP client and error every service uses over the wire.
import { API_BASE } from "@/services/mode";
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

/** Narrower than `typeof fetch` (whose extras vary by runtime), so a test can pass a function. */
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

// Something other than the API (a proxy, a dev server) may answer with HTML; parsing it must not
// throw a `SyntaxError` out of a method whose contract is to throw `ApiError`.
function parseJson(text: string): { body: unknown; parsed: boolean } {
  try {
    return { body: text ? JSON.parse(text) : null, parsed: true };
  } catch {
    return { body: null, parsed: false };
  }
}

const UNREACHABLE = "Could not reach the server";

// The API's own 502 carries an error code; one without is the proxy in front of it (e.g. the dev
// proxy with the server down), reported as unreachable.
const GATEWAY = new Set([502, 503, 504]);

/** Nothing listening (status 0), or a proxy in front that could not reach the API. */
export const unreachable = (cause: unknown): boolean =>
  cause instanceof ApiError && (cause.status === 0 || (!cause.code && GATEWAY.has(cause.status)));

/** A response that is not ok, as the error the API's JSON body describes. */
function refusal(res: Response, text: string): ApiError {
  const { body, parsed } = parseJson(text);
  const { error } = (parsed ? (body ?? {}) : {}) as ErrorBody;
  if (!error?.code && GATEWAY.has(res.status))
    return new ApiError(
      UNREACHABLE,
      res.status,
      excerpt(text) || `The proxy in front of the API answered ${res.status} with nothing else.`,
    );
  return new ApiError(
    error?.message ?? `Request failed (${res.status})`,
    res.status,
    error?.detail ?? (parsed ? undefined : excerpt(text)),
    error?.code,
  );
}

export class HttpClient {
  constructor(
    readonly base = API_BASE,
    private readonly fetch: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  private async reach(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetch(`${this.base}${path}`, init);
    } catch (cause) {
      // a request the page cancelled was not the server failing to answer
      if (init?.signal?.aborted) throw init.signal.reason;
      // Say so, or the UI looks like an empty library instead of an unreachable one.
      throw new ApiError(UNREACHABLE, 0, cause instanceof Error ? cause.message : undefined);
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

  /** POST JSON and take a file back, with its headers. A refusal is still the API's JSON error. */
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

  /** A refusal is still the API's JSON error. */
  async getBlob(path: string): Promise<Blob> {
    const res = await this.reach(path);
    if (!res.ok) throw refusal(res, await res.text());
    return res.blob();
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

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** The file under `file`, and only the non-blank fields. */
  postForm<T>(path: string, file: File, fields: Record<string, string | undefined>): Promise<T> {
    const form = new FormData();
    form.set("file", file);
    for (const [k, v] of Object.entries(fields)) if (v?.trim()) form.set(k, v.trim());
    return this.postFormData<T>(path, form);
  }

  postFormData<T>(path: string, form: FormData): Promise<T> {
    return this.send<T>(path, { method: "POST", body: form });
  }

  delete<T>(path: string): Promise<T> {
    return this.send<T>(path, { method: "DELETE" });
  }
}

export const seg = (s: string): string => encodeURIComponent(s);
