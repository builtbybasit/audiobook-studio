// The usage ledger, between rows and the shapes the Endpoints page reads.
// Append-only: a settled request is never updated.
import type { RequestRecord, RequestUsage } from "@/types";
import type { requests } from "~/db/schema";

type RequestRow = typeof requests.$inferSelect;

/** What one request used. Absent means nobody counted it, which is never zero. */
function toUsage(row: RequestRow): RequestUsage {
  return {
    ...(row.inputTokens != null ? { inputTokens: row.inputTokens } : {}),
    ...(row.outputTokens != null ? { outputTokens: row.outputTokens } : {}),
    ...(row.cachedInput != null ? { cachedInput: row.cachedInput } : {}),
    ...(row.cacheWrite != null ? { cacheWrite: row.cacheWrite } : {}),
    ...(row.reasoningTokens != null ? { reasoningTokens: row.reasoningTokens } : {}),
    ...(row.chars != null ? { chars: row.chars } : {}),
    ...(row.bytes != null ? { bytes: row.bytes } : {}),
    ...(row.textTokens != null ? { textTokens: row.textTokens } : {}),
    ...(row.audioSeconds != null ? { audioSeconds: row.audioSeconds } : {}),
    ...(row.audioTokens != null ? { audioTokens: row.audioTokens } : {}),
  };
}

/**
 * Rebuild a request from its row. The row keeps the chapter's uid; the caller joins today's
 * `chapterId`, null for no chapter or a removed one.
 */
export function toRequestRecord(row: RequestRow, chapterId: number | null = null): RequestRecord {
  const r: RequestRecord = {
    id: row.id,
    endpointId: row.endpointId,
    kind: row.kind,
    bookId: row.bookId,
    chapterId,
    label: row.label,
    status: row.status,
    attempts: row.attempts,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    queueMs: row.queueMs,
    responseMs: row.responseMs,
    usage: toUsage(row),
    cost: row.cost,
    costBasis: row.costBasis,
    simulated: row.simulated,
  };
  if (row.reasoningEffort != null) r.reasoningEffort = row.reasoningEffort;
  if (row.waiting != null) r.waiting = row.waiting;
  if (row.priced != null) r.priced = row.priced;
  if (row.speech != null) r.speech = row.speech;
  if (row.rateLimited) r.rateLimited = true;
  if (row.error != null) r.error = row.error;
  return r;
}

/** Flatten a request for insertion; `chapterUid` is the chapter's stable id. */
export function requestValues(
  r: RequestRecord,
  chapterUid: string | null = null,
): typeof requests.$inferInsert {
  const u = r.usage;
  return {
    id: r.id,
    endpointId: r.endpointId,
    kind: r.kind,
    bookId: r.bookId,
    chapterUid,
    label: r.label,
    status: r.status,
    attempts: r.attempts,
    queuedAt: r.queuedAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    queueMs: r.queueMs,
    responseMs: r.responseMs,
    waiting: r.waiting ?? null,
    rateLimited: r.rateLimited ?? null,
    inputTokens: u.inputTokens ?? null,
    outputTokens: u.outputTokens ?? null,
    cachedInput: u.cachedInput ?? null,
    cacheWrite: u.cacheWrite ?? null,
    reasoningTokens: u.reasoningTokens ?? null,
    reasoningEffort: r.reasoningEffort ?? null,
    chars: u.chars ?? null,
    bytes: u.bytes ?? null,
    textTokens: u.textTokens ?? null,
    audioSeconds: u.audioSeconds ?? null,
    audioTokens: u.audioTokens ?? null,
    cost: r.cost,
    costBasis: r.costBasis,
    priced: r.priced ?? null,
    speech: r.speech ?? null,
    error: r.error ?? null,
    simulated: r.simulated,
  };
}
