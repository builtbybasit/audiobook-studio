// A server to test against: the real routes, the real schema, a database that lives in memory and
// goes away with the test.
import { createApp } from "~/app";
import { openDb, type Db } from "~/db/client";
import { migrate } from "~/db/migrate";
import { createLogger, type Logger } from "~/log";

export interface TestApi {
  db: Db;
  /** every line this API wrote, for the tests that are about the logging itself */
  logs: Record<string, unknown>[];
  /** Call the API the way the browser will. Returns the parsed body and the status. */
  request<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  /** POST an EPUB through the real multipart path. */
  import<T = unknown>(
    file: File,
    fields?: Record<string, string>,
  ): Promise<{ status: number; body: T }>;
}

/**
 * A logger that keeps its lines instead of printing them.
 *
 * A suite that prints a line per request is a suite nobody reads the output of, and the output is
 * where a failure explains itself. Collected rather than dropped, so a test can assert on what was
 * logged — and on what was not, which is how the redaction rule is checked.
 */
export function collectingLogger(): { log: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    level: "trace",
    format: "json",
    out: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { log, lines };
}

export function testApi(): TestApi {
  const db = openDb(":memory:");
  migrate(db);
  const { log, lines } = collectingLogger();
  const app = createApp(db, { log });

  const request = async <T>(path: string, init?: RequestInit) => {
    const res = await app.request(`http://api.test${path}`, init);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };

  return {
    db,
    logs: lines,
    request,
    import: <T>(file: File, fields: Record<string, string> = {}) => {
      const form = new FormData();
      form.set("file", file);
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return request<T>("/api/books/import", { method: "POST", body: form });
    },
  };
}

/** `{ ids: [...] }` to a route that takes chapter numbers. */
export const jsonBody = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
