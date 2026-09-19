// What has been spent, and on what.
//
// **This table is append-only.** One row per request that settled — of either kind, successful or
// not — with the receipt it was priced from, and nothing moves, re-prices or removes one
// afterwards. Spending is derived from it, and so is every endpoint's account of its own work.
//
// That rule is the point of the table rather than a nicety about it. The store's history is
// explicit: totalling the clip currently on each line meant a failed render cost nothing and
// accepting a retake made the money spent on the displaced clip **disappear**, and reading the
// activity list out of the running job simulator made a request vanish the moment it finished. So
// the record does not live on the artefact, because the artefact moves.
//
// The receipts — `priced` for tokens, `speech` for a rendered clip — are frozen documents and are
// stored whole. Everything a total, a chart or a filter reads is a column beside them, so no
// aggregate has to parse JSON and no query is tempted to recompute a cost from the endpoint's
// current rate card.
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type {
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
    /** null for a request that belongs to no book, such as a connection probe */
    bookId: text("book_id").references(() => books.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    /**
     * The chapter the work was for — by identity, not by number.
     *
     * A chapter number is an address that moves: remove volume 1 and yesterday's chapter 2 is
     * today's chapter 1. Storing the number here would leave the ledger with two ways to be wrong
     * and no way to be right — rewrite it and an append-only record has been edited; leave it and
     * the row silently attributes money to a different chapter. Referencing the chapter's own id
     * settles it: the row never changes, and the number it displays is looked up when it is read.
     *
     * `set null` when the chapter is deleted, never cascade. The chapter is gone; what was spent on
     * it is not, and it stays in every total. `label` is frozen at the time of the request and is
     * what still names the work afterwards.
     */
    chapterUid: text("chapter_uid").references(() => chapters.uid, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    label: text("label").notNull(),
    status: text("status").$type<RequestStatus>().notNull(),
    /** 1 = settled on the first try; >1 means it was retried */
    attempts: integer("attempts").notNull().default(1),

    queuedAt: integer("queued_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    /** ms spent waiting on our side, before dispatch */
    queueMs: real("queue_ms").notNull().default(0),
    /** ms spent waiting on the provider, after dispatch */
    responseMs: real("response_ms").notNull().default(0),
    waiting: text("waiting").$type<WaitReason>(),
    rateLimited: integer("rate_limited", { mode: "boolean" }),

    // ---- usage, as columns so a total is a sum ----
    /**
     * The **total** input, cached and cache-write tokens included: those two are slices of it,
     * never additions to it, so the charge lines always add back up to what the provider reported.
     */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** of `input_tokens`, served from the provider's cache. Null = not reported, which is not zero. */
    cachedInput: integer("cached_input"),
    cacheWrite: integer("cache_write"),
    /**
     * The speech side. Four quantities that are never conversions of one another: a request is so
     * many characters *and* so many UTF-8 bytes *and* so many text tokens, and only the one its
     * endpoint bills in is charged. Null means nobody counted it.
     */
    chars: integer("chars"),
    bytes: integer("bytes"),
    textTokens: integer("text_tokens"),
    audioSeconds: real("audio_seconds"),
    audioTokens: integer("audio_tokens"),

    // ---- the money ----
    /** null when the endpoint's rate is unknown, which is never the same as free */
    cost: real("cost"),
    costBasis: text("cost_basis").$type<CostBasis>().notNull(),
    /**
     * The receipt, frozen when the request completed. A scripting request gets `priced` — tokens,
     * with the cache split; a rendered clip gets `speech` — characters, bytes, audio seconds and
     * the unit its endpoint bills by. Editing a rate or letting a promotion expire never touches
     * one, which is why a view must read this rather than re-derive a past cost.
     */
    priced: text("priced", { mode: "json" }).$type<PricedRequest>(),
    speech: text("speech", { mode: "json" }).$type<SpeechCharge>(),

    error: text("error", { mode: "json" }).$type<ReqError>(),
    /** false only for rows a real provider produced */
    simulated: integer("simulated", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    /** the Activity list: one endpoint's requests, newest first, inside a time range */
    index("requests_endpoint_time").on(t.endpointId, t.finishedAt),
    /** what a book has spent */
    index("requests_book").on(t.bookId, t.finishedAt),
    index("requests_chapter").on(t.chapterUid),
    index("requests_status").on(t.status),
  ],
);

/**
 * What a book had already spent before this ledger began.
 *
 * An opening balance, taken once, so that the two halves cannot overlap: nothing done to a clip
 * afterwards can change what was spent before any of it happened. A book with no row here has
 * spent nothing but what `requests` records.
 */
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
