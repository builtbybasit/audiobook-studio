// Formatting shared by the Export panels, so they never disagree about "12h 04m" or "1.4 GB".
import { clockDuration, minuteDuration } from "@/lib/time";

/** A long span: hours and minutes, or minutes and seconds under an hour. */
export const hms = (s: number): string =>
  s >= 3600
    ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`
    : minuteDuration(s);

export const clock = clockDuration;

/** Megabytes, promoted to GB once the number stops being readable. */
export const mb = (n: number): string =>
  n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} GB` : `${Math.round(n)} MB`;

/** Where a finished export would sit on disk. Invented path; nothing is written. */
export const diskPath = (series: string, filename: string): string =>
  `~/Audiobooks/${(series || "Audiobooks").replace(/[/:]/g, "-")}/${filename}`;
