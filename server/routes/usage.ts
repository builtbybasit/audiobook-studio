// What has been spent, over HTTP: a book's total, and one endpoint's summary and requests.
//
// Both are reads of the ledger (`~/usage/ledger`), which only a job writes. There is no route that
// appends, edits or removes a request — a settled request is a fact about the past — and none that
// sets spending directly: the cap and the pause are the book's settings, written by
// `PATCH /api/books/:id`.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import { ENDPOINT_KINDS } from "@/lib/endpointShapes";
import { RANGES } from "@/services/endpoints";
import type { RangeKey } from "@/types";
import type { Db } from "~/db/client";
import { getBook } from "~/db/library";
import { notFound } from "~/lib/errors";
import { BookParam, IntParam } from "~/lib/http";
import { validate } from "~/lib/validate";
import { bookSpend, endpointSummary, requestPage } from "~/usage/ledger";

const Range = v.optional(v.picklist(RANGES.map((r) => r.value)), "24h");
const Endpoint = { kind: v.picklist(ENDPOINT_KINDS), id: v.pipe(v.string(), v.nonEmpty()) };

const SummaryQuery = v.object({
  ...Endpoint,
  range: Range,
  /** the start of the browser's day, which "spent today" counts from */
  today: IntParam,
});

const RequestsQuery = v.object({
  ...Endpoint,
  range: Range,
  /** a chart bucket: rows from `from` up to (not including) `to`, inside the range */
  from: v.optional(IntParam),
  to: v.optional(IntParam),
  status: v.optional(v.picklist(["done", "failed", "running", "queued", "cancelled"])),
  bookId: v.optional(v.pipe(v.string(), v.nonEmpty())),
  search: v.optional(v.pipe(v.string(), v.maxLength(200))),
  /** the `next` the previous page handed on */
  before: v.optional(v.pipe(v.string(), v.regex(/^\d+:[\w-]+$/))),
  limit: v.optional(v.pipe(IntParam, v.minValue(1), v.maxValue(2000)), "100"),
});

/** Mounted on `/api/books`: what one book has spent and what its unfinished work holds. */
export function bookUsageRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();
  app.get("/:id/spend", validate("param", BookParam), (c) => {
    const { id } = c.req.valid("param");
    if (!getBook(db, id)) throw notFound("No such book");
    return c.json({ spend: bookSpend(db, id) });
  });
  return app;
}

/**
 * Mounted on `/api/endpoints`: one endpoint's past in a range — its summary, summed over every row,
 * and its requests a page at a time, newest first.
 */
export function endpointUsageRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();
  const since = (range: RangeKey, now: number) => now - RANGES.find((r) => r.value === range)!.ms;
  app.get("/summary", validate("query", SummaryQuery), (c) => {
    const { kind, id, range, today } = c.req.valid("query");
    return c.json({ summary: endpointSummary(db, kind, id, range, Date.now(), today) });
  });
  app.get("/requests", validate("query", RequestsQuery), (c) => {
    const { kind, id, range, from, to, status, bookId, search, before, limit } =
      c.req.valid("query");
    const window = from != null && to != null ? { from, to } : undefined;
    const where = { since: since(range, Date.now()), window, status, bookId, search };
    return c.json(requestPage(db, kind, id, where, { before, limit }));
  });
  return app;
}
