// Budgets: a book's cap, pause and script budget, and each endpoint's daily limit. Work is checked
// against spent + held by unfinished work (so two runs can't jointly overshoot), at the
// undiscounted worst case (a promotion can end mid-run). Asked before queueing (whole run) and by
// the job before each request (its own reservation left out).
// The daily limit is per request, since a run may span days; its "held" is only requests out now,
// kept in memory (`holdToday`), as only this process sends.
import type { EndpointKind } from "@/types";
import { money } from "@/lib/pricing";
import type { Db } from "~/db/client";
import { readEndpoint, readProfiles, readTranscribers } from "~/db/endpoints";
import { getBook } from "~/db/library";
import { conflict } from "~/lib/errors";
import { bookSpend, endpointSpend } from "~/usage/ledger";

/** One request about to go to an endpoint, at its worst-case price in USD. */
export interface EndpointRequest {
  endpoint: string;
  cost: number;
}

/** Which budget the work draws on, and its worst-case price in USD. */
export interface BudgetAsk {
  kind: "scripting" | "narration" | "transcription";
  cost: number;
  /** a running job asking about itself, whose own reservation is left out */
  jobId?: number;
  /** what the refusal calls the work, e.g. "this run" or "the next request" */
  what?: string;
  /** The next request on each endpoint, checked against its daily limit. */
  requests?: readonly EndpointRequest[];
  /** what the daily limit's refusal calls the request; `what` when not given */
  request?: string;
}

/**
 * Why `ask` may not go ahead, as an actionable sentence; null when it may. `bookId` null (a voice
 * sample, a clone) checks only the endpoints' daily limits.
 */
export function budgetProblem(db: Db, bookId: string | null, ask: BudgetAsk): string | null {
  const book = bookId == null ? null : bookProblem(db, bookId, ask);
  if (book) return book;
  const kind: EndpointKind = ask.kind === "narration" ? "tts" : ask.kind;
  for (const r of ask.requests ?? []) {
    const problem = dailyProblem(db, kind, r, ask.request ?? ask.what ?? "the first request");
    if (problem) return problem;
  }
  return null;
}

export function assertWithinBudget(db: Db, bookId: string | null, ask: BudgetAsk): void {
  const problem = budgetProblem(db, bookId, ask);
  if (problem) throw conflict(problem);
}

function bookProblem(db: Db, bookId: string, ask: BudgetAsk): string | null {
  const book = getBook(db, bookId);
  if (!book) return null;
  const what = ask.what ?? "this run";
  if (book.budget?.paused)
    return `${book.title} is paused. Resume it from the book's overview to start ${what}.`;
  const cap = book.budget?.cap ?? null;
  const scriptCap = ask.kind === "scripting" ? (book.scriptBudget ?? null) : null;
  if (cap == null && scriptCap == null) return null;
  const s = bookSpend(db, bookId, ask.jobId);
  const cost = Math.max(0, ask.cost);
  if (cap != null && s.spent + s.reserved + cost > cap + 1e-9)
    return (
      `Over the book's ${money(cap)} cap: ${money(s.spent)} spent` +
      (s.reserved > 0 ? `, ${money(s.reserved)} held by work already running` : "") +
      `, ${money(cost)} for ${what} — priced without today's discounts, because they can end ` +
      "mid-run. Raise the cap on the book's overview, or wait for the work in flight to land."
    );
  if (scriptCap != null && s.scriptSpent + s.scriptReserved + cost > scriptCap + 1e-9)
    return (
      `Over the book's ${money(scriptCap)} script budget: ${money(s.scriptSpent)} spent` +
      (s.scriptReserved > 0 ? `, ${money(s.scriptReserved)} held by scripting in flight` : "") +
      `, ${money(cost)} for ${what} — priced without today's discounts. Raise the script ` +
      "budget on the book's overview."
    );
  return null;
}

// ---------- an endpoint's daily limit ----------

/** Local midnight before `now`, as the Endpoints page counts "today". */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Held by requests out right now, per database, keyed `<kind>:<id>`. */
const out = new WeakMap<Db, Map<string, number>>();
const keyOf = (kind: EndpointKind, id: string) => `${kind}:${id}`;

export function heldToday(db: Db, kind: EndpointKind, id: string): number {
  return out.get(db)?.get(keyOf(kind, id)) ?? 0;
}

/**
 * Hold `amount` against an endpoint's daily limit while a request is out. The returned release
 * gives back `n` (default: all left), never more than held, so it can be called repeatedly.
 */
export function holdToday(
  db: Db,
  kind: EndpointKind,
  id: string,
  amount: number,
): (n?: number) => void {
  let held = out.get(db);
  if (!held) out.set(db, (held = new Map()));
  const map = held;
  const key = keyOf(kind, id);
  let left = Math.max(0, amount);
  map.set(key, (map.get(key) ?? 0) + left);
  return (n = left) => {
    const back = Math.min(left, Math.max(0, n));
    if (!back) return;
    left -= back;
    const rest = (map.get(key) ?? 0) - back;
    if (rest > 1e-12) map.set(key, rest);
    else map.delete(key);
  };
}

export function endpointOf(db: Db, kind: EndpointKind, id: string) {
  switch (kind) {
    case "tts":
      return readEndpoint(db, id);
    case "scripting":
      return readProfiles(db).find((p) => p.id === id);
    case "transcription":
      return readTranscribers(db).find((t) => t.id === id);
  }
}

function dailyProblem(db: Db, kind: EndpointKind, r: EndpointRequest, what: string): string | null {
  const ep = endpointOf(db, kind, r.endpoint);
  const limit = ep?.spendLimit ?? null;
  if (!ep || limit == null) return null;
  const spent = endpointSpend(db, kind, ep.id, startOfToday());
  const held = heldToday(db, kind, ep.id);
  const cost = Math.max(0, r.cost);
  if (spent + held + cost <= limit + 1e-9) return null;
  return (
    `${ep.name}'s ${money(limit)} daily limit is reached: ${money(spent)} spent today` +
    (held > 0 ? `, ${money(held)} held by requests out now` : "") +
    `, ${money(cost)} for ${what} — priced without today's discounts. Raise it on the ` +
    "endpoint's Pricing tab, or run it again tomorrow."
  );
}
