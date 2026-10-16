// One request to a real provider, with the endpoint's timeout, retries and 429 waits, and an error
// that never carries the key. A cancel stops at once and throws the job's own reason, so the runner
// records it as cancelled rather than failed.
import { sleep } from "~/providers/fake";
import type { ProviderTarget } from "~/providers/target";

/**
 * `status` is the HTTP status, or the provider's own code for a refusal inside a 200 (MiniMax's
 * `base_resp`), or 0 for no answer at all.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** whether another attempt could go differently; routes answer it with a 502, not a 400 */
    readonly retryable: boolean,
    /** a refusal inside a 200 that says it is a rate limit, as a 429 would */
    readonly rateLimited = false,
    /** out of credit or quota: no line after it can go either, so a run stops on it */
    readonly outOfCredit = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Any other 4xx, 409 included, is the request's fault and will be again. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const BODY_CHARS = 300;

/** A day's limit can ask for hours; the gate would hold the endpoint that long. */
const MAX_RETRY_AFTER_MS = 2 * 60_000;

/** ms; a `Retry-After` is seconds or an HTTP date. */
function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const at = Date.parse(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Number.isNaN(at) ? NaN : at - now;
  return Number.isNaN(ms) ? undefined : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

/** 402 (no credit, or not on this plan), or OpenAI's 429 for an empty balance: not a passing limit. */
const outOfCredit = (status: number, code: string | undefined): boolean =>
  status === 402 || (status === 429 && code === "insufficient_quota");

/** FastAPI's `[{loc, msg}]`, as ElevenLabs sends. */
const listed = (detail: unknown[]): string | undefined =>
  detail
    .map((d) => (d && typeof d === "object" ? (d as { msg?: unknown }).msg : d))
    .filter((m): m is string => typeof m === "string" && !!m.trim())
    .join("; ") || undefined;

/**
 * A refusal's message, trimmed: `{error:{message}}`, `{error}`, `{message}`, `{detail}` (ElevenLabs:
 * `{detail:{message}}`, or `{detail:[{msg}]}` on a 422), or the text; and OpenAI's `error.code`.
 */
async function refusal(res: Response): Promise<{ said: string; code?: string }> {
  const text = (await res.text().catch(() => "")).trim();
  let said = text;
  let code: string | undefined;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = body.error as Record<string, unknown> | string | undefined;
    const detail = body.detail;
    const found =
      (typeof error === "object" ? error?.message : error) ??
      body.message ??
      (Array.isArray(detail)
        ? listed(detail)
        : detail && typeof detail === "object"
          ? (detail as { message?: unknown }).message
          : detail);
    if (typeof found === "string") said = found;
    if (typeof error === "object" && typeof error?.code === "string") code = error.code;
  } catch {
    // not JSON
  }
  said = said.replace(/\s+/g, " ");
  return { said: said.length > BODY_CHARS ? said.slice(0, BODY_CHARS) + "…" : said, code };
}

export interface CallOptions {
  /** a cancel stops the attempt and the wait between attempts alike */
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** the wait before attempt `n` (1-based) when the answer named none; tests make it 0 */
  backoffMs?: (attempt: number, target: ProviderTarget) => number;
  /** an extra status this provider means as "try again" (Breeze-TTS-2.cpp's busy 409) */
  retryable?(status: number): boolean;
  /** filled in for the ledger whether the call answers or throws */
  stats?: CallStats;
  /**
   * For a provider that refuses inside a 2xx: reads a clone and returns the refusal, or null to
   * accept. A refusal is retried like a refused status.
   */
  check?(res: Response): Promise<ProviderError | null>;
  /**
   * Told the wait on each rate-limited attempt, even the last, so the speech gate can hold the
   * endpoint's other lines (`gate.ts`).
   */
  rateLimited?(waitMs: number): void;
  /**
   * Stop the attempt's clock once headers are in, for a long stream whose reader keeps its own
   * clock (`speech/batch.ts`). Otherwise a stalled body is cut off like no answer.
   */
  headersOnly?: boolean;
}

export interface CallStats {
  attempts: number;
  rateLimited: boolean;
  /** attempts the clock cut off: they went out, so the provider may have charged for them */
  timedOut?: number;
}

const defaultBackoff = (attempt: number, t: ProviderTarget): number =>
  Math.min(t.cooldownSec * 1000, 500 * 2 ** (attempt - 1));

/** Throws the last `ProviderError` once retries run out, or the signal's reason on a cancel. */
export async function call(
  target: ProviderTarget,
  url: string,
  init: RequestInit,
  options: CallOptions,
): Promise<Response> {
  const { signal } = options;
  const send = options.fetch ?? fetch;
  const backoff = options.backoffMs ?? defaultBackoff;
  const attempts = 1 + Math.max(0, target.maxRetries);
  let last: ProviderError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal.aborted) throw signal.reason;
    if (options.stats) options.stats.attempts = attempt;
    const clock = AbortSignal.timeout(target.timeoutSec * 1000);
    // for `headersOnly`: follows the clock until cut loose below
    const untilHeaders = options.headersOnly ? new AbortController() : null;
    const expire = (): void => untilHeaders?.abort(clock.reason);
    if (untilHeaders) clock.addEventListener("abort", expire, { once: true });
    let wait: number | undefined;
    /** told after the attempt, so a listener's throw is its own */
    let limited: number | undefined;
    try {
      const res = await send(url, {
        ...init,
        signal: AbortSignal.any([signal, untilHeaders?.signal ?? clock]),
      });
      if (res.ok) {
        const refused = options.check ? await options.check(res.clone() as Response) : null;
        if (!refused) {
          // an accepted body is the caller's to time
          clock.removeEventListener("abort", expire);
          return res;
        }
        last = refused;
        if (refused.rateLimited) {
          if (options.stats) options.stats.rateLimited = true;
          wait = target.cooldownSec * 1000;
          limited = wait;
        }
      } else {
        const { said, code } = await refusal(res);
        const broke = outOfCredit(res.status, code);
        if (res.status === 429 && !broke && options.stats) options.stats.rateLimited = true;
        last = new ProviderError(
          `${target.name} answered ${res.status}${said ? `: ${said}` : ""}`,
          res.status,
          !broke && (RETRYABLE.has(res.status) || !!options.retryable?.(res.status)),
          false,
          broke,
        );
        wait = retryAfterMs(res.headers.get("retry-after"));
        if (res.status === 429 && !broke) {
          wait ??= target.cooldownSec * 1000;
          limited = wait;
        }
      }
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      if (clock.aborted && options.stats)
        options.stats.timedOut = (options.stats.timedOut ?? 0) + 1;
      last = clock.aborted
        ? new ProviderError(`${target.name} did not answer within ${target.timeoutSec} s`, 0, true)
        : new ProviderError(
            `${target.name} could not be reached: ${e instanceof Error ? e.message : String(e)}`,
            0,
            true,
          );
    }
    if (limited !== undefined) options.rateLimited?.(limited);
    if (!last.retryable || attempt === attempts) break;
    await sleep(wait ?? backoff(attempt, target), signal);
  }
  throw last!;
}

/** Alone, for a body that sets its own content type (a form). */
export function authHeaders(target: ProviderTarget): Record<string, string> {
  return target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {};
}

export function jsonHeaders(target: ProviderTarget): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders(target) };
}

export function requireKey(target: ProviderTarget): void {
  if (target.needsKey && !target.apiKey)
    throw new ProviderError(
      `${target.name} needs an API key, and none is saved for it. Add one on the Endpoints page.`,
      0,
      false,
    );
}
