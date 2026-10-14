// The demo's simulation speeds: what the Demo drawer offers and `server/routes/demo.ts` accepts.
export const SPEEDS: { value: number; label: string; hint: string }[] = [
  { value: 1, label: "1×", hint: "as a provider would" },
  { value: 4, label: "4×", hint: "quick enough to watch" },
  { value: 16, label: "16×", hint: "for the end state" },
];
