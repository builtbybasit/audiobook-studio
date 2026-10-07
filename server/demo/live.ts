// What a demo situation leaves running, and what it leaves the endpoints remembering.
//
// A situation is applied to the seeded world in memory and the result written in one transaction
// (`situations.ts`, `world.ts`). Some of what it describes is not a row: work in flight as you
// arrive — three chapters scripting, a build part way — and what an endpoint has been through — its
// recent failures, a 429 and the cooldown after it. The server keeps the first as real jobs on the
// demo's simulated endpoints, and the second as what it keeps for any endpoint: rows in the request
// ledger and the speech gate's cooldown. This is the hand-over between the two halves: the world's
// side says what it wants (`DemoLive`), and `startLive` makes it so once the rows are written and
// the queue is running again.
//
// The browser keeps an endpoint's telemetry as counters and a short history on the endpoint; the
// server derives the same from the ledger, so each point of the history becomes a settled request
// at its moment and with its latency, the last error goes on the failure it was met on, and each
// rate limit is a refused request. What the browser counts beyond the history it keeps — `failures`
// and `completed` run on after the history is trimmed — has no row to be, and the ledger counts what
// the history holds. None of it was billed: every row costs nothing and says it was simulated.
import type {
  DemoScenario,
  Endpoint,
  EndpointKind,
  ExportSettings,
  ReqError,
  ScriptEndpointTelemetry,
} from "@/types";
import type { EndpointTelemetry } from "@/lib/endpointTelemetry";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import type { AudioFiles } from "~/audio/files";
import { coverFiles } from "~/covers/files";
import type { Db, Tx } from "~/db/client";
import * as exports from "~/db/exports";
import * as queue from "~/db/jobs";
import * as library from "~/db/library";
import { readScriptSettings } from "~/db/settings";
import { enqueueBuild } from "~/jobs/export";
import { enqueueNarration } from "~/jobs/narration";
import type { Runner } from "~/jobs/runner";
import { enqueueScripting } from "~/jobs/scripting";
import type { ExportPorts } from "~/providers/encoder";
import type { SpeechGate } from "~/providers/gate";
import { append, chapterUidOf } from "~/usage/ledger";

/** What an endpoint in the world has been through, as the browser's demo keeps it on the endpoint. */
export type SpeechTelemetry = Pick<Endpoint, EndpointTelemetry>;

/** A run to have in flight: on the situation's book, unless it names another. */
export type LiveRun = NonNullable<DemoScenario["runs"]>[number] & { bookId?: string };

export interface DemoLive {
  /** the book the situation is about; the runs and builds are on it */
  bookId: string;
  /** the runs the situation wants in flight once it is seeded (`DemoScenario.runs`) */
  runs: LiveRun[];
  /** books whose build history the situation asked for: one running, one failed, one finished */
  builds: string[];
  /** every speech endpoint's telemetry in the world as the situation left it, by endpoint id */
  speech: Record<string, SpeechTelemetry>;
  /** every scripting profile's telemetry the situation touched, by profile id */
  scripting: Record<string, ScriptEndpointTelemetry>;
}

/** The demo library's parts `startLive` reaches for; never the real library's. */
export interface LiveParts {
  db: Db;
  runner: Runner;
  gate: SpeechGate;
  files: AudioFiles;
  exports: ExportPorts;
}

/**
 * Make what the situation describes real: the ledger rows and cooldowns for its endpoints' telemetry,
 * the builds it asked for, and the runs it wants in flight. Called after the world is written and the
 * queue is started again.
 */
export async function startLive(parts: LiveParts, live: DemoLive): Promise<void> {
  recordTelemetry(parts, live, Date.now());
  for (const bookId of live.builds) seedBuilds(parts, bookId);
  startRuns(parts, live);
}

// ---------- what the endpoints have been through ----------

/** What the Activity list names a request the history recorded and nothing else describes. */
const EARLIER = "Earlier request";

/** How near the last error a failure in the history has to be to be the request that met it. */
const SAME_REQUEST_MS = 1000;

/** A rate limit the telemetry counts and never described. */
const RATE_LIMITED: Omit<ReqError, "at"> = { code: 429, message: "Rate limited", body: "" };

/** One request the telemetry says was made, on its way to being a ledger row. */
interface Made {
  at: number;
  ms: number;
  ok: boolean;
  rateLimited?: boolean;
  error?: ReqError;
  /** the chapter it was for, when the telemetry says */
  bookId?: string;
  chapterId?: number;
}

/** Either kind of telemetry, in the words the ledger needs. */
interface Account {
  points: { at: number; ms: number; ok: boolean }[];
  rateLimits: number;
  lastError?: ReqError & { at: number; bookId?: string; chapterId?: number };
}

const speechAccount = (t: SpeechTelemetry, now: number): Account => ({
  points: t.history.map((p) => ({ at: p.t, ms: p.ms, ok: p.ok })),
  rateLimits: t.rateLimits,
  // a canned error carries no moment; the one it stands for is the latest
  lastError: t.lastError && { ...t.lastError, at: t.lastError.at ?? now },
});

const scriptingAccount = (t: ScriptEndpointTelemetry): Account => ({
  points: t.history,
  rateLimits: t.rateLimits,
  lastError: t.lastError && {
    code: t.lastError.code,
    message: t.lastError.message,
    body: t.lastError.body,
    at: t.lastError.at,
    bookId: t.lastError.bookId ?? undefined,
    chapterId: t.lastError.chapterId ?? undefined,
  },
});

/**
 * The requests an account describes: one for each point of its history; the last error on the
 * failure it was met on, or on a request of its own once the history no longer holds that one; and
 * a refused request for each rate limit the last error is not, a minute apart before it.
 */
function requestsOf({ points, rateLimits, lastError }: Account, now: number): Made[] {
  const made: Made[] = points.map((p) => ({ ...p }));
  let unsaid = rateLimits;
  if (lastError) {
    const { bookId, chapterId, ...error } = lastError;
    let met: Made | undefined;
    for (const m of made) if (!m.ok && Math.abs(m.at - error.at) < SAME_REQUEST_MS) met = m;
    if (!met) made.push((met = { at: error.at, ms: 0, ok: false }));
    Object.assign(met, { error, bookId, chapterId });
    if (error.code === 429) {
      met.rateLimited = true;
      unsaid--;
    }
  }
  const before = lastError?.at ?? now;
  for (let i = 1; i <= unsaid; i++) {
    const at = before - i * 60_000;
    made.push({ at, ms: 0, ok: false, rateLimited: true, error: { ...RATE_LIMITED, at } });
  }
  return made;
}

/** One request, appended as settled: nothing waited for it on this side, and nothing was billed. */
function settle(tx: Tx, kind: EndpointKind, endpointId: string, m: Made): void {
  // a chapter of a book the world has, or none: the row outlives either, and names the work itself
  const bookId = m.bookId && library.getBook(tx, m.bookId) ? m.bookId : null;
  const chapterId = bookId ? m.chapterId : undefined;
  append(
    tx,
    {
      endpointId,
      kind,
      bookId,
      label: chapterId == null ? EARLIER : "Script",
      status: m.ok ? "done" : "failed",
      attempts: 1,
      queuedAt: m.at - m.ms,
      startedAt: m.at - m.ms,
      finishedAt: m.at,
      queueMs: 0,
      responseMs: m.ms,
      usage: {},
      cost: 0,
      costBasis: "calculated",
      ...(m.rateLimited ? { rateLimited: true } : {}),
      ...(m.error ? { error: m.error } : {}),
      simulated: true,
    },
    bookId && chapterId != null ? chapterUidOf(tx, bookId, chapterId) : null,
  );
}

/**
 * Each endpoint's telemetry into the ledger, and a speech endpoint still cooling down into the gate.
 *
 * The gate forgets the world before this one first, so a reset leaves no cooldown behind it. A
 * scripting profile has no cooldown on the server to set — a rate limit there is waited out inside
 * the request that met it (`providers/http.ts`), not held against the profile — so its telemetry is
 * rows alone.
 */
function recordTelemetry({ db, gate }: LiveParts, live: DemoLive, now: number): void {
  gate.forget();
  db.transaction((tx) => {
    for (const [id, t] of Object.entries(live.speech))
      for (const m of requestsOf(speechAccount(t, now), now)) settle(tx, "tts", id, m);
    for (const [id, t] of Object.entries(live.scripting))
      for (const m of requestsOf(scriptingAccount(t), now)) settle(tx, "scripting", id, m);
  });
  for (const [id, t] of Object.entries(live.speech))
    if (t.backoffUntil > now) gate.rateLimited(id, t.backoffUntil - now);
}

// ---------- builds ----------

/**
 * The browser's `_seedBuildHistory`: of the book's narrated chapters, all but the last two in a
 * build that failed and waits for a retry, and all of them in one running now. The finished one is
 * the world's own. One book builds one audiobook at a time here, so the failed build is settled
 * before the running one is asked for.
 */
function seedBuilds(parts: LiveParts, bookId: string): void {
  const book = library.getBook(parts.db, bookId);
  const ids = library
    .listChapters(parts.db, bookId)
    .filter((c) => c.narration === "done")
    .map((c) => c.id);
  if (!book || !ids.length) return;
  const title = book.title || "Audiobook";
  const base: ExportSettings = {
    ...DEFAULT_EXPORT_SETTINGS,
    title,
    series: title,
    author: book.author,
    filename: `${title} (sample)`,
  };
  failedBuild(parts, bookId, ids.slice(0, Math.max(1, ids.length - 2)), {
    ...base,
    filename: `${base.filename} - earlier attempt`,
  });
  enqueueBuild(parts.db, parts.runner, parts.exports, coverFiles(parts.files), bookId, {
    ids,
    settings: { ...base, filename: `${base.filename} - in progress` },
  });
}

/**
 * A build that failed as the browser's fails one (`failBuild`): put up through the same queueing
 * as any build, and settled with the encoder's failure before the worker could claim it. It is
 * queued without waking the worker and settled in the same turn, so no worker ever sees it waiting;
 * its job keeps the settings it was asked with, which is what Retry builds from.
 */
function failedBuild(
  { db, exports: ports, files }: LiveParts,
  bookId: string,
  ids: number[],
  settings: ExportSettings,
): void {
  const held = { enqueue: (input: queue.EnqueueInput) => queue.enqueueJob(db, input) };
  const { job, export: entry } = enqueueBuild(db, held, ports, coverFiles(files), bookId, {
    ids,
    settings,
  });
  const file = entry.files[0]?.name ?? entry.filename;
  const reason = `Encoding stopped while writing ${file}.`;
  queue.appendEvent(db, job.id, `Encoder failed while writing ${file}`, "error", {
    code: "ENC_WRITE",
    detail: "simulated failure",
    previousVersion: entry.replaces ? "still the current export" : "none",
  });
  queue.finishJob(db, job.id, "failed", Date.now(), { error: reason });
  exports.setBuildStatus(db, entry.id, "failed", reason);
}

// ---------- runs ----------

/**
 * The runs the situation wants in flight, queued as the page's buttons queue them: scripting to the
 * profile the seed chose for runs, narration of every line.
 */
function startRuns({ db, runner }: LiveParts, live: DemoLive): void {
  const profile = readScriptSettings(db).profile ?? undefined;
  for (const run of live.runs) {
    const bookId = run.bookId ?? live.bookId;
    if (run.kind === "scripting") enqueueScripting(db, runner, bookId, run.chapterIds, profile);
    else enqueueNarration(db, runner, bookId, run.chapterIds, { scope: "all" });
  }
}
