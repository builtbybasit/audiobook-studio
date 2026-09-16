// Page state that has to outlive a route but is not domain state — which tab you were on, a
// half-typed connection form, how the activity list was filtered. It lives at module scope in the
// view that owns it, so the store cannot reach it and a demo reset would otherwise leave it behind:
// the endpoint form would still show a draft for a model the reset had just put back.
//
// Each such module registers how to clear itself here, and `clearPageState` is called as part of
// restoring the seeded world. Registration is a function, not a store: this is not domain state and
// must not become any.
const clears = new Set<() => void>();

/** Register page state to be cleared when the demo world is restored. Call at module scope. */
export function onDemoReset(clear: () => void): void {
  clears.add(clear);
}

/** Put every registered piece of page state back to its opening shape. */
export function clearPageState(): void {
  for (const clear of clears) clear();
}
