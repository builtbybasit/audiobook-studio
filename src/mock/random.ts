// Deterministic pseudo-randomness. Same seed ⇒ same world on every reload, which is what lets the
// fixtures be rebuilt from scratch whenever a scenario needs fresh data rather than a shared copy.

/** A deterministic pseudo-random source; same seed ⇒ same world on every reload. */
export type Rng = () => number;

export function rng(seed: number): Rng {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function pick<T>(arr: T[], r: Rng): T {
  return arr[Math.floor(r() * arr.length)];
}

/** A plain uniform draw in [a, b) — used by the simulators, which are not meant to be reproducible. */
export const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
