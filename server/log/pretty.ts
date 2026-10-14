// Pretty log lines for a terminal. Not `pino-pretty`: this keeps the logger one in-process stream
// with no worker thread, which survives `bun build`. JSON mode bypasses this file.
import type { Palette } from "~/log/colour";
import { visibleWidth } from "~/log/colour";

const LEVELS: { at: number; label: string; paint: (p: Palette) => (s: string) => string }[] = [
  { at: 60, label: "FATAL", paint: (p) => (s) => p.bold(p.onRed(s)) },
  { at: 50, label: "ERROR", paint: (p) => (s) => p.bold(p.red(s)) },
  { at: 40, label: "WARN", paint: (p) => (s) => p.bold(p.yellow(s)) },
  { at: 30, label: "INFO", paint: (p) => (s) => p.bold(p.green(s)) },
  { at: 20, label: "DEBUG", paint: (p) => (s) => p.bold(p.blue(s)) },
  { at: 10, label: "TRACE", paint: (p) => (s) => p.dim(s) },
];

const levelOf = (n: number) => LEVELS.find((l) => n >= l.at) ?? LEVELS[LEVELS.length - 1];

/** Keys not shown as context. */
const NOISE = new Set(["level", "time", "pid", "hostname", "msg", "err", "req", "res", "name"]);

const HH = (t: number): string => {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

const MAX = 80;

function value(v: unknown, p: Palette): string {
  if (v == null) return p.dim("null");
  if (typeof v === "number") return p.cyan(String(v));
  if (typeof v === "boolean") return p.magenta(String(v));
  if (typeof v === "string") return v.length > MAX ? `${v.slice(0, MAX)}${p.dim("…")}` : v;
  // oxlint-disable-next-line typescript/no-base-to-string -- only what JSON cannot write gets here
  const json = JSON.stringify(v) ?? String(v);
  return json.length > MAX ? `${json.slice(0, MAX)}${p.dim("…")}` : json;
}

function context(record: Record<string, unknown>, p: Palette): string {
  return Object.entries(record)
    .filter(([k, v]) => !NOISE.has(k) && v !== undefined)
    .map(([k, v]) => `${p.dim(k)}${p.dim("=")}${value(v, p)}`)
    .join(" ");
}

/** `server/epub/parse.ts:271  parseEpub`, without the machine's path. */
function frames(stack: string, p: Palette, cwd: string): string[] {
  return stack
    .split("\n")
    .slice(1)
    .map((line) => {
      const at = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):\d+\)?\s*$/.exec(line);
      if (!at) return null;
      const [, fn, file, row] = at;
      const where = file.startsWith(cwd) ? file.slice(cwd.length).replace(/^\//, "") : file;
      // dependency and runtime frames are dimmed, not dropped
      const outside = where.includes("node_modules") || where.startsWith("native");
      const text = `${where}:${row}${fn ? `  ${fn}` : ""}`;
      return outside ? p.dim(text) : `${p.grey(where)}${p.dim(":" + row)}${fn ? `  ${fn}` : ""}`;
    })
    .filter((l): l is string => l != null);
}

export interface PrettyOptions {
  palette: Palette;
  /** stripped off stack frames */
  cwd?: string;
  /** stack frames shown */
  depth?: number;
}

/** One pino record as a line in columns: time, level, message, context. */
export function formatRecord(record: Record<string, unknown>, options: PrettyOptions): string {
  const { palette: p, cwd = "", depth = 6 } = options;
  const level = levelOf(typeof record.level === "number" ? record.level : 30);
  const time = p.dim(HH(typeof record.time === "number" ? record.time : Date.now()));
  const badge = level.paint(p)(level.label.padEnd(5));

  const req = record.req as { method?: string; url?: string } | undefined;
  const res = record.res as { status?: number } | undefined;
  const name = typeof record.name === "string" ? record.name : "";
  let message = typeof record.msg === "string" ? record.msg : "";

  // The request-closing line reads `GET /api/books → 200`. Only that one: records written during
  // a request carry `req` too, and must keep their own message.
  if (req?.method && req.url && res?.status) {
    const status = res.status;
    const paint = status >= 500 ? p.red : status >= 400 ? p.yellow : p.green;
    message = `${p.bold(req.method)} ${req.url} ${p.dim("→")} ${paint(String(status))}`;
  } else if (name) {
    message = `${p.cyan(name)} ${p.dim("·")} ${message}`;
  }

  const head = `${time}  ${badge} ${p.white(message)}`;
  const rest = context(record, p);
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

export function prettyStream(options: PrettyOptions & { out?: (s: string) => void }): {
  write: (line: string) => void;
} {
  const out = options.out ?? ((s: string) => process.stdout.write(s));
  return {
    write(line: string) {
      try {
        out(`${formatRecord(JSON.parse(line) as Record<string, unknown>, options)}\n`);
      } catch {
        // unreadable: pass it through rather than lose a log line
        out(line);
      }
    },
  };
}
