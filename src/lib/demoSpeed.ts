// How fast the demo's simulated work runs: the speeds the Demo drawer offers, and the only ones the
// demo library will take (`server/routes/demo.ts`). Shared so the two cannot disagree about which
// speeds there are.
export const SPEEDS: { value: number; label: string; hint: string }[] = [
  { value: 1, label: "1×", hint: "as a provider would" },
  { value: 4, label: "4×", hint: "quick enough to watch" },
  { value: 16, label: "16×", hint: "for the end state" },
];
