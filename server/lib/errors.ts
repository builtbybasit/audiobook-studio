// What a refusal is, before it is an HTTP response.
//
// A domain operation says *what* went wrong — no such book, a volume already waiting in the review,
// a script that changed under a job — and nothing else. Turning that into a status code and a JSON
// body happens once, in `app.onError`, so a rule can be thrown from a route, a job or a test and
// mean the same thing in each. The `code` is stable and machine-readable; the `message` is meant to
// be shown as it stands; `detail` is the longer explanation a panel can expand to.
import type { ApiErrorCode } from "@/types";

export type ErrorCode = ApiErrorCode;

export type ErrorStatus = 400 | 403 | 404 | 409 | 413 | 415 | 500;

const CODES: Record<ErrorStatus, ErrorCode> = {
  400: "bad_request",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  415: "unsupported_media",
  500: "internal",
};

/** The code for a status this API did not choose itself: any other 4xx is the request's fault. */
export const codeFor = (status: number): ErrorCode =>
  CODES[status as ErrorStatus] ?? (status >= 400 && status < 500 ? "bad_request" : "internal");

/** What a failure looks like on the wire. One shape for every error the API returns. */
export interface ApiError {
  error: { code: ErrorCode; message: string; detail?: string };
}

export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: ErrorCode;
  constructor(
    readonly status: ErrorStatus,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.code = CODES[status];
  }

  body(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail ? { detail: this.detail } : {}),
      },
    };
  }
}

export const badRequest = (message: string, detail?: string): AppError =>
  new AppError(400, message, detail);
export const notFound = (message: string, detail?: string): AppError =>
  new AppError(404, message, detail);
export const conflict = (message: string, detail?: string): AppError =>
  new AppError(409, message, detail);

/** Fail this request with a message the UI can show as it stands. */
export function fail(status: ErrorStatus, message: string, detail?: string): never {
  throw new AppError(status, message, detail);
}
