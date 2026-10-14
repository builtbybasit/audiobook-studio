// The server's logger: `pretty.ts` on a terminal, pino JSON otherwise (or per `LOG_FORMAT`).
// Redaction lives here, at the logger, so a credential can't leak through a careless spread.
import pino from "pino";

import { env } from "~/env";
import { COLOUR, NO_COLOUR, colourWanted } from "~/log/colour";
import { prettyStream } from "~/log/pretty";

/** `*.token` reaches only one level down, so the common containers are named too. */
const REDACT = [
  "token",
  "key",
  "apiKey",
  "secret",
  "password",
  "authorization",
  "*.token",
  "*.key",
  "*.apiKey",
  "*.secret",
  "*.password",
  "*.authorization",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "endpoint.token",
  "endpoint.key",
  "credential.token",
  "credential.key",
];

export type Logger = pino.Logger;

export interface LoggerOptions {
  level?: string;
  format?: "pretty" | "json";
  /** default stdout */
  out?: (s: string) => void;
  /** overrides the terminal and environment checks, for tests */
  colour?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? env.LOG_LEVEL;
  const tty = !!process.stdout.isTTY;
  const format = options.format ?? env.LOG_FORMAT ?? (tty ? "pretty" : "json");
  const base = {
    level,
    redact: { paths: REDACT, censor: "[redacted]" },
    // `pid` and `hostname` are noise on a terminal; JSON keeps them for aggregation
    base: format === "pretty" ? {} : undefined,
  };
  if (format === "json") return pino(base, options.out ? { write: options.out } : undefined);

  const colour = options.colour ?? colourWanted(process.env, tty);
  return pino(
    base,
    prettyStream({
      palette: colour ? COLOUR : NO_COLOUR,
      cwd: process.cwd(),
      out: options.out,
    }),
  );
}

/** Modules take a child of it. */
export const log: Logger = createLogger();
