// The usage ledger: prices each sent request with `@/lib/pricing` at the rates in force when it
// completed, and appends it. Rows are never updated (see `~/db/schema/usage.ts`). Totals are read
// here too, summed in SQL over every row in range, so they match the Activity list.
import {
  and,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  sql,
  sum,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";

import type { CloneFee } from "@/lib/providers";
import { REASONING_SAMPLE, recentReasoning } from "@/lib/scriptActivity";
import type {
  BookSpend,
  Endpoint,
  EndpointKind,
  MetricBucket,
  MetricTotals,
  Profile,
  RangeKey,
  ReasoningEffort,
  ReqError,
  RequestRecord,
  RequestStatus,
  RequestUsage,
  ScriptEndpointTelemetry,
  SpeechCharge,
  Transcriber,
  TtsBilling,
} from "@/types";
import { billingOf } from "@/lib/endpoints";
import { RANGES, recordAt, type EndpointSummary, type RequestPage } from "@/services/endpoints";
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
import { chapters, cloneFees, jobs, openingSpend, requests } from "~/db/schema";
import type { SentScript, SentSpeech, SentTranscription } from "~/providers/sent";

type Sent = SentScript | SentSpeech | SentTranscription;

/** Which work a request was for. The chapter by its uid, which a renumbering never moves. */
export interface RequestFor {
  /** null for a request no book asked for (a voice sample on the Endpoints page) */
  bookId: string | null;
  chapterUid: string | null;
  /** frozen, so it still reads after the chapter is gone */
  label: string;
  /** when the work was asked for; the request's own start when it went straight out */
  queuedAt?: number;
  /** `<endpoint id>/<voice id>`; a clone's first billed line settles a first-use fee. */
  voiceRef?: string;
  /** The reasoning level the run was queued with, not the profile's now. */
  reasoning?: ReasoningEffort | null;
  /** The undiscounted worst case held against budgets; counted in place of an unknown cost. */
  held?: number;
  /** The card charges nothing, so an unknowable cost is $0. Absent, `held === 0` says so. */
  free?: boolean;
}

/** A charge nobody can work out is unknown (null), never $0, unless the card charges nothing. */
const unknownCost = (work: RequestFor): number | null =>
  (work.free ?? work.held === 0) ? 0 : null;

const errorOf = (sent: Sent): ReqError | undefined =>
  sent.error
    ? {
        code: sent.error.code,
        message: sent.error.message,
        body: sent.error.body ?? "",
        at: sent.finishedAt,
      }
    : undefined;

/** Append a request whose receipt is already decided; jobs go through the `settle*` functions. */
export function append(
  db: Db | Tx,
  r: Omit<RequestRecord, "id" | "chapterId">,
  chapterUid: string | null,
  held?: number,
): RequestRecord {
  const record: RequestRecord = { ...r, id: crypto.randomUUID(), chapterId: null };
  db.insert(requests)
    .values({ ...requestValues(record, chapterUid), held: r.cost == null ? held : null })
    .run();
  return record;
}

function timing(sent: Sent, work: RequestFor) {
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
 * Price a scripting request and append it. No usage: a refusal costs $0 (errors aren't billed), an
 * answered or cancelled one is unknown. A provider-reported cost (OpenRouter) wins over the card's.
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
        preferReported: sent.usage.reportedCost != null,
      })
    : undefined;
  const usage: RequestUsage = sent.usage
    ? {
        inputTokens: sent.usage.inputTokens,
        outputTokens: sent.usage.outputTokens,
        ...(sent.usage.cachedInput != null ? { cachedInput: sent.usage.cachedInput } : {}),
        ...(sent.usage.cacheWrite != null ? { cacheWrite: sent.usage.cacheWrite } : {}),
        ...(sent.usage.reasoningTokens != null
          ? { reasoningTokens: sent.usage.reasoningTokens }
          : {}),
      }
    : {};
  const error = errorOf(sent);
  const code = sent.error?.code ?? 0;
  const mayHaveBilled = sent.status !== "failed" || (code >= 200 && code < 300);
  const cost = priced ? priced.total : mayHaveBilled ? unknownCost(work) : 0;
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
      ...(work.reasoning ? { reasoningEffort: work.reasoning } : {}),
      cost,
      costBasis: priced ? priced.basis : cost == null ? "unknown" : "calculated",
      ...(priced ? { priced } : {}),
      ...(sent.rateLimited ? { rateLimited: true } : {}),
      ...(error ? { error } : {}),
      simulated: sent.simulated,
    },
    work.chapterUid,
    work.held,
  );
}

/**
 * Price a speech request and append it. Unbilled (`sent.billed` false) costs $0, units kept;
 * billed-but-failed is charged for what it sent or the audio it reported; cancelled is unknown.
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
  const priced = priceSpeechRequest(billing, readPricing(endpoint), units, {
    at: sent.finishedAt,
    rule: PRICING_RULE,
    reported: sent.reported,
  });
  const charge = chargeOf(priced, sent, work);
  const error = errorOf(sent);
  if (sent.billed && sent.status === "done" && work.voiceRef)
    settleFirstUse(db, endpoint, work.voiceRef, sent.finishedAt);
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
      // every quantity, not only the billed one, so a later billing-model change can compare
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
    work.held,
  );
}

/** Price a transcription request per audio minute; unbilled and cancelled as for speech. */
export function settleTranscription(
  db: Db | Tx,
  transcriber: Transcriber,
  work: RequestFor,
  sent: SentTranscription,
): RequestRecord {
  const billing: TtsBilling = { unit: "minute", rate: transcriber.perMinute };
  const units = measureSpeech({ text: "", audioSeconds: sent.audioSeconds }, billing);
  const priced = priceSpeechRequest(billing, readPricing(transcriber), units, {
    at: sent.finishedAt,
    rule: PRICING_RULE,
  });
  const charge = chargeOf(priced, sent, work);
  const error = errorOf(sent);
  return append(
    db,
    {
      endpointId: transcriber.id,
      kind: "transcription",
      bookId: work.bookId,
      label: work.label,
      status: sent.status,
      attempts: sent.attempts,
      ...timing(sent, work),
      usage: { audioSeconds: units.audioSeconds },
      cost: charge.amount,
      costBasis: charge.basis,
      speech: charge,
      ...(sent.rateLimited ? { rateLimited: true } : {}),
      ...(error ? { error } : {}),
      simulated: sent.simulated,
    },
    work.chapterUid,
    work.held,
  );
}

// ---------- what a cloned voice costs ----------

/** A clone fee row, on the endpoint, not a book. Cancelled: unknown cost, holding the fee. */
function appendFee(
  db: Db | Tx,
  endpoint: Pick<Endpoint, "id">,
  fee: Pick<CloneFee, "usd" | "said">,
  label: string,
  at: number,
  status: "done" | "cancelled" = "done",
): RequestRecord {
  // a fee priced in plan credits has no `usd`, so its cost is unknown
  const cost = status === "cancelled" ? null : fee.usd;
  return append(
    db,
    {
      endpointId: endpoint.id,
      kind: "tts",
      bookId: null,
      label: `${label} · ${fee.said}`,
      status,
      attempts: 1,
      queuedAt: at,
      startedAt: at,
      finishedAt: at,
      queueMs: 0,
      responseMs: 0,
      usage: {},
      cost,
      costBasis: cost == null ? "unknown" : "calculated",
      simulated: false,
    },
    null,
    fee.usd ?? undefined,
  );
}

/** Charge `cloning.fee` now when charged on making, else park it for the voice's first line. */
export function settleClone(
  db: Db,
  endpoint: Pick<Endpoint, "id">,
  voice: { id: string; title: string },
  fee: CloneFee | null,
  at = Date.now(),
): void {
  if (!fee) return;
  if (fee.when === "made") {
    appendFee(db, endpoint, fee, `Voice made · ${voice.title}`, at);
    return;
  }
  db.insert(cloneFees)
    .values({
      endpointId: endpoint.id,
      voiceId: voice.id,
      title: voice.title,
      usd: fee.usd,
      said: fee.said,
      madeAt: at,
    })
    .onConflictDoNothing()
    .run();
}

/**
 * A clone cancelled after upload may still have been made: an unknown-cost row when charged on
 * making. Charged at first use, there is nothing to record (no voice id, never spoken).
 */
export function settleCancelledClone(
  db: Db,
  endpoint: Pick<Endpoint, "id">,
  title: string,
  fee: CloneFee | null,
  at = Date.now(),
): void {
  if (fee?.when === "made") appendFee(db, endpoint, fee, `Voice made · ${title}`, at, "cancelled");
}

function settleFirstUse(db: Db | Tx, endpoint: Endpoint, voiceRef: string, at: number): void {
  const prefix = `${endpoint.id}/`;
  if (!voiceRef.startsWith(prefix)) return;
  const voiceId = voiceRef.slice(prefix.length);
  const where = and(eq(cloneFees.endpointId, endpoint.id), eq(cloneFees.voiceId, voiceId));
  // delete + append in one transaction, so two lines settling at once charge it once
  db.transaction((tx) => {
    const waiting = tx.delete(cloneFees).where(where).returning().get();
    if (waiting) appendFee(tx, endpoint, waiting, `Voice first spoken · ${waiting.title}`, at);
  });
}

/** What a receipt says of a request the provider does not charge for. */
export const NOT_BILLED =
  "not billed: the provider charges nothing for a request it refused or never answered";

/** What a receipt says of a request cancelled once it was out. */
export const CANCELLED =
  "cancelled once it was out: whether the provider charged for it, and how much, is not known";

function chargeOf(
  priced: SpeechCharge,
  sent: SentSpeech | SentTranscription,
  work: RequestFor,
): SpeechCharge {
  if (sent.status === "cancelled") return unknownCost(work) === 0 ? priced : uncertain(priced);
  return sent.billed ? priced : unbilled(priced);
}

/** Same lines at $0, each saying why, so the row still shows what it would have cost. */
function unbilled(charge: SpeechCharge): SpeechCharge {
  return {
    ...charge,
    lines: charge.lines.map((l) => ({ ...l, amount: 0, note: NOT_BILLED })),
    amount: 0,
    basis: "calculated",
    unknowns: [],
  };
}

/** Same lines, no total; the budgets count the row's `held` instead. */
function uncertain(charge: SpeechCharge): SpeechCharge {
  return {
    ...charge,
    lines: charge.lines.map((l) => ({ ...l, note: CANCELLED })),
    amount: null,
    basis: "unknown",
    unknowns: [CANCELLED],
  };
}

/** Ledger rows keep the chapter's uid, which survives renumbering. */
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
 * A book's spending from the ledger and unfinished jobs. `exceptJob` leaves that job's reservation
 * out. An unknown cost counts at its `held` and as one of the `unpriced`.
 */
export function bookSpend(db: Db | Tx, bookId: string, exceptJob?: number): BookSpend {
  const byKind = db
    .select({
      kind: requests.kind,
      cost: sum(sql`coalesce(${requests.cost}, ${requests.held})`).mapWith(Number),
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
    // every kind, transcription included
    spent: byKind.reduce((n, r) => n + (r.cost ?? 0), 0) + opening,
    scriptSpent,
    speechSpent,
    opening,
    reserved: held.reduce((n, r) => n + (r.reserved ?? 0), 0),
    scriptReserved: heldBy("scripting"),
    unpriced: byKind.reduce((n, r) => n + Number(r.unpriced ?? 0), 0),
  };
}

/** When a row happened; must match `recordAt` in the browser. */
const rowAt = sql<number>`coalesce(${requests.finishedAt}, ${requests.queuedAt})`;

const rowsOf = (kind: EndpointKind, endpointId: string) =>
  and(eq(requests.kind, kind), eq(requests.endpointId, endpointId));

/** An endpoint's charges since `since`, all books, for its daily limit; unknown counts `held`. */
export function endpointSpend(
  db: Db | Tx,
  kind: EndpointKind,
  endpointId: string,
  since: number,
): number {
  return (
    db
      .select({ cost: sum(sql`coalesce(${requests.cost}, ${requests.held})`).mapWith(Number) })
      .from(requests)
      .where(and(rowsOf(kind, endpointId), gte(rowAt, since)))
      .get()?.cost ?? 0
  );
}

/** Which of an endpoint's rows a page reads. */
export interface RequestWhere {
  since: number;
  /** a chart bucket: `from` inclusive, `to` exclusive */
  window?: { from: number; to: number };
  status?: RequestStatus;
  bookId?: string;
  /** case-insensitive, over label, error message and code, and chapter number */
  search?: string;
}

/** `<time>:<id>` of the page's last row, which no later append can move. */
const cursorOf = (r: RequestRecord) => `${recordAt(r)}:${r.id}`;

/**
 * A page of an endpoint's requests, newest first, with each chapter's current number (null once
 * gone). Keyset-paged on `before`, so new rows never shift later pages. No `limit`: every row.
 */
export function requestPage(
  db: Db | Tx,
  kind: EndpointKind,
  endpointId: string,
  where: RequestWhere,
  page: { before?: string; limit?: number } = {},
): RequestPage {
  const q = where.search?.trim().toLowerCase();
  const inRange = and(rowsOf(kind, endpointId), gte(rowAt, where.since));
  const matching = and(
    inRange,
    where.window ? gte(rowAt, where.window.from) : undefined,
    where.window ? lt(rowAt, where.window.to) : undefined,
    where.status ? eq(requests.status, where.status) : undefined,
    where.bookId ? eq(requests.bookId, where.bookId) : undefined,
    q
      ? sql`instr(lower(${requests.label} || ' ' || coalesce(json_extract(${requests.error}, '$.message'), '') || ' ' || coalesce(json_extract(${requests.error}, '$.code'), '') || ' ' || coalesce(${chapters.id}, '')), ${q}) > 0`
      : undefined,
  );
  const cut = page.before?.indexOf(":") ?? -1;
  const after = page.before
    ? sql`(${rowAt}, ${requests.id}) < (${Number(page.before.slice(0, cut))}, ${page.before.slice(cut + 1)})`
    : undefined;
  const rows = db
    .select({ row: requests, chapterId: chapters.id })
    .from(requests)
    .leftJoin(chapters, eq(chapters.uid, requests.chapterUid))
    .where(and(matching, after))
    .orderBy(desc(rowAt), desc(requests.id))
    .limit(page.limit ?? -1)
    .all()
    .map(({ row, chapterId }) => toRequestRecord(row, chapterId ?? null));
  const counted = (where: SQL | undefined) =>
    db
      .select({ n: count() })
      .from(requests)
      .leftJoin(chapters, eq(chapters.uid, requests.chapterUid))
      .where(where)
      .get()?.n ?? 0;
  const last = rows.at(-1);
  return {
    requests: rows,
    next: page.limit != null && rows.length === page.limit && last ? cursorOf(last) : null,
    total: counted(matching),
    of: counted(inRange),
  };
}

export const endpointRequests = (
  db: Db | Tx,
  kind: EndpointKind,
  endpointId: string,
  since: number,
): RequestRecord[] => requestPage(db, kind, endpointId, { since }).requests;

/**
 * An endpoint's chart buckets and totals over `range`, plus today's spend. Unknown costs are
 * counted apart, never as $0. Latency only from done/failed rows. Done without usage: `unreported`.
 */
export function endpointSummary(
  db: Db | Tx,
  kind: EndpointKind,
  endpointId: string,
  range: RangeKey,
  now: number,
  dayStart: number,
): EndpointSummary {
  const spec = RANGES.find((r) => r.value === range)!;
  const from = now - spec.ms;
  const width = spec.ms / spec.buckets;
  // `to` exclusive, as the Activity list filters a bucket
  const inRange = and(rowsOf(kind, endpointId), gte(rowAt, from), lt(rowAt, now));
  const bucketOf = sql<number>`cast((${rowAt} - ${from}) / ${width} as integer)`;
  const done = sql`${requests.status} = 'done'`;
  const settled = sql`${requests.status} in ('done', 'failed')`;
  // tokens for scripting, audio minutes otherwise; null when the provider did not say (not zero)
  const made =
    kind === "scripting"
      ? sql`case when ${requests.inputTokens} is null and ${requests.outputTokens} is null then null else coalesce(${requests.inputTokens}, 0) + coalesce(${requests.outputTokens}, 0) end`
      : sql`${requests.audioSeconds} / 60.0`;
  const total = (x: SQL | AnyColumn) => sql<number>`total(${x})`.mapWith(Number);
  const counted = (cond: SQL) => total(sql`case when ${cond} then 1 else 0 end`);
  const sums = {
    requests: count(),
    failures: counted(sql`${requests.status} = 'failed'`),
    rateLimits: counted(sql`${requests.rateLimited}`),
    retries: counted(sql`${requests.attempts} > 1`),
    eventualOk: counted(done),
    firstAttemptOk: counted(sql`${done} and ${requests.attempts} = 1`),
    cost: total(requests.cost),
    unknownCost: counted(sql`${requests.cost} is null`),
    settled: counted(settled),
    queueMs: total(sql`case when ${settled} then ${requests.queueMs} end`),
    responseMs: total(sql`case when ${settled} then ${requests.responseMs} end`),
    work: total(made),
    reported: counted(sql`${made} is not null`),
    unreported: counted(sql`${made} is null and ${done}`),
    providerReported: counted(sql`${requests.costBasis} = 'provider-reported'`),
    estimatedCost: counted(sql`${requests.costBasis} = 'estimated'`),
    inputTokens: total(requests.inputTokens),
    outputTokens: total(requests.outputTokens),
    // a provider silent on caching is left out of both counts, not counted as a miss
    cachedInputTokens: total(requests.cachedInput),
    cacheReportedInputTokens: total(
      sql`case when ${requests.cachedInput} is not null then coalesce(${requests.inputTokens}, 0) end`,
    ),
    cacheReported: counted(sql`${requests.cachedInput} is not null`),
    chars: total(requests.chars),
    audioSeconds: total(requests.audioSeconds),
  };
  const all = db.select(sums).from(requests).where(inRange).get()!;
  const byBucket = new Map(
    db
      .select({ bucket: bucketOf, ...sums })
      .from(requests)
      .where(inRange)
      .groupBy(bucketOf)
      .all()
      .map((s) => [s.bucket, s]),
  );

  // nearest-rank p95 of response times, per bucket or over the range; on a handful it's the max
  const p95 = (partition?: SQL) => {
    const over = partition ? sql`partition by ${partition}` : sql``;
    const ranked = db
      .select({
        bucket: sql<number>`${bucketOf}`.as("bucket"),
        ms: requests.responseMs,
        rank: sql<number>`row_number() over (${over} order by ${requests.responseMs})`.as("rank"),
        of: sql<number>`count(*) over (${over})`.as("of"),
      })
      .from(requests)
      .where(and(inRange, settled))
      .as("ranked");
    return db
      .select({ bucket: ranked.bucket, ms: ranked.ms })
      .from(ranked)
      .where(sql`${ranked.rank} = min(${ranked.of}, cast(${ranked.of} * 0.95 as integer) + 1)`)
      .all();
  };
  const p95Of = new Map(p95(bucketOf).map((r) => [r.bucket, r.ms]));

  /** work per minute over the requests that reported it; unknown when some finished and none did */
  const rate = (s: typeof all | undefined, minutes: number) =>
    s?.unreported && !s.reported ? null : (s?.work ?? 0) / minutes;
  const mean = (ms: number, s: typeof all | undefined) => (s?.settled ? ms / s.settled : 0);
  const buckets: MetricBucket[] = Array.from({ length: spec.buckets }, (_, i) => {
    const s = byBucket.get(i);
    return {
      from: from + i * width,
      to: from + (i + 1) * width,
      requests: s?.requests ?? 0,
      failures: s?.failures ?? 0,
      rateLimits: s?.rateLimits ?? 0,
      retries: s?.retries ?? 0,
      firstAttemptOk: s?.firstAttemptOk ?? 0,
      eventualOk: s?.eventualOk ?? 0,
      queueMs: mean(s?.queueMs ?? 0, s),
      responseMs: mean(s?.responseMs ?? 0, s),
      p95Ms: p95Of.get(i) ?? 0,
      throughput: rate(s, width / 60_000),
      unreported: s?.unreported ?? 0,
      cost: s?.cost ?? 0,
      unknownCost: s?.unknownCost ?? 0,
    };
  });
  const { settled: _settled, work: _work, reported: _reported, ...counts } = all;
  const totals: MetricTotals = {
    ...counts,
    queueMs: mean(all.queueMs, all),
    responseMs: mean(all.responseMs, all),
    p95Ms: p95()[0]?.ms ?? 0,
    throughput: rate(all, spec.ms / 60_000),
  };

  const day = db
    .select({
      lastSeen: sql<number | null>`max(${rowAt})`,
      cost: total(sql`case when ${rowAt} >= ${dayStart} then ${requests.cost} end`),
      unknown: counted(sql`${rowAt} >= ${dayStart} and ${requests.cost} is null`),
    })
    .from(requests)
    .where(rowsOf(kind, endpointId))
    .get()!;
  return {
    series: { kind, range, from, to: now, buckets, totals },
    today: { cost: day.cost, unknown: day.unknown },
    lastSeen: day.lastSeen,
  };
}

/** Recent reasoning tokens per input token at the profile's current level, for run estimates. */
export function scriptReasoning(
  db: Db | Tx,
  profile: Pick<Profile, "id" | "reasoning">,
): ScriptEndpointTelemetry["reasoning"] | null {
  const level = profile.reasoning ?? null;
  const rows = db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.kind, "scripting"),
        eq(requests.endpointId, profile.id),
        eq(requests.status, "done"),
        isNotNull(requests.reasoningTokens),
        level == null ? isNull(requests.reasoningEffort) : eq(requests.reasoningEffort, level),
      ),
    )
    .orderBy(desc(requests.finishedAt))
    .limit(REASONING_SAMPLE)
    .all()
    .map((row) => toRequestRecord(row));
  return recentReasoning(rows, level);
}
