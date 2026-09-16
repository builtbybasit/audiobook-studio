// The simulated LLM transport for one chapter. Chunk requests go out concurrently against the
// profile's own limit, a shared retry-after window pauses dispatch across every book on the
// endpoint, and the budget is reserved per request rather than charged at the end.
//
// The run's *result* is mock too: on success the chapter's script is regenerated, and the two ways
// a run can differ from the last one — an unverified chunk kept whole, and a genuinely different
// pass over the same prose — are `collapseChunk` and `reseg` below.
import { logJob, jobWaiting, startJob } from "@/lib/jobActivity";
import { scriptParts, tokenEstimate } from "@/lib/scripting";
import { clone } from "@/lib/utils";
import { generateSegments } from "../world/script";
import type { SimulatorContext } from "./context";
import type { Book, Chapter, Job, Profile, ScriptEndpointTelemetry, Segment } from "@/types";

export interface ScriptSimContext extends SimulatorContext {
  /** every job in the queue, not just this run's — concurrency is shared across books. Read
   *  through a call rather than handed over as an array: the store replaces both of these lists. */
  jobs(): Job[];
  /** the live profiles, so pausing or re-tuning one mid-run is noticed on the next tick */
  profiles(): Profile[];
  bookById(id: string): Book | undefined;
  segmentsOf(bookId: string, chId: number): Segment[];
  setSegments(bookId: string, chId: number, segs: Segment[]): void;
  /** the script as it stood before this re-run, when there is one */
  previousSegments(bookId: string, chId: number): Segment[] | undefined;
  absorbCast(bookId: string, chId: number): void;
  scriptSpent(bookId: string): number;
  scriptReserved(bookId: string): number;
  spent(bookId: string): number;
  recordUsage(u: {
    bookId: string;
    profileId: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
  }): void;
  telemetryFor(profileId: string): ScriptEndpointTelemetry;
  cancelJob(id: number): void;
}

export interface ScriptRun {
  bookId: string;
  /** the chapter being scripted */
  c: Chapter;
  job: Job;
  /** a copy taken when the run was planned; `ctx.profiles()` is consulted for live changes */
  profile: Profile;
  /** the prose this run is scripting — the whole chapter, or one fallback chunk */
  textOf: (chId: number) => string;
  /** re-scripting a single fallback chunk rather than the chapter */
  retrySegmentId: number | null;
  /** the rest of this run's queue, cancelled together if the budget runs out */
  jobs: Job[];
  done: () => void;
}

export function simulateScriptRun(ctx: ScriptSimContext, plan: ScriptRun): void {
  const { bookId, c, job, profile, textOf, retrySegmentId, jobs, done } = plan;
  const run = job.scriptRun!;
  const requests = scriptParts(textOf(c.id), profile).map((text) => tokenEstimate(text, profile));
  const active: {
    request: number;
    started: number;
    finish: number;
    usage: ReturnType<typeof tokenEstimate>;
  }[] = [];
  let cursor = 0;
  let checkedRateLimit = false;
  let retriedFirstRequest = false;
  const telemetry = ctx.telemetryFor(profile.id);
  const t = setInterval(() => {
    // the world this run was planned against is gone: stop without writing to the new one
    if (ctx.stale()) {
      clearInterval(t);
      return;
    }
    if (job.cancelled) {
      clearInterval(t);
      run.active = 0;
      run.reserved = 0;
      c.scripting = ctx.segmentsOf(bookId, c.id).length ? "done" : "none";
      c.scriptingProgress = 0;
      ctx.finishJob(job, "cancelled");
      return done();
    }
    // One ordered chapter per book, with concurrent chunk requests sharing the endpoint limit.
    if (
      ctx
        .jobs()
        .some(
          (j) => j.id < job.id && j.bookId === bookId && j.kind === "scripting" && !j.finishedAt,
        )
    ) {
      jobWaiting(job, "An earlier chapter in this book is still scripting");
      return;
    }
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].finish > Date.now()) continue;
      const { usage, started, request } = active.splice(i, 1)[0];
      logJob(job, `Request ${request} completed`, "info", {
        request,
        responseMs: Date.now() - started,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUSD: usage.cost,
      });
      telemetry.completed++;
      telemetry.lastSuccess = Date.now();
      telemetry.history = [
        ...telemetry.history.slice(-29),
        { at: Date.now(), ms: Date.now() - started, ok: true },
      ];
      run.active--;
      run.completed++;
      run.reserved = Math.max(0, run.reserved - usage.reserve);
      run.cost += usage.cost;
      run.inputTokens += usage.inputTokens;
      run.outputTokens += usage.outputTokens;
      ctx.recordUsage({
        bookId,
        profileId: profile.id,
        cost: usage.cost,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    }
    const live = ctx.profiles().find((p) => p.id === profile.id);
    let slots =
      (live?.concurrency ?? 0) -
      ctx
        .jobs()
        .reduce((n, j) => n + (j.scriptRun?.profile.id === profile.id ? j.scriptRun.active : 0), 0);
    jobWaiting(
      job,
      cursor >= requests.length
        ? ""
        : !live
          ? "Endpoint no longer available"
          : !live.enabled
            ? "Endpoint is paused"
            : telemetry.backoffUntil > Date.now()
              ? "Rate-limit cooldown"
              : slots <= 0
                ? "Endpoint concurrency is full"
                : "",
    );
    while (
      live?.enabled &&
      telemetry.backoffUntil <= Date.now() &&
      slots > 0 &&
      cursor < requests.length
    ) {
      const usage = requests[cursor];
      const remaining =
        (ctx.bookById(bookId)?.scriptBudget ?? Infinity) -
        ctx.scriptSpent(bookId) -
        ctx.scriptReserved(bookId);
      const overall =
        (ctx.bookById(bookId)?.budget?.cap ?? Infinity) -
        ctx.spent(bookId) -
        ctx.scriptReserved(bookId);
      if (usage.reserve > Math.min(remaining, overall)) {
        if (!active.length) {
          ctx.toast("Scripting stopped at the budget limit", {
            kind: "warn",
            description:
              "Increase the budget and retry this chapter. Completed request costs are retained.",
          });
          clearInterval(t);
          c.scripting = "failed";
          logJob(job, "Remaining budget cannot cover the next request", "error", {
            requiredUSD: usage.reserve,
            remainingUSD: Math.min(remaining, overall),
          });
          ctx.finishJob(job, "failed");
          for (const pending of jobs) ctx.cancelJob(pending.id);
          done();
        }
        break;
      }
      // Demo transport occasionally receives a 429 before accepting the first request.
      // A shared retry-after window pauses dispatch across every book on this endpoint.
      if (!checkedRateLimit) {
        checkedRateLimit = true;
        if (Math.random() < 0.08) {
          retriedFirstRequest = true;
          const cooldown = live?.cooldownSec ?? 10;
          telemetry.failures++;
          telemetry.rateLimits++;
          telemetry.backoffUntil = Date.now() + cooldown * 1000;
          telemetry.lastError = {
            code: 429,
            message: "Rate limited",
            body: `{"error":{"message":"Too many requests. Retry after ${cooldown} seconds.","type":"rate_limit_error"}}`,
            at: Date.now(),
            bookId,
            chapterId: c.id,
            model: profile.model,
            baseUrl: profile.baseUrl,
          };
          logJob(job, `Request ${cursor + 1} rate limited; retry after ${cooldown}s`, "warning", {
            request: cursor + 1,
            attempt: 1,
            code: 429,
            endpoint: profile.name,
          });
          telemetry.history = [
            ...telemetry.history.slice(-29),
            { at: Date.now(), ms: 0, ok: false },
          ];
          break;
        }
      }
      cursor++;
      slots--;
      run.active++;
      run.reserved += usage.reserve;
      startJob(job);
      logJob(job, `Request ${cursor} started`, "info", {
        request: cursor,
        attempt: cursor === 1 && retriedFirstRequest ? 2 : 1,
        endpoint: profile.name,
        reservedUSD: usage.reserve,
      });
      active.push({
        request: cursor,
        started: Date.now(),
        finish: Date.now() + profile.secPerChunk * 100,
        usage,
      });
      c.scripting = "running";
    }
    c.scriptingProgress = (run.completed / run.requests) * 100;
    job.progress = c.scriptingProgress;
    if (run.completed === run.requests) {
      clearInterval(t);
      const roll = Math.random();
      const outcome = roll < 0.06 ? "failed" : roll < 0.16 ? "fallback" : "done";
      c.scripting = outcome;
      if (outcome !== "done")
        logJob(
          job,
          outcome === "failed"
            ? "Script verification failed"
            : "An unverified chunk was kept as narration for review",
          outcome === "failed" ? "error" : "warning",
        );
      ctx.finishJob(job, outcome === "failed" ? "failed" : "done");
      if (outcome !== "failed") {
        if (retrySegmentId !== null) {
          const cur = ctx.segmentsOf(bookId, c.id);
          const index = cur.findIndex((x) => x.id === retrySegmentId);
          if (index >= 0) {
            const original = cur[index];
            const fresh = generateSegments(bookId, c.id).slice(0, original.fallbackCount ?? 6);
            cur.splice(index, 1, ...fresh);
            cur.forEach((x, i) => (x.id = i + 1));
            c.scripting = cur.some((x) => x.fallback) ? "fallback" : "done";
            c.narration = c.duration ? "stale" : "none";
            ctx.absorbCast(bookId, c.id);
          }
          done();
          return;
        }
        let segs = generateSegments(bookId, c.id, { aliasNoise: true });
        if (outcome === "fallback") segs = collapseChunk(segs); // verifier couldn't reconstruct one chunk → kept whole as narration
        const prev = ctx.previousSegments(bookId, c.id);
        if (prev) {
          // mock a *different* LLM run: a few speakers move, one narration pair merges
          segs = reseg(segs);
          if (c.rescript?.keepEdits)
            for (const p of prev)
              if (p.edited) {
                const t = segs.find((x) => x.text === p.text);
                if (t) {
                  t.speaker = p.speaker;
                  t.direction = p.direction;
                  t.type = p.type;
                  if (p.expressions) t.expressions = clone(p.expressions);
                  t.edited = true;
                }
              }
        }
        ctx.setSegments(bookId, c.id, segs);
        ctx.absorbCast(bookId, c.id);
        c.narration = "none";
        c.narrationProgress = 0;
        c.duration = 0;
      }
      done();
    }
  }, 220);
}

/** The verifier could not reconstruct one chunk, so it was kept whole as narration for review. */
export function collapseChunk(segs: Segment[]): Segment[] {
  const start = 4 + Math.floor(Math.random() * Math.max(1, segs.length - 12)),
    n = 5 + Math.floor(Math.random() * 4);
  const run = segs.slice(start, start + n);
  const merged: Segment = {
    id: 0,
    type: "narration",
    speaker: "Narrator",
    text: run.map((x) => (x.type === "dialogue" ? `“${x.text}”` : x.text)).join(" "),
    direction: "",
    fallback: true,
    fallbackCount: n,
    fallbackMismatch: run[Math.floor(n / 2)].text.slice(0, 40),
    audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
  };
  const out = [...segs.slice(0, start), merged, ...segs.slice(start + n)];
  out.forEach((x, i) => (x.id = i + 1));
  return out;
}

// simulate a re-run of the LLM: same prose, but ~10% of dialogue re-attributed and one narration pair merged
export function reseg(segs: Segment[]): Segment[] {
  const speakers = [...new Set(segs.filter((x) => x.type === "dialogue").map((x) => x.speaker))];
  const out = segs.map((x) => ({ ...x }));
  out.forEach((x, i) => {
    if (x.type === "dialogue" && speakers.length > 1 && i % 9 === 3)
      x.speaker = speakers[(speakers.indexOf(x.speaker) + 1) % speakers.length];
  });
  const i = out.findIndex((x, k) => x.type === "narration" && out[k + 1]?.type === "narration");
  if (i >= 0) {
    out[i].text = out[i].text + " " + out[i + 1].text;
    out.splice(i + 1, 1);
  }
  out.forEach((x, k) => {
    x.id = k + 1;
    x.audio = { status: "none", endpoint: null, ms: 0, duration: 0 };
  });
  return out;
}
