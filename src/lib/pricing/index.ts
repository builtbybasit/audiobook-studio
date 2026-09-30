// What an endpoint charges right now, why, and what one request cost.
//
// Everything here is pure: given a rate card and an instant it answers the same way every time, and
// it never reads a store or a clock of its own. That is what makes a priced request a receipt — the
// same inputs always produce the same figure, so a receipt can be kept instead of recalculated.
//
// The one rule worth knowing before reading any of it:
//
//   1. Base rates are what the endpoint charges normally.
//   2. The schedule may replace them. **At most one window applies** — the first in the list whose
//      recurrence covers the instant. Windows never stack with each other.
//   3. A promotion may then replace what the schedule left. **At most one promotion applies per
//      component** — the one that makes that component cheapest, ties going to the one ending
//      soonest and then to list order. Promotions never stack, with each other or with themselves.
//
// So a rate is `base → scheduled → promoted`, each step replacing the last rather than compounding.
// `effectiveRates` returns every step, which is what lets the page say *why* a price is what it is.
//
// The rules are split by the question they answer, and everything is re-exported here, so a caller
// imports `@/lib/pricing` and never a file inside it:
//
//   units.ts     what a request is charged on, and how a submitted line is measured
//   rates.ts     a card's configuration, and the rates in force at an instant
//   usage.ts     what a provider reported, read into one shape
//   receipt.ts   what one request cost, kept as a receipt
//   estimate.ts  what a run would cost before it is sent
//   validate.ts  what a rate card cannot or probably should not say
//   format.ts    how any of it is written: money, labels, charge lines, one-liners
export * from "./estimate";
export * from "./format";
export * from "./rates";
export * from "./receipt";
export * from "./units";
export * from "./usage";
export * from "./validate";
