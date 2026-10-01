// A status as a dot's colour. StatusDot draws one; a long list draws the span itself with these
// classes, since a component per row is an instance per row.
const DOT: Record<string, string> = {
  none: "bg-zinc-300 dark:bg-zinc-600",
  queued: "bg-zinc-400 ring-2 ring-zinc-300 dark:ring-zinc-700",
  running: "bg-violet-500 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  generating: "bg-violet-500 animate-pulse",
  stale: "bg-amber-500",
  fallback: "bg-emerald-500 ring-2 ring-amber-400",
};

export const dotClass = (status?: string): string =>
  `inline-block h-2 w-2 shrink-0 rounded-full ${(status && DOT[status]) ?? DOT.none}`;
