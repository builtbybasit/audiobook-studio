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
import { and, desc, eq, gte, isNotNull, isNull, sql, sum } from "drizzle-orm";

import type { CloneFee } from "@/lib/providers";
import { REASONING_SAMPLE, recentReasoning } from "@/lib/scriptActivity";
import type {
  BookSpend,
  Endpoint,
  EndpointKind,
  Profile,
  ReasoningEffort,
  ReqError,
  RequestRecord,
  RequestUsage,
  ScriptEndpointTelemetry,
  SpeechCharge,
  Transcriber,
  TtsBilling,
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
import { chapters, cloneFees, jobs, openingSpend, requests } from "~/db/schema";
import type { SentScript, SentSpeech, SentTranscription } from "~/providers/sent";

type Sent = SentScript | SentSpeech | SentTranscription;

/** Which work a request was for. The chapter by its uid, which a renumbering never moves. */
export interface RequestFor {
  /** null for a request no book asked for — a voice sample on the Endpoints page */
  bookId: string | null;
  chapterUid: string | null;
  /** what the Activity list names it; frozen, so it still reads after the chapter is gone */
  label: string;
  /** when the work was asked for; the request's own start when it went straight out */
  queuedAt?: number;
  /**
   * The voice a speech request was spoken in, as `<endpoint id>/<voice id>`: the first billed one
   * spoken in a cloned voice whose provider charges at first use settles that fee too.
   */
  voiceRef?: string;
  /**
   * The reasoning level a scripting request asked for, as the run it belongs to was queued with —
   * not the profile's now. What its reasoning tokens are read against for the next estimate.
   */
  reasoning?: ReasoningEffort | null;
  /**
   * What the request held against the budgets while it was out, at its undiscounted worst case:
   * kept on a row whose cost is unknown, which the budgets count in its place. $0 here means the
   * card charges nothing for it, so a request that reported nothing is known to be free.
   */
  held?: number;
}

const errorOf = (sent: Sent): ReqError | undefined =>
  sent.error
    ? {
        code: sent.error.code,
        message: sent.error.message,
        body: sent.error.body ?? "",
        at: sent.finishedAt,
      }
    : undefined;

/**
 * Append one settled request as it stands. Everything a job sends goes through `settleScript` or
 * `settleSpeech`, which price it first; this is for a row that arrives with its receipt already
 * decided — the demo's history of its simulated endpoints, which nothing billed.
 */
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
 * Price one scripting request against `profile`'s card and append it. A request that reported no
 * usage costs nothing when it was refused — no chat completion is billed for an error. One that
 * was answered — done, or a 2xx this server could not use — was billed for something nobody here
 * knows: its cost is unknown, never $0, which would have the budgets count a paid request as free,
 * and its row keeps what it held for them to count instead; unless the most it could have cost
 * (`work.held`) is nothing, when it is known to be free. A
 * provider that says what the request cost — OpenRouter does, at whichever of its providers served
 * it — is taken at its word; the figure worked out from the card is kept on the receipt beside it.
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
  const answered = sent.status === "done" || (code >= 200 && code < 300);
  const cost = priced ? priced.total : answered && work.held !== 0 ? null : 0;
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
 * Price one speech request against `endpoint`'s card and append it. A request the provider says it
 * did not bill (`sent.billed`: a refusal, no answer, a refusal inside a 200) is still a row, with
 * everything it sent counted, and costs nothing — each line of its receipt says why. One that was
 * billed but failed is charged for what it sent on an endpoint that bills what is sent —
 * characters, bytes, requests — and for the audio it reported on one that bills audio, which is
 * nothing when it reported none.
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
  const charge = sent.billed ? priced : unbilled(priced);
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
    work.held,
  );
}

/**
 * Price one transcription request by the minute of audio it sent, against `transcriber`'s card,
 * and append it. One that was not billed (`sent.billed`) is a row that costs nothing, as speech is.
 */
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
  const charge = sent.billed ? priced : unbilled(priced);
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

/** The ledger row a clone's fee is: the endpoint's, not a book's, like a voice sample on its tab. */
function appendFee(
  db: Db | Tx,
  endpoint: Pick<Endpoint, "id">,
  fee: Pick<CloneFee, "usd" | "said">,
  label: string,
  at: number,
): RequestRecord {
  return append(
    db,
    {
      endpointId: endpoint.id,
      kind: "tts",
      bookId: null,
      label: `${label} · ${fee.said}`,
      status: "done",
      attempts: 1,
      queuedAt: at,
      startedAt: at,
      finishedAt: at,
      queueMs: 0,
      responseMs: 0,
      usage: {},
      // credits the plan prices are a charge this ledger cannot put a figure on, and says so
      cost: fee.usd,
      costBasis: fee.usd == null ? "unknown" : "calculated",
      simulated: false,
    },
    null,
  );
}

/**
 * What making a voice costs, as its provider's `cloning.fee` says: appended now when the provider
 * charges as the voice is made, or set aside for the first line spoken in it when it charges then.
 * Nothing when it charges nothing.
 */
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

/** A fee waiting on the first line spoken in this voice, charged now and once. */
function settleFirstUse(db: Db | Tx, endpoint: Endpoint, voiceRef: string, at: number): void {
  const prefix = `${endpoint.id}/`;
  if (!voiceRef.startsWith(prefix)) return;
  const voiceId = voiceRef.slice(prefix.length);
  const where = and(eq(cloneFees.endpointId, endpoint.id), eq(cloneFees.voiceId, voiceId));
  // taken and charged together, so two lines settling at once charge it once between them
  db.transaction((tx) => {
    const waiting = tx.delete(cloneFees).where(where).returning().get();
    if (waiting) appendFee(tx, endpoint, waiting, `Voice first spoken · ${waiting.title}`, at);
  });
}

/** What a receipt says of a request the provider does not charge for. */
export const NOT_BILLED =
  "not billed: the provider charges nothing for a request it refused or never answered";

/**
 * A charge the provider will not make: the same lines and quantities, each at nothing and saying
 * why, so the row still shows what was sent and what it would have cost had it gone through.
 */
function unbilled(charge: SpeechCharge): SpeechCharge {
  return {
    ...charge,
    lines: charge.lines.map((l) => ({ ...l, amount: 0, note: NOT_BILLED })),
    amount: 0,
    basis: "calculated",
    unknowns: [],
  };
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
 * which is how a running job asks whether the rest of the book leaves room for what it holds. A
 * request whose cost is unknown is counted at what it held while it was out (`held`), and is one
 * of the `unpriced`.
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
    // every kind, transcription among them, though only the two above are told apart
    spent: byKind.reduce((n, r) => n + (r.cost ?? 0), 0) + opening,
    scriptSpent,
    speechSpent,
    opening,
    reserved: held.reduce((n, r) => n + (r.reserved ?? 0), 0),
    scriptReserved: heldBy("scripting"),
    unpriced: byKind.reduce((n, r) => n + Number(r.unpriced ?? 0), 0),
  };
}

/**
 * What one endpoint has been charged since `since`, across every book: what its daily limit is held
 * to. A request whose cost is unknown is counted at what it held while it was out (`held`).
 */
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
      .where(
        and(
          eq(requests.kind, kind),
          eq(requests.endpointId, endpointId),
          // as the Endpoints page reads a row's time
          gte(sql`coalesce(${requests.finishedAt}, ${requests.queuedAt})`, since),
        ),
      )
      .get()?.cost ?? 0
  );
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

/**
 * What a scripting profile's recent requests at its current reasoning level spent thinking, per
 * input token — the same figure its telemetry shows (`recentReasoning`), read off only the rows it
 * is worked out from. What a run's estimate adds for the thinking a reasoning model bills as output.
 */
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
