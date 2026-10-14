// What has been spent. `requests` is append-only: one row per settled request, never moved,
// re-priced or removed, because the clips it paid for move. Receipts are frozen JSON; everything
// a total or filter reads is a column beside them.
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type {
  ReasoningEffort,
  CostBasis,
  EndpointKind,
  PricedRequest,
  ReqError,
  RequestStatus,
  SpeechCharge,
  WaitReason,
} from "@/types";
import { books, chapters } from "~/db/schema/library";

export const requests = sqliteTable(
  "requests",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id").notNull(),
    kind: text("kind").$type<EndpointKind>().notNull(),
    /** null for a request with no book, such as a connection probe */
    bookId: text("book_id").references(() => books.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    /**
     * By uid, not number: numbers move when volumes go, and this row is never rewritten. `set null`
     * on delete, never cascade: the spend stays in every total, named by the frozen `label`.
     */
    chapterUid: text("chapter_uid").references(() => chapters.uid, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    label: text("label").notNull(),
    status: text("status").$type<RequestStatus>().notNull(),
    attempts: integer("attempts").notNull().default(1),

    queuedAt: integer("queued_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    /** ms waiting on our side, before dispatch */
    queueMs: real("queue_ms").notNull().default(0),
    /** ms waiting on the provider, after dispatch */
    responseMs: real("response_ms").notNull().default(0),
    waiting: text("waiting").$type<WaitReason>(),
    rateLimited: integer("rate_limited", { mode: "boolean" }),

    // ---- usage, as columns so a total is a sum ----
    /** total input; cached and cache-write tokens are slices of it, not additions */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** of `output_tokens`; null = not reported (not zero). Feeds run estimates. */
    reasoningTokens: integer("reasoning_tokens"),
    /** null = left to the model */
    reasoningEffort: text("reasoning_effort").$type<ReasoningEffort>(),
    /** of `input_tokens`; null = not reported (not zero) */
    cachedInput: integer("cached_input"),
    cacheWrite: integer("cache_write"),
    /** speech: independent counts; only the billing unit's is charged. Null = not counted. */
    chars: integer("chars"),
    bytes: integer("bytes"),
    textTokens: integer("text_tokens"),
    audioSeconds: real("audio_seconds"),
    audioTokens: integer("audio_tokens"),

    // ---- the money ----
    /** null = rate unknown, never the same as free */
    cost: real("cost"),
    costBasis: text("cost_basis").$type<CostBasis>().notNull(),
    /** worst case held in flight, kept only when `cost` is null; budgets count it */
    held: real("held"),
    /** Frozen receipts (scripting / speech); read these, never re-derive a past cost. */
    priced: text("priced", { mode: "json" }).$type<PricedRequest>(),
    speech: text("speech", { mode: "json" }).$type<SpeechCharge>(),

    error: text("error", { mode: "json" }).$type<ReqError>(),
    /** false only for rows a real provider produced */
    simulated: integer("simulated", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    /** the Activity list */
    index("requests_endpoint_time").on(t.endpointId, t.finishedAt),
    index("requests_book").on(t.bookId, t.finishedAt),
    index("requests_chapter").on(t.chapterUid),
    index("requests_status").on(t.status),
  ],
);

/** A book's spend before this ledger began, taken once so it can't overlap `requests`. */
export const openingSpend = sqliteTable(
  "opening_spend",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade", onUpdate: "cascade" }),
    amount: real("amount").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bookId] })],
);

/**
 * A clone fee charged on first use (MiniMax: `cloning.fee.when === "first-use"`). The first billed
 * request with the voice moves it into `requests` in one transaction. Keyed by value, not FK:
 * saving endpoints rewrites every voice row.
 */
export const cloneFees = sqliteTable(
  "clone_fees",
  {
    endpointId: text("endpoint_id").notNull(),
    voiceId: text("voice_id").notNull(),
    /** the voice's name when made, for the ledger label */
    title: text("title").notNull(),
    /** null when priced in credits */
    usd: real("usd"),
    /** the fee in the provider's docs' words */
    said: text("said").notNull(),
    /** epoch ms */
    madeAt: integer("made_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.endpointId, t.voiceId] })],
);
