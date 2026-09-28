// One request to a real provider, with the endpoint's own timeout and retries.
//
// Every provider — the scripting model and each speech API alike — needs the same few things
// around a `fetch`, and none of them is the provider's business: a wall clock per attempt
// (`timeoutSec`), another attempt after a failure that another attempt can fix (`maxRetries`), a
// wait before it that a 429 may name (`Retry-After`, or `cooldownSec` when it does not), and an
// error a person can read that never carries the key. A provider that refuses inside a 200 —
// MiniMax does — hands over a `check` that reads the answer before it is accepted, so such a
// refusal is retried in the same loop as a 429 is. A cancel is none of those: it stops at once,
// mid-request or mid-wait, and throws the job's own reason, so the runner records it as cancelled
// rather than failed.
import { sleep } from "~/providers/fake";
import type { ProviderTarget } from "~/providers/target";

/**
 * A provider answered, and the answer was a refusal. `status` is the HTTP status, or the provider's
 * own code when it refused inside a 200 (MiniMax's `base_resp`), or 0 for no answer at all.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * Whether another attempt could go differently: a rate limit, a server fault, a timeout. `call`
     * retries on it; the routes answer a 502 rather than a 400 for it; the job does not read it.
     */
    readonly retryable: boolean,
    /** a refusal inside a 200 that says it is a rate limit, as a 429 would */
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Statuses another attempt may fix. A 4xx other than these is the request, and will be again — a
 * 409 among them: a conflict is not resolved by sending the same thing twice.
 */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** The most of a refusal's body worth putting in a message. */
const BODY_CHARS = 300;

/** How long a `Retry-After` asks for, in ms: seconds or an HTTP date; undefined if neither. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** What a validation error's list of problems says: FastAPI's `[{loc, msg}]`, as ElevenLabs sends. */
const listed = (detail: unknown[]): string | undefined =>
  detail
    .map((d) => (d && typeof d === "object" ? (d as { msg?: unknown }).msg : d))
    .filter((m): m is string => typeof m === "string" && !!m.trim())
    .join("; ") || undefined;

/**
 * What a refusal says about itself, trimmed: `{error:{message}}`, `{error}`, `{message}`,
 * `{detail}` — which ElevenLabs sends as `{detail:{message}}`, and as `{detail:[{msg}]}` on a 422 —
 * or the text.
 */
async function refusal(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).trim();
  let said = text;
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
  } catch {
    // not JSON: the text itself is what it said
  }
  said = said.replace(/\s+/g, " ");
  return said.length > BODY_CHARS ? said.slice(0, BODY_CHARS) + "…" : said;
}

export interface CallOptions {
  /** the job's signal; a cancel stops the attempt and the wait between attempts alike */
  signal: AbortSignal;
  /** injected by tests; the real one otherwise */
  fetch?: typeof fetch;
  /** the wait before attempt `n` (1-based) when the answer named none; tests make it 0 */
  backoffMs?: (attempt: number, target: ProviderTarget) => number;
  /**
   * Filled in as the call goes, for the ledger: how many attempts went out and whether any was
   * refused with a 429. Written whether the call answers or throws, so a provider that reports a
   * failed request can say how hard it tried.
   */
  stats?: CallStats;
  /**
   * Reads a 2xx before it is accepted, for a provider that refuses inside one: the refusal it
   * finds, or null to accept the answer. Handed a clone, so the answer is still there to read
   * after. A refusal is treated as a refused status is — retried when it is `retryable`, after
   * `cooldownSec` when it is `rateLimited` — and thrown once the retries run out.
   */
  check?(res: Response): Promise<ProviderError | null>;
  /**
   * Told each time an attempt is refused as rate limited — a 429, or a `check` that says so — with
   * how long this call will wait before its next attempt: the `Retry-After`, or `cooldownSec`. The
   * narration job hands it to the speech gate, which holds every other line for the endpoint as
   * long (`gate.ts`). Told even when no attempt is left, because the endpoint is limited either way.
   */
  rateLimited?(waitMs: number): void;
  /**
   * The attempt's clock stops once the answer's headers are in, rather than running on over its
   * body — for an answer read as a long stream, whose reader keeps its own clock between the parts
   * that arrive (`speech/batch.ts`). Otherwise the clock covers the body too, so a body that stalls
   * is cut off like an answer that never came.
   */
  headersOnly?: boolean;
}

/** What one `call` did on the wire; see `CallOptions.stats`. */
export interface CallStats {
  attempts: number;
  rateLimited: boolean;
}

const defaultBackoff = (attempt: number, t: ProviderTarget): number =>
  Math.min(t.cooldownSec * 1000, 500 * 2 ** (attempt - 1));

/**
 * Send `init` to `url` until it answers with a success, the endpoint's retries run out, or the job
 * is cancelled. Answers the successful `Response`; throws a `ProviderError` naming the endpoint and
 * the last status otherwise, or the signal's reason on a cancel.
 */
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
    // for `headersOnly`, what the request is sent under: the clock, until it is cut loose below
    const untilHeaders = options.headersOnly ? new AbortController() : null;
    const expire = (): void => untilHeaders?.abort(clock.reason);
    if (untilHeaders) clock.addEventListener("abort", expire, { once: true });
    let wait: number | undefined;
    /** the wait a rate limit asked for, told after the attempt so a listener's throw is its own */
    let limited: number | undefined;
    try {
      const res = await send(url, {
        ...init,
        signal: AbortSignal.any([signal, untilHeaders?.signal ?? clock]),
      });
      if (res.ok) {
        const refused = options.check ? await options.check(res.clone() as Response) : null;
        if (!refused) {
          // accepted: a refusal's body is read under the clock, an accepted one's the caller's to time
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
        if (res.status === 429 && options.stats) options.stats.rateLimited = true;
        const said = await refusal(res);
        last = new ProviderError(
          `${target.name} answered ${res.status}${said ? `: ${said}` : ""}`,
          res.status,
          RETRYABLE.has(res.status),
        );
        wait = retryAfterMs(res.headers.get("retry-after"));
        if (res.status === 429) {
          wait ??= target.cooldownSec * 1000;
          limited = wait;
        }
      }
    } catch (e) {
      if (signal.aborted) throw signal.reason;
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

/** The key as a bearer token, when there is one — alone, for a body that types itself: a form. */
export function authHeaders(target: ProviderTarget): Record<string, string> {
  return target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {};
}

/** The headers every JSON request carries, the key among them when there is one. */
export function jsonHeaders(target: ProviderTarget): Record<string, string> {
  return { "content-type": "application/json", ...authHeaders(target) };
}

/** A target that needs a key and has none fails before any request, saying where to put one. */
export function requireKey(target: ProviderTarget): void {
  if (target.needsKey && !target.apiKey)
    throw new ProviderError(
      `${target.name} needs an API key, and none is saved for it. Add one on the Endpoints page.`,
      0,
      false,
    );
}
