// A waveform for a clip we have no file for.
//
// The prototype renders no audio, so there is nothing to decode and nothing to draw. Rather than
// leave the compare panel empty, this invents a plausible *speech* envelope — syllable bursts with
// breaths between them — the same way `FixtureEndpointService` invents a week of request history.
// It is seeded by the clip's identity, so a take's shape is stable across redraws and two takes of
// the same line look related but not identical. Everywhere it is used says the shape is invented;
// the moment a clip has a `url`, wavesurfer decodes the real thing and none of this runs.

/** xorshift from a string seed — same clip, same shape, every render */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/**
 * `n` samples in -1…1, shaped like a spoken line: syllables about four a second, a louder opening,
 * and a couple of breaths where a reader would take them.
 */
export function speechPeaks(seed: string, duration: number, n = 320): number[] {
  const rand = rng(seed);
  const syllables = Math.max(2, Math.round(duration * 4));
  const breaths = new Set<number>();
  for (let i = 0; i < Math.floor(syllables / 7); i++)
    breaths.add(1 + Math.floor(rand() * (syllables - 2)));
  const gain: number[] = [];
  for (let i = 0; i < syllables; i++) {
    if (breaths.has(i)) gain.push(0.04);
    else gain.push(0.35 + rand() * 0.6);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = (i / n) * syllables;
    const s = Math.floor(at);
    // each syllable swells and falls, so bars don't read as a solid block
    const shape = Math.sin(Math.PI * (at - s)) ** 0.7;
    // the line fades in and out rather than starting and stopping at full volume
    const edge = Math.min(1, Math.min(i, n - 1 - i) / (n * 0.04));
    out.push((gain[s] ?? 0.2) * shape * edge * (0.75 + rand() * 0.25));
  }
  return out;
}
