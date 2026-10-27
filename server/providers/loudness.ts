// EBU R128 loudness measured a chapter at a time, so a rebuild measures only what changed. Each
// chapter keeps its 400 ms block loudnesses as a histogram; summed over a file's chapters, they gate
// to the integrated loudness of the joined audio, as `ebur128` would over the whole file.

/** One chapter's blocks in 0.01 LU steps (as ffmpeg bins them) → count; true peak in dBTP. */
export interface Measured {
  blocks: Record<string, number>;
  /** null for digital silence */
  peak: number | null;
}

/** One gain over the whole file, after a limiter at `ceiling` dB where peaks need it. */
export interface Levelling {
  gain: number;
  ceiling: number | null;
  /** the limiter the loudness was measured through, which set `gain` */
  probe: number | null;
}

/** the true-peak ceiling a file is levelled to */
export const TP = -1.5;
/** how far from the target a gain kept from an earlier build may land the file */
export const TOLERANCE = 0.5;

/** `ebur128=metadata=1:peak=true,ametadata=mode=print:key=lavfi.r128.M` output, as one chapter. */
export function measuredOf(log: string): Measured {
  const blocks: Record<string, number> = {};
  for (const [, m] of log.matchAll(/lavfi\.r128\.M=(-?[\d.]+)/g)) {
    // the absolute gate: below −70 a block never counts
    if (Number(m) <= -70) continue;
    const bin = String(Math.round(Number(m) * 100));
    blocks[bin] = (blocks[bin] ?? 0) + 1;
  }
  const peak = /Peak:\s+(-?[\d.]+)/.exec(log.slice(log.lastIndexOf("Summary:")))?.[1];
  return { blocks, peak: peak == null ? null : Number(peak) };
}

/** Integrated loudness and true peak of the chapters joined; null for silence. */
export function loudnessOf(chapters: Measured[]): { i: number; peak: number } | null {
  const counts = new Map<number, number>();
  for (const c of chapters)
    for (const [bin, n] of Object.entries(c.blocks))
      counts.set(Number(bin), (counts.get(Number(bin)) ?? 0) + n);
  const mean = (above: number): number => {
    let sum = 0;
    let n = 0;
    for (const [bin, count] of counts)
      if (bin / 100 > above) {
        sum += count * 10 ** (bin / 1000);
        n += count;
      }
    return n ? 10 * Math.log10(sum / n) : -Infinity;
  };
  const i = mean(mean(-70) - 10);
  return Number.isFinite(i)
    ? { i, peak: Math.max(...chapters.map((c) => c.peak ?? -Infinity)) }
    : null;
}

/**
 * One gain to the target. Peaks it would carry over `TP` are limited first; the limiter sees
 * samples, not true peaks, hence the half-dB margin, and cannot go below −24 dB, where the gain
 * stops short of the target instead.
 */
export function levelOf(
  target: number,
  m: { i: number; peak: number },
  probe: number | null = null,
): Levelling {
  const wanted = target - m.i;
  if (m.peak + wanted <= TP) return { gain: wanted, ceiling: null, probe };
  const ceiling = Math.max(-24, TP - wanted - 0.5);
  return { gain: Math.min(wanted, TP - 0.5 - ceiling), ceiling, probe };
}

/**
 * Whether an earlier build's gain still lands these chapters within `TOLERANCE` of the target with
 * their peaks under the ceiling. `after` is their loudness through its limiter, or `m` without one.
 */
export const keeps = (
  l: Levelling,
  target: number,
  m: { i: number; peak: number },
  after: { i: number },
): boolean =>
  Math.abs(after.i + l.gain - target) <= TOLERANCE && (l.ceiling != null || m.peak + l.gain <= TP);

export const limiterOf = (ceiling: number): string =>
  `alimiter=limit=${(10 ** (ceiling / 20)).toFixed(6)}:level=false:latency=true`;

/** The filter that applies `l`: the same linear gain loudnorm's linear mode applies, unresampled. */
export const filterOf = (l: Levelling): string =>
  [...(l.ceiling == null ? [] : [limiterOf(l.ceiling)]), `volume=${l.gain.toFixed(4)}dB`].join(",");
