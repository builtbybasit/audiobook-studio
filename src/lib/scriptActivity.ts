// What a scripting profile has been through, read off its settled requests in the server's ledger.
//
// The ledger keeps every request a scripting job sent — what it cost, how long it took, and the
// error it ended on — so the Scripting page's health dot, its activity figures and the estimate's
// observed cache rate are all ways of looking at one profile's rows rather than counters of their
// own. Nothing here keeps state: each figure is worked out again from the rows it is handed, which
// arrive newest first, as the server sends them (`usageService().requests`).
import { OPS_DEFAULTS } from "@/lib/endpointShapes";
import { observedCacheRate } from "@/lib/pricing";
import type { Profile, ReasoningEffort, RequestRecord, ScriptEndpointTelemetry } from "@/types";
import { unusedTelemetry } from "@/lib/scripting";

/** How many of the latest requests the latency history keeps: what the sparkline has room for. */
const HISTORY = 30;

/** How many of the latest priced requests the observed cache rate is read from. */
const CACHE_SAMPLE = 40;

/** How many of the latest requests at the endpoint's reasoning level its thinking share is read from. */
export const REASONING_SAMPLE = 20;

/** A request that has an outcome; one still queued or running says nothing about the profile yet. */
const settled = (r: RequestRecord): boolean => r.status === "done" || r.status === "failed";

const at = (r: RequestRecord): number => r.finishedAt ?? r.queuedAt;

/**
 * A profile's telemetry from its settled requests, newest first.
 *
 * A request that ended on a rate limit leaves the profile cooling down for as long as the
 * provider asked — its `Retry-After`, or the profile's own cooldown when it named none — unless a
 * later request has already gone through. A profile with no requests reads exactly as one nothing
 * has been sent to, so its health stays "Not used yet".
 */
export function scriptTelemetry(
  rows: readonly RequestRecord[],
  p: Pick<Profile, "model" | "baseUrl" | "cooldownSec" | "reasoning">,
): ScriptEndpointTelemetry {
  const done = rows.filter(settled);
  const telemetry = unusedTelemetry();
  if (!done.length) return telemetry;
  const ok = done.filter((r) => r.status === "done");
  telemetry.completed = ok.length;
  telemetry.failures = done.length - ok.length;
  telemetry.rateLimits = done.filter((r) => r.rateLimited).length;
  telemetry.lastSuccess = ok.length ? Math.max(...ok.map(at)) : 0;
  telemetry.history = done
    .slice(0, HISTORY)
    .reverse()
    .map((r) => ({ at: at(r), ms: r.responseMs, ok: r.status === "done" }));
  const failed = done.find((r) => r.status === "failed" && r.error);
  if (failed?.error)
    telemetry.lastError = {
      code: failed.error.code,
      message: failed.error.message,
      body: failed.error.body,
      at: failed.error.at ?? at(failed),
      bookId: failed.bookId,
      chapterId: failed.chapterId,
      // the ledger does not say which model a request went to; the profile's is the one it names
      model: p.model,
      baseUrl: p.baseUrl,
    };
  const latest = done[0];
  if (latest.status === "failed" && latest.rateLimited) {
    const wait = latest.error?.retryAfter ?? p.cooldownSec ?? OPS_DEFAULTS.scripting.cooldownSec;
    telemetry.backoffUntil = at(latest) + wait * 1000;
  }
  const reasoning = recentReasoning(done, p.reasoning);
  if (reasoning) telemetry.reasoning = reasoning;
  return telemetry;
}

/**
 * What a profile's recent answered requests spent thinking, as a share of their input tokens —
 * only those sent at `level`, the one it is set to now, and only those whose provider said how
 * many of the output tokens were reasoning. Null until one did. A level changed since is a new
 * model as far as thinking goes, so its older requests say nothing about it.
 */
export function recentReasoning(
  rows: readonly RequestRecord[],
  level: ReasoningEffort | null | undefined,
): { perInputToken: number; requests: number } | null {
  const sample = rows
    .filter(
      (r) =>
        r.status === "done" &&
        (r.reasoningEffort ?? null) === (level ?? null) &&
        r.usage.reasoningTokens != null &&
        (r.usage.inputTokens ?? 0) > 0,
    )
    .slice(0, REASONING_SAMPLE);
  if (!sample.length) return null;
  const input = sample.reduce((n, r) => n + r.usage.inputTokens!, 0);
  const thinking = sample.reduce((n, r) => n + r.usage.reasoningTokens!, 0);
  return { perInputToken: thinking / input, requests: sample.length };
}

/** What a profile's requests used and cost, all books together. */
export function scriptUsageTotals(rows: readonly RequestRecord[]): {
  input: number;
  output: number;
  cost: number;
} {
  return rows.reduce(
    (n, r) => ({
      input: n.input + (r.usage.inputTokens ?? 0),
      output: n.output + (r.usage.outputTokens ?? 0),
      cost: n.cost + (r.cost ?? 0),
    }),
    { input: 0, output: 0, cost: 0 },
  );
}

/**
 * How much of the input a profile's recent requests actually had cached, from the receipts they
 * were priced on. The rule — only requests that reported cache detail count — is
 * `observedCacheRate`'s; this only decides which requests to ask it about.
 */
export function recentCacheRate(
  rows: readonly RequestRecord[],
): { hitRate: number; samples: number } | null {
  return observedCacheRate(
    rows
      .filter((r) => r.priced)
      .slice(0, CACHE_SAMPLE)
      .map((r) => r.priced!.usage),
  );
}
