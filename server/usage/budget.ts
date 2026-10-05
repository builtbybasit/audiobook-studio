// The budgets work is held to on the server: a book's cap, pause and script budget, and each
// endpoint's daily limit.
//
// The rule is the browser's (`src/stores/README.md`, "Pricing and usage invariants"): work is
// checked against what has been **spent plus what unfinished work already holds**, so two runs that
// each fit on their own cannot both start and land past the cap together; and it is checked at the
// **undiscounted** price with the whole output ceiling, because a run lasts long enough for a
// promotion to end or an off-peak window to close inside it.
//
// One question, asked at two moments with the same function:
//
// - **Before anything is queued**, with the worst case of the whole run. A run that does not fit is
//   refused whole and nothing is queued (409), in words that say what to change.
// - **Before each request goes out**, by the job itself, with what it still holds and its own
//   reservation left out of the book's total. That only fails when the world moved under a run that
//   fitted: a request cost more than it reserved, the cap was lowered, or the book was paused. The
//   job then stops, keeping what it already paid for, rather than spending past the cap.
//
// An endpoint's daily limit is asked about per request, not per run: a long run legitimately spans
// days, so a run is refused at queue time only when the limit cannot cover even its first request
// on that endpoint, and otherwise stops at the request that would pass it. Its "spent" is the
// ledger's cost on that endpoint since local midnight, across every book; its "held" is what the
// requests out at it right now hold — not what queued jobs hold, which would have a run that was
// let queue stop itself at its first request. Only this process sends, so what is out is kept in
// memory (`holdToday`), and after a restart nothing is.
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

/** What is being asked for: which budget it draws on, and its worst-case price in USD. */
export interface BudgetAsk {
  kind: "scripting" | "narration" | "transcription";
  cost: number;
  /** a running job asking about itself: its own reservation is left out of what others hold */
  jobId?: number;
  /** what the refusal calls the work, e.g. "this run" or "the next request" */
  what?: string;
  /**
   * The next request on each endpoint the work goes to, held to that endpoint's daily limit: the
   * one about to go out, or before anything is queued the first one. Scripting goes to scripting
   * profiles, narration to speech endpoints and transcription to transcription endpoints.
   */
  requests?: readonly EndpointRequest[];
  /** what the daily limit's refusal calls the request; `what` when not given */
  request?: string;
}

/**
 * Why `ask` may not go ahead, as one sentence a person can act on; null when it may. A paused
 * book refuses everything; a book with no cap and no script budget refuses nothing else, and
 * neither does an endpoint with no daily limit. `bookId` null is work no book asked for — a voice
 * sample, a clone — which only the endpoints' limits apply to.
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

/** `budgetProblem`, thrown as a 409 for a route to answer with. */
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

/** Local midnight before `now`: where "today" starts, as the Endpoints page counts it. */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** What the requests out right now hold against each endpoint's daily limit, per database. */
const out = new WeakMap<Db, Map<string, number>>();
const keyOf = (kind: EndpointKind, id: string) => `${kind}:${id}`;

/** What the requests out at an endpoint right now hold against its daily limit. */
export function heldToday(db: Db, kind: EndpointKind, id: string): number {
  return out.get(db)?.get(keyOf(kind, id)) ?? 0;
}

/**
 * Hold `amount` against an endpoint's daily limit while a request is out at it. The function given
 * back gives back `n` of it — all that is left when called with none — and never more than was
 * held, so it can be called as each part of the request is charged and again once it has ended.
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

function endpointOf(db: Db, kind: EndpointKind, id: string) {
  switch (kind) {
    case "tts":
      return readEndpoint(db, id);
    case "scripting":
      return readProfiles(db).find((p) => p.id === id);
    case "transcription":
      return readTranscribers(db).find((t) => t.id === id);
  }
}

/** Why `r` would take its endpoint past its daily limit, or null; see the header. */
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
