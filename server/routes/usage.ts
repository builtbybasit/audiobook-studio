// What has been spent, over HTTP: a book's total, and one endpoint's requests.
//
// Both are reads of the ledger (`~/usage/ledger`), which only a job writes. There is no route that
// appends, edits or removes a request — a settled request is a fact about the past — and none that
// sets spending directly: the cap and the pause are the book's settings, written by
// `PATCH /api/books/:id`.
import { Hono } from "hono";
import type { Env as PinoEnv } from "hono-pino";
import * as v from "valibot";

import type { Db } from "~/db/client";
import { getBook } from "~/db/library";
import { notFound } from "~/lib/errors";
import { validate } from "~/lib/validate";
import { bookSpend, endpointRequests } from "~/usage/ledger";

const BookParam = v.object({ id: v.string() });

/** How far back the Activity list and the charts read, as the page's range picker names it. */
const RANGE_MS = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };

const RequestsQuery = v.object({
  kind: v.picklist(["tts", "scripting"]),
  id: v.pipe(v.string(), v.nonEmpty()),
  range: v.optional(v.picklist(["1h", "6h", "24h", "7d"]), "24h"),
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

/** Mounted on `/api/endpoints`: one endpoint's settled requests in a range, newest first. */
export function endpointUsageRoutes(db: Db): Hono<PinoEnv> {
  const app = new Hono<PinoEnv>();
  app.get("/requests", validate("query", RequestsQuery), (c) => {
    const { kind, id, range } = c.req.valid("query");
    return c.json({ requests: endpointRequests(db, kind, id, Date.now() - RANGE_MS[range]) });
  });
  return app;
}
