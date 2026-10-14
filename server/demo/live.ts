// The part of a demo situation that is not a row: runs in flight become real jobs, and endpoint
// telemetry becomes request-ledger rows (free, marked simulated) plus speech-gate cooldowns.
// `startLive` applies it once the world is written and the queue runs again.
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

export type SpeechTelemetry = Pick<Endpoint, EndpointTelemetry>;

/** A run to have in flight: on the situation's book, unless it names another. */
export type LiveRun = NonNullable<DemoScenario["runs"]>[number] & { bookId?: string };

export interface DemoLive {
  bookId: string;
  runs: LiveRun[];
  /** books to give a build history: one running, one failed, one finished */
  builds: string[];
  /** by endpoint id */
  speech: Record<string, SpeechTelemetry>;
  /** by profile id */
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

export async function startLive(parts: LiveParts, live: DemoLive): Promise<void> {
  recordTelemetry(parts, live, Date.now());
  for (const bookId of live.builds) seedBuilds(parts, bookId);
  startRuns(parts, live);
}

// ---------- what the endpoints have been through ----------

const EARLIER = "Earlier request";

/** How near the last error a failed history point must be to count as the same request. */
const SAME_REQUEST_MS = 1000;

const RATE_LIMITED: Omit<ReqError, "at"> = { code: 429, message: "Rate limited", body: "" };

interface Made {
  at: number;
  ms: number;
  ok: boolean;
  rateLimited?: boolean;
  error?: ReqError;
  bookId?: string;
  chapterId?: number;
}

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
 * One request per history point; the last error lands on its matching failure (or a new request);
 * each remaining rate limit becomes a refused request, a minute apart before it.
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

function settle(tx: Tx, kind: EndpointKind, endpointId: string, m: Made): void {
  // only link a book the world still has
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
 * Telemetry into the ledger, and speech cooldowns into the gate (forgotten first, so a reset leaves
 * none). Scripting has no server-side cooldown: a rate limit is waited out in the request
 * (`providers/http.ts`).
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
 * A failed build of all but the last two narrated chapters, then a running build of all of them
 * (the finished one is the world's own). The failed one settles first: one build per book at once.
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
 * Queued like any build but without waking the worker, then failed in the same turn so no worker
 * sees it. Its job keeps its settings for Retry.
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

/** Queued as the page's buttons queue them. */
function startRuns({ db, runner }: LiveParts, live: DemoLive): void {
  const profile = readScriptSettings(db).profile ?? undefined;
  for (const run of live.runs) {
    const bookId = run.bookId ?? live.bookId;
    if (run.kind === "scripting") enqueueScripting(db, runner, bookId, run.chapterIds, profile);
    else enqueueNarration(db, runner, bookId, run.chapterIds, { scope: "all" });
  }
}
