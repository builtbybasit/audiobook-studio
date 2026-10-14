// Domain refusals, turned into HTTP once, in `app.onError`, so a route, a job or a test can throw
// them. `code` is stable, `message` is shown as is, `detail` is the expandable explanation.
import type { ApiErrorCode } from "@/types";

export type ErrorCode = ApiErrorCode;

export type ErrorStatus = 400 | 403 | 404 | 409 | 413 | 415 | 416 | 500 | 502 | 503;

const CODES: Record<ErrorStatus, ErrorCode> = {
  400: "bad_request",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  415: "unsupported_media",
  416: "range_not_satisfiable",
  500: "internal",
  // a provider refused or failed; the message names it and what it answered
  502: "upstream",
  // a tool this machine lacks (uv, for voice effects)
  503: "unavailable",
};

/** For a status this API didn't choose itself: any other 4xx is the request's fault. */
export const codeFor = (status: number): ErrorCode =>
  CODES[status as ErrorStatus] ?? (status >= 400 && status < 500 ? "bad_request" : "internal");

/** The one error shape the API returns. */
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

export function fail(status: ErrorStatus, message: string, detail?: string): never {
  throw new AppError(status, message, detail);
}
