// A server to test against: the real routes, the real schema, the real queue, a database that
// lives in memory and goes away with the test.
import { createApp } from "~/app";
import { openDb, type Db } from "~/db/client";
import { migrate } from "~/db/migrate";
import { createRunner, type JobHandlers, type Runner } from "~/jobs/runner";
import { scriptingHandler } from "~/jobs/scripting";
import { createLogger, type Logger } from "~/log";
import { fakeScriptingProvider } from "~/providers/fake";
import type { ScriptInput, ScriptedLine, ScriptingProvider } from "~/providers/scripting";
import type { FetchLike } from "@/services/http";

export interface TestApi {
  db: Db;
  /** the queue the API enqueues into; `await runner.idle()` to let queued work finish */
  runner: Runner;
  /** `fetch` for a client, answered by this app without a network */
  fetch: FetchLike;
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

export interface TestApiOptions {
  /** the scripting model the queue sends chapters to; the deterministic fake by default */
  scripting?: ScriptingProvider;
  /** handlers for other kinds, or an override for `scripting` */
  handlers?: JobHandlers;
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

/** A private database with the schema applied. */
export function testDb(): Db {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

export function testRunner(db: Db, log: Logger, options: TestApiOptions = {}): Runner {
  return createRunner(
    db,
    {
      scripting: scriptingHandler(options.scripting ?? fakeScriptingProvider()),
      ...options.handlers,
    },
    { log, pollMs: 60_000 },
  );
}

export function testApi(options: TestApiOptions = {}): TestApi {
  const db = testDb();
  const { log, lines } = collectingLogger();
  const runner = testRunner(db, log, options);
  const app = createApp(db, { log, runner });

  const request = async <T>(path: string, init?: RequestInit) => {
    const res = await app.request(`http://api.test${path}`, init);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };

  return {
    db,
    runner,
    fetch: async (input, init) => app.request(new Request(`http://api.test${input}`, init)),
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

/**
 * A scripting provider a test holds the door on.
 *
 * `started` resolves once a job is inside the provider, and nothing comes out until `release` is
 * called — so a test can act on a run that is genuinely in flight (cancel it, edit under it,
 * renumber its book) without a timer to race. Cancelling while it waits rejects the way a real
 * request would.
 */
export function gatedProvider(
  answer: ScriptedLine[] = [{ type: "narration", speaker: "Narrator", text: "Rain fell." }],
): { provider: ScriptingProvider; started: Promise<ScriptInput>; release(): void } {
  let onStart!: (input: ScriptInput) => void;
  let onRelease!: () => void;
  const started = new Promise<ScriptInput>((r) => (onStart = r));
  const gate = new Promise<void>((r) => (onRelease = r));
  return {
    started,
    release: () => onRelease(),
    provider: {
      name: "Gated scripting (test)",
      script(input) {
        onStart(input);
        return new Promise<ScriptedLine[]>((resolve, reject) => {
          const abort = () => reject(input.signal.reason);
          if (input.signal.aborted) return abort();
          input.signal.addEventListener("abort", abort, { once: true });
          void gate.then(() => {
            input.signal.removeEventListener("abort", abort);
            resolve(answer);
          });
        });
      },
    },
  };
}
