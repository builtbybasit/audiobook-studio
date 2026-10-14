// A scripting profile's telemetry, worked out from its ledger rows (newest first, as
// `usageService().requests` sends them) rather than kept as counters.
import { OPS_DEFAULTS } from "@/lib/endpointShapes";
import { observedCacheRate } from "@/lib/pricing";
import type { Profile, ReasoningEffort, RequestRecord, ScriptEndpointTelemetry } from "@/types";
import { unusedTelemetry } from "@/lib/scripting";

/** What the sparkline has room for. */
const HISTORY = 30;

const CACHE_SAMPLE = 40;

export const REASONING_SAMPLE = 20;

const settled = (r: RequestRecord): boolean => r.status === "done" || r.status === "failed";

const at = (r: RequestRecord): number => r.finishedAt ?? r.queuedAt;

/** A rate-limited latest request cools the profile down for `Retry-After` or its cooldown. */
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
      // the ledger does not record the model
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
 * Thinking tokens per input token over recent requests at `level` that reported reasoning. Null
 * until one did; requests at another level say nothing about this one.
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
