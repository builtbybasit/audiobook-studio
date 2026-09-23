// A book's budget, held on the server: the cap, the pause and the script budget.
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
import { money } from "@/lib/pricing";
import type { Db, Tx } from "~/db/client";
import { getBook } from "~/db/library";
import { conflict } from "~/lib/errors";
import { bookSpend } from "~/usage/ledger";

/** What is being asked for: which budget it draws on, and its worst-case price in USD. */
export interface BudgetAsk {
  kind: "scripting" | "narration";
  cost: number;
  /** a running job asking about itself: its own reservation is left out of what others hold */
  jobId?: number;
  /** what the refusal calls the work, e.g. "this run" or "the next request" */
  what?: string;
}

/**
 * Why `ask` may not go ahead on `bookId`, as one sentence a person can act on; null when it may.
 * A paused book refuses everything; a book with no cap and no script budget refuses nothing else.
 */
export function budgetProblem(db: Db | Tx, bookId: string, ask: BudgetAsk): string | null {
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

/** `budgetProblem`, thrown as a 409 for a route to answer with. */
export function assertWithinBudget(db: Db | Tx, bookId: string, ask: BudgetAsk): void {
  const problem = budgetProblem(db, bookId, ask);
  if (problem) throw conflict(problem);
}
