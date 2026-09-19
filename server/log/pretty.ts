// One log line, for a person looking at a terminal.
//
// Written here rather than taken from `pino-pretty`, for two reasons. The look is the point — this
// is the one part of the logger that exists purely to be read by a human, so it is worth shaping —
// and formatting our own records for our own terminal is not the kind of long tail a dependency
// saves you from, the way parsing arbitrary HTML is. It also keeps the logger a single in-process
// stream with no worker thread behind it, which is the arrangement that survives `bun build`.
//
// Machine-readable output is untouched by any of this: in JSON mode pino writes its own lines and
// nothing here runs.
import type { Palette } from "~/log/colour";
import { visibleWidth } from "~/log/colour";

/** pino's numeric levels, and how each one should look and read. */
const LEVELS: { at: number; label: string; paint: (p: Palette) => (s: string) => string }[] = [
  { at: 60, label: "FATAL", paint: (p) => (s) => p.bold(p.onRed(s)) },
  { at: 50, label: "ERROR", paint: (p) => (s) => p.bold(p.red(s)) },
  { at: 40, label: "WARN", paint: (p) => (s) => p.bold(p.yellow(s)) },
  { at: 30, label: "INFO", paint: (p) => (s) => p.bold(p.green(s)) },
  { at: 20, label: "DEBUG", paint: (p) => (s) => p.bold(p.blue(s)) },
  { at: 10, label: "TRACE", paint: (p) => (s) => p.dim(s) },
];

const levelOf = (n: number) => LEVELS.find((l) => n >= l.at) ?? LEVELS[LEVELS.length - 1];

/** Keys pino puts on every record, which say nothing a person reading a terminal wants. */
const NOISE = new Set(["level", "time", "pid", "hostname", "msg", "err", "req", "res", "name"]);

const HH = (t: number): string => {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

/** How long a value may be before it stops being worth reading on one line. */
const MAX = 80;

/** One value, coloured for what it is, so a number reads as a number at a glance. */
function value(v: unknown, p: Palette): string {
  if (v == null) return p.dim("null");
  if (typeof v === "number") return p.cyan(String(v));
  if (typeof v === "boolean") return p.magenta(String(v));
  if (typeof v === "string") return v.length > MAX ? `${v.slice(0, MAX)}${p.dim("…")}` : v;
  const json = JSON.stringify(v) ?? String(v);
  return json.length > MAX ? `${json.slice(0, MAX)}${p.dim("…")}` : json;
}

/** The context a record carries, as `key=value` pairs the eye can skip. */
function context(record: Record<string, unknown>, p: Palette): string {
  return Object.entries(record)
    .filter(([k, v]) => !NOISE.has(k) && v !== undefined)
    .map(([k, v]) => `${p.dim(k)}${p.dim("=")}${value(v, p)}`)
    .join(" ");
}

/** `server/epub/parse.ts:271  parseEpub` — where it happened, without the machine's path to it. */
function frames(stack: string, p: Palette, cwd: string): string[] {
  return stack
    .split("\n")
    .slice(1)
    .map((line) => {
      const at = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?\s*$/.exec(line);
      if (!at) return null;
      const [, fn, file, row] = at;
      const where = file.startsWith(cwd) ? file.slice(cwd.length).replace(/^\//, "") : file;
      // A frame inside a dependency, or in the runtime itself, is rarely the one you want. It is
      // still there — a stack with the middle cut out is how you lose the frame that mattered —
      // but it recedes so the eye lands on the file you can open.
      const outside = where.includes("node_modules") || where.startsWith("native");
      const text = `${where}:${row}${fn ? `  ${fn}` : ""}`;
      return outside ? p.dim(text) : `${p.grey(where)}${p.dim(":" + row)}${fn ? `  ${fn}` : ""}`;
    })
    .filter((l): l is string => l != null);
}

export interface PrettyOptions {
  palette: Palette;
  /** absolute path stripped off stack frames, so a line reads as a file in this repository */
  cwd?: string;
  /** how many stack frames are worth showing before it is just noise */
  depth?: number;
}

/**
 * Turn one pino record into the line a person reads.
 *
 * Laid out in columns — time, level, message, then context — because a log is skimmed far more
 * often than it is read, and a ragged left edge is what makes skimming impossible.
 */
export function formatRecord(record: Record<string, unknown>, options: PrettyOptions): string {
  const { palette: p, cwd = "", depth = 6 } = options;
  const level = levelOf(typeof record.level === "number" ? record.level : 30);
  const time = p.dim(HH(typeof record.time === "number" ? record.time : Date.now()));
  const badge = level.paint(p)(level.label.padEnd(5));

  const req = record.req as { method?: string; url?: string } | undefined;
  const res = record.res as { status?: number } | undefined;
  const name = typeof record.name === "string" ? record.name : "";
  let message = typeof record.msg === "string" ? record.msg : "";

  // The line that closes a request is the one record with a shape of its own worth honouring: what
  // was asked for and what came back read better as `GET /api/books → 200` than as key-value pairs.
  //
  // Only that line. A record written *during* a request also carries `req`, and rendering it the
  // same way would replace what it actually said with the path it happened to be on.
  if (req?.method && req.url && res?.status) {
    const status = res.status;
    const paint = status >= 500 ? p.red : status >= 400 ? p.yellow : p.green;
    message = `${p.bold(req.method)} ${req.url} ${p.dim("→")} ${paint(String(status))}`;
  } else if (name) {
    message = `${p.cyan(name)} ${p.dim("·")} ${message}`;
  }

  const head = `${time}  ${badge} ${p.white(message)}`;
  const rest = context(record, p);
  // The context is pushed out to a column when the message is short enough to leave room for it.
  const gap = Math.max(1, 66 - visibleWidth(head));
  const line = rest ? `${head}${" ".repeat(gap)}${rest}` : head;

  const err = record.err as { type?: string; message?: string; stack?: string } | undefined;
  if (!err) return line;

  const title = `${p.red(err.type ?? "Error")}${err.message ? `: ${err.message}` : ""}`;
  const where = err.stack ? frames(err.stack, p, cwd).slice(0, depth) : [];
  return [line, `${p.dim("  ╰─")} ${title}`, ...where.map((f) => `     ${p.dim("│")} ${f}`)].join(
    "\n",
  );
}

/** A destination pino can write to: one formatted line per record. */
export function prettyStream(options: PrettyOptions & { out?: (s: string) => void }): {
  write: (line: string) => void;
} {
  const out = options.out ?? ((s: string) => process.stdout.write(s));
  return {
    write(line: string) {
      try {
        out(`${formatRecord(JSON.parse(line) as Record<string, unknown>, options)}\n`);
      } catch {
        // Not a record this knows how to read. Losing a log line to the log formatter is the worst
        // possible trade, so it goes out as it arrived.
        out(line);
      }
    },
  };
}
