// Formatting shared by the Export panels. One definition each, so the plan, the chapter list, the
// library and the player bar never disagree about what "12h 04m" or "1.4 GB" means.

/** A long span: hours and minutes, or minutes and seconds under an hour. */
export const hms = (s: number): string =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`
    : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;

/** A clip-length span, as a player writes it. */
export const clock = (s: number): string =>
  `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Megabytes, promoted to GB once the number stops being readable. */
export const mb = (n: number): string =>
  n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} GB` : `${Math.round(n)} MB`;

export const plural = (n: number, one: string, many = one + "s"): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Seconds, exact but never noisy — the same rule the pacing controls use. */
export const secs = (n: number): string => `${Number(n.toFixed(2))}s`;

/** Where a finished export would sit on disk. Invented path; nothing is written. */
export const diskPath = (series: string, filename: string): string =>
  `~/Audiobooks/${(series || "Audiobooks").replace(/[/:]/g, "-")}/${filename}`;
