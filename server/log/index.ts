// The server's logger.
//
// Two audiences, one record. A person at a terminal gets the columns in `pretty.ts`; anything else
// — a file, a pipe, a log shipper — gets pino's JSON, because a colour code in a file somebody is
// grepping has made the file worse. Which one is decided by whether stdout is a terminal, and can
// be said outright with `LOG_FORMAT`.
//
// **The redaction list is the reason this file exists rather than a bare `pino()` call.** This
// server will hold provider credentials, and the moment one is logged it is in a file, a scrollback
// and possibly a log shipper. Redaction at the logger means a key cannot leak through a spread
// somebody wrote in a hurry — which is a guarantee, where "remember not to log the endpoint object"
// is only ever a hope.
import pino from "pino";

import { env } from "~/env";
import { COLOUR, NO_COLOUR, colourWanted } from "~/log/colour";
import { prettyStream } from "~/log/pretty";

/**
 * Paths whose value never reaches a log line.
 *
 * Wildcards cover the shapes a credential actually arrives in: on its own, inside an endpoint or a
 * request that was spread into the record, and in the headers of something being sent. `*.token`
 * only reaches one level down, so the common containers are named too.
 */
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
  /** `pretty` for a terminal, `json` for anything that will be read by a machine */
  format?: "pretty" | "json";
  /** where the line goes; the default is stdout */
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
    // `pid` and `hostname` on every line of a single-process dev server is noise; the JSON side
    // keeps them, where something is aggregating across machines and they mean something.
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

/** The logger the server uses. Modules take a child of it rather than calling it directly. */
export const log: Logger = createLogger();
