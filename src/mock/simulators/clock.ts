// How fast simulated work runs.
//
// The simulators wait the way a provider would — a request takes its latency, a build encodes at
// a rate — and a tester watching a 214-chapter build has no use for that realism. One shared
// setting shortens every simulated wait; the latency and cost a request *records* stay nominal,
// so the ledger, the telemetry and the spend read the same at every speed. Module scope rather
// than the store: a simulator never sees the store, and a demo reset restores data, not this.
export const SPEEDS: { value: number; label: string; hint: string }[] = [
  { value: 1, label: "1×", hint: "as a provider would" },
  { value: 4, label: "4×", hint: "quick enough to watch" },
  { value: 16, label: "16×", hint: "for the end state" },
];

export const clock = { speed: 1 };

/** A simulated wait, shortened by the speed. Recorded durations do not go through this. */
export const simMs = (ms: number): number => ms / clock.speed;
