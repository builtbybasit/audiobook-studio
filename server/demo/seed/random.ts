/** A deterministic pseudo-random source; same seed ⇒ same world on every reload. */
export type Rng = () => number;

export function rng(seed: number): Rng {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function pick<T>(arr: T[], r: Rng): T {
  return arr[Math.floor(r() * arr.length)];
}
