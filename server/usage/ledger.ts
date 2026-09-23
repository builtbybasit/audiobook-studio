// The usage ledger on the server: a request a provider sent, priced and appended.
//
// A job hands over what the provider reported (`~/providers/sent`) with the book, chapter and label
// it was for, and this module prices it with the same engine the browser uses (`@/lib/pricing`), at
// the rates in force the moment it completed, and appends the row. Nothing here updates a row:
// the receipt on it is frozen, and spending is always a sum over what has been appended — see the
// header of `~/db/schema/usage.ts`.
//
// Reading is here too, because a total that does not come from the same rows the Activity list
// shows is a second opinion about what was spent.
import { and, desc, eq, gte, isNull, sql, sum } from "drizzle-orm";

import type {
  BookSpend,
  Endpoint,
  EndpointKind,
  Profile,
  ReqError,
  RequestRecord,
  RequestUsage,
} from "@/types";
import { billingOf } from "@/lib/endpoints";
import {
  baseRates,
  measureSpeech,
  PRICING_RULE,
  priceRequest,
  priceSpeechRequest,
  readPricing,
} from "@/lib/pricing";
import type { Db, Tx } from "~/db/client";
import { toRequestRecord, requestValues } from "~/db/rows/usage";
import { chapters, jobs, openingSpend, requests } from "~/db/schema";
import type { SentScript, SentSpeech } from "~/providers/sent";

/** Which work a request was for. The chapter by its uid, which a renumbering never moves. */
export interface RequestFor {
  bookId: string;
  chapterUid: string | null;
  /** what the Activity list names it; frozen, so it still reads after the chapter is gone */
  label: string;
  /** when the work was asked for; the request's own start when it went straight out */
  queuedAt?: number;
}

const errorOf = (sent: SentScript | SentSpeech): ReqError | undefined =>
  sent.error
    ? { code: sent.error.code, message: sent.error.message, body: "", at: sent.finishedAt }
    : undefined;

function append(
  db: Db | Tx,
  r: Omit<RequestRecord, "id" | "chapterId">,
  chapterUid: string | null,
): RequestRecord {
  const record: RequestRecord = { ...r, id: crypto.randomUUID(), chapterId: null };
  db.insert(requests).values(requestValues(record, chapterUid)).run();
  return record;
}

function timing(sent: SentScript | SentSpeech, work: RequestFor) {
  const queuedAt = Math.min(work.queuedAt ?? sent.startedAt, sent.startedAt);
  return {
    queuedAt,
    startedAt: sent.startedAt,
    finishedAt: sent.finishedAt,
    queueMs: sent.startedAt - queuedAt,
    responseMs: Math.max(0, sent.finishedAt - sent.startedAt),
  };
}

/**
 * Price one scripting request against `profile`'s card and append it. A request that reported no
 * usage — it failed before the provider counted anything — costs nothing and says so: no chat
 * completion is billed for an error.
 */
export function settleScript(
  db: Db | Tx,
  profile: Profile,
  work: RequestFor,
  sent: SentScript,
): RequestRecord {
  const priced = sent.usage
    ? priceRequest(baseRates(profile), readPricing(profile), sent.usage, {
        at: sent.finishedAt,
        rule: PRICING_RULE,
      })
    : undefined;
  const usage: RequestUsage = sent.usage
    ? {
        inputTokens: sent.usage.inputTokens,
        outputTokens: sent.usage.outputTokens,
        ...(sent.usage.cachedInput != null ? { cachedInput: sent.usage.cachedInput } : {}),
        ...(sent.usage.cacheWrite != null ? { cacheWrite: sent.usage.cacheWrite } : {}),
      }
    : {};
  const error = errorOf(sent);
  return append(
    db,
    {
      endpointId: profile.id,
      kind: "scripting",
      bookId: work.bookId,
      label: work.label,
      status: sent.status,
      attempts: sent.attempts,
      ...timing(sent, work),
      usage,
      cost: priced ? priced.total : 0,
      costBasis: priced ? priced.basis : "calculated",
      ...(priced ? { priced } : {}),
      ...(sent.rateLimited ? { rateLimited: true } : {}),
      ...(error ? { error } : {}),
      simulated: sent.simulated,
    },
    work.chapterUid,
  );
}

/**
 * Price one speech request against `endpoint`'s card and append it. A failed request is still
 * charged for what it sent on an endpoint that bills what is sent — characters, bytes, requests —
 * and nothing on one that bills the audio that came back, because none did.
 */
export function settleSpeech(
  db: Db | Tx,
  endpoint: Endpoint,
  work: RequestFor,
  sent: SentSpeech,
): RequestRecord {
  const billing = billingOf(endpoint);
  const units = measureSpeech(
    { text: sent.text, instructions: sent.instructions, audioSeconds: sent.audioSeconds },
    billing,
  );
  const charge = priceSpeechRequest(billing, readPricing(endpoint), units, {
    at: sent.finishedAt,
    rule: PRICING_RULE,
    reported: sent.reported,
  });
  const error = errorOf(sent);
  return append(
    db,
    {
      endpointId: endpoint.id,
      kind: "tts",
      bookId: work.bookId,
      label: work.label,
      status: sent.status,
      attempts: sent.attempts,
      ...timing(sent, work),
      // every quantity counted, not only the billed one: an endpoint that changes billing model
      // later still has history worth comparing
      usage: {
        chars: units.chars,
        bytes: units.bytes,
        ...(units.textTokens != null ? { textTokens: units.textTokens } : {}),
        audioSeconds: units.audioSeconds,
        ...(units.audioTokens != null ? { audioTokens: units.audioTokens } : {}),
      },
      cost: charge.amount,
      costBasis: charge.basis,
      speech: charge,
      ...(sent.rateLimited ? { rateLimited: true } : {}),
      ...(error ? { error } : {}),
      simulated: sent.simulated,
    },
    work.chapterUid,
  );
}

/** The uid of chapter `chapterId` of `bookId`, which is what a ledger row keeps; null if none. */
export function chapterUidOf(db: Db | Tx, bookId: string, chapterId: number): string | null {
  return (
    db
      .select({ uid: chapters.uid })
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
      .get()?.uid ?? null
  );
}

// ---------- reading ----------

/**
 * A book's spending, from the ledger and the queue. `exceptJob` leaves one job's reservation out,
 * which is how a running job asks whether the rest of the book leaves room for what it holds.
 */
export function bookSpend(db: Db | Tx, bookId: string, exceptJob?: number): BookSpend {
  const byKind = db
    .select({
      kind: requests.kind,
      cost: sum(requests.cost).mapWith(Number),
      unpriced: sql<number>`sum(case when ${requests.cost} is null then 1 else 0 end)`,
    })
    .from(requests)
    .where(eq(requests.bookId, bookId))
    .groupBy(requests.kind)
    .all();
  const spentOn = (k: EndpointKind) => byKind.find((r) => r.kind === k)?.cost ?? 0;
  const opening =
    db
      .select({ amount: openingSpend.amount })
      .from(openingSpend)
      .where(eq(openingSpend.bookId, bookId))
      .get()?.amount ?? 0;
  const held = db
    .select({ kind: jobs.kind, reserved: sum(jobs.reserved).mapWith(Number) })
    .from(jobs)
    .where(
      and(
        eq(jobs.bookId, bookId),
        isNull(jobs.finishedAt),
        exceptJob == null ? undefined : sql`${jobs.id} <> ${exceptJob}`,
      ),
    )
    .groupBy(jobs.kind)
    .all();
  const heldBy = (k: string) => held.find((r) => r.kind === k)?.reserved ?? 0;
  const scriptSpent = spentOn("scripting");
  const speechSpent = spentOn("tts");
  return {
    spent: scriptSpent + speechSpent + opening,
    scriptSpent,
    speechSpent,
    opening,
    reserved: held.reduce((n, r) => n + (r.reserved ?? 0), 0),
    scriptReserved: heldBy("scripting"),
    unpriced: byKind.reduce((n, r) => n + Number(r.unpriced ?? 0), 0),
  };
}

/**
 * One endpoint's requests since `since`, newest first, each with the number its chapter goes by
 * today — null once the chapter is gone, when the frozen label is what still names the work.
 */
export function endpointRequests(
  db: Db | Tx,
  kind: EndpointKind,
  endpointId: string,
  since: number,
  limit = 2000,
): RequestRecord[] {
  return db
    .select({ row: requests, chapterId: chapters.id })
    .from(requests)
    .leftJoin(chapters, eq(chapters.uid, requests.chapterUid))
    .where(
      and(
        eq(requests.kind, kind),
        eq(requests.endpointId, endpointId),
        gte(requests.finishedAt, since),
      ),
    )
    .orderBy(desc(requests.finishedAt))
    .limit(limit)
    .all()
    .map(({ row, chapterId }) => toRequestRecord(row, chapterId ?? null));
}
