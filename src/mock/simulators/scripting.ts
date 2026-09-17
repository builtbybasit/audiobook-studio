// The simulated LLM transport for one chapter. Chunk requests go out concurrently against the
// profile's own limit, a shared retry-after window pauses dispatch across every book on the
// endpoint, and the budget is reserved per request rather than charged at the end.
//
// The run's *result* is mock too: on success the chapter's script is regenerated, and the two ways
// a run can differ from the last one — an unverified chunk kept whole, and a genuinely different
// pass over the same prose — are `collapseChunk` and `reseg` below.
import { logJob, jobWaiting, startJob } from "@/lib/jobActivity";
import { PRICING_RULE, money, priceRequest, pricingOf } from "@/lib/pricing";
import { scriptParts, tokenEstimate } from "@/lib/scripting";
import { clone } from "@/lib/utils";
import { generateSegments } from "@/mock/world/script";
import {
  cacheShapeFor,
  reportedChargeFor,
  reportsOwnCost,
  simulateUsage,
  usageFormatFor,
} from "@/mock/simulators/usage";
import { clock, simMs } from "@/mock/simulators/clock";
import type { SimulatorContext } from "@/mock/simulators/context";
import type {
  Book,
  Chapter,
  Job,
  PricedRequest,
  Profile,
  RescriptReport,
  ScriptEndpointTelemetry,
  Segment,
} from "@/types";

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
  /** what the run could and could not re-apply of the chapter's manual corrections */
  noteCorrections(bookId: string, chId: number, report: RescriptReport): void;
  absorbCast(bookId: string, chId: number): void;
  scriptSpent(bookId: string): number;
  scriptReserved(bookId: string): number;
  /** held against the book's cap by unfinished work of either stage */
  reserved(bookId: string): number;
  spent(bookId: string): number;
  /** One completed request, appended to the ledger with the receipt it was priced from. Nothing
   *  re-prices it and nothing removes it; it is the only record of what this run cost. */
  recordUsage(u: {
    bookId: string;
    chapterId: number | null;
    profileId: string;
    /** 1-based index within this chapter's run */
    request: number;
    attempts: number;
    queuedAt: number;
    startedAt: number;
    finishedAt: number;
    /** the receipt: usage, rates and reasoning, frozen when this request completed */
    priced: PricedRequest;
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
  // The rate card this run is priced against. Taken from the profile *by reference to its id* each
  // time a request settles would be wrong the other way — a rate edited mid-run must not re-price
  // requests that already landed — so the card is captured here and each request reads the rates in
  // force at its own completion instant from this captured card.
  const pricing = pricingOf(profile);
  const format = usageFormatFor(profile.model, profile.baseUrl);
  /** whether this provider caches prompts at all: only one that reports cache detail can */
  const cacheable = format !== "plain";
  /** some providers bill and report a charge per request; that number beats our arithmetic */
  const reportsCost = reportsOwnCost(profile.name, profile.baseUrl);
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
      // Nothing was written: a cancelled re-script leaves the script it was replacing exactly where
      // it was, so the chapter goes back to the status it had rather than reading as unscripted.
      settleWithoutWriting(ctx, bookId, c, job, true);
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
      // Each request is priced at its own completion instant, from the rates in force *then* and
      // from what the provider actually reported — never from the rates the run started at. A batch
      // that straddles an off-peak boundary or a promotion expiry therefore charges its requests
      // differently, which is the truth, and every receipt says which instant it used.
      const at = Date.now();
      const { raw, usage: reported } = simulateUsage(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...cacheShapeFor(request, cacheable),
        },
        format,
      );
      // A provider that bills per request reports its own charge, and it will not match ours to the
      // cent — its tokeniser and its rounding are not ours. The receipt keeps both figures, so the
      // difference is visible rather than quietly resolved in our favour.
      if (reportsCost)
        reported.reportedCost = reportedChargeFor(
          priceRequest(pricing.base, pricing.config, reported, { at }).calculated ?? 0,
        );
      const priced = priceRequest(pricing.base, pricing.config, reported, {
        at,
        rule: PRICING_RULE,
        preferReported: reportsCost,
      });
      const charged = priced.total ?? 0;
      logJob(job, `Request ${request} completed`, "info", {
        request,
        responseMs: Math.round((at - started) * clock.speed),
        usageFormat: format,
        providerUsage: JSON.stringify(raw),
        inputTokens: reported.inputTokens,
        cachedInput: reported.cachedInput ?? "not reported",
        cacheWrite: reported.cacheWrite ?? "not reported",
        outputTokens: reported.outputTokens,
        pricedAt: new Date(at).toISOString(),
        pricingRule: priced.rule,
        inputRate: money(priced.rates.input.rate ?? 0) + " / 1M",
        outputRate: money(priced.rates.output.rate ?? 0) + " / 1M",
        ...(priced.rates.input.why.length ? { why: priced.rates.input.why.join(" · ") } : {}),
        costUSD: charged,
        costBasis: priced.basis,
        ...(priced.unknowns.length ? { notKnown: priced.unknowns.join(" ") } : {}),
      });
      telemetry.completed++;
      telemetry.lastSuccess = at;
      telemetry.history = [
        ...telemetry.history.slice(-29),
        { at, ms: Math.round((at - started) * clock.speed), ok: true },
      ];
      run.active--;
      run.completed++;
      run.reserved = Math.max(0, run.reserved - usage.reserve);
      run.cost += charged;
      run.inputTokens += reported.inputTokens;
      run.outputTokens += reported.outputTokens;
      run.cachedInput = (run.cachedInput ?? 0) + (reported.cachedInput ?? 0);
      if (reported.cachedInput == null) run.cacheUnreported = (run.cacheUnreported ?? 0) + 1;
      ctx.recordUsage({
        bookId,
        chapterId: c.id,
        profileId: profile.id,
        request,
        // the first request of a run that was refused once went out twice
        attempts: request === 1 && retriedFirstRequest ? 2 : 1,
        queuedAt: job.queuedAt,
        startedAt: started,
        finishedAt: at,
        priced,
      });
    }
    if (ctx.paused(bookId)) {
      jobWaiting(job, "Book is paused");
      return;
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
        (ctx.bookById(bookId)?.budget?.cap ?? Infinity) - ctx.spent(bookId) - ctx.reserved(bookId);
      if (usage.reserve > Math.min(remaining, overall)) {
        if (!active.length) {
          ctx.toast("Scripting stopped at the budget limit", {
            kind: "warn",
            description:
              "Increase the budget and retry this chapter. Completed request costs are retained.",
          });
          clearInterval(t);
          logJob(job, "Remaining budget cannot cover the next request", "error", {
            requiredUSD: usage.reserve,
            remainingUSD: Math.min(remaining, overall),
          });
          settleWithoutWriting(ctx, bookId, c, job, false);
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
        finish: Date.now() + simMs(profile.secPerChunk * 100),
        usage,
      });
      c.scripting = "running";
    }
    c.scriptingProgress = (run.completed / run.requests) * 100;
    job.progress = c.scriptingProgress;
    if (run.completed === run.requests) {
      clearInterval(t);
      reconcile(job);
      const roll = Math.random();
      const outcome = roll < 0.06 ? "failed" : roll < 0.16 ? "fallback" : "done";
      if (outcome === "failed") {
        logJob(job, "Script verification failed", "error");
        settleWithoutWriting(ctx, bookId, c, job, false);
        ctx.finishJob(job, "failed");
        return done();
      }
      // A result belonging to a run this chapter has moved on from — a newer run was started, or a
      // version was restored — must not land on top of what replaced it.
      if (c.rescript && c.rescript.token !== job.id) {
        logJob(
          job,
          "Result discarded: this chapter changed while the run was in flight",
          "warning",
          { chapter: c.id },
        );
        settleWithoutWriting(ctx, bookId, c, job, true);
        ctx.finishJob(job, "cancelled");
        return done();
      }
      c.scripting = outcome;
      if (outcome === "fallback")
        logJob(job, "An unverified chunk was kept as narration for review", "warning");
      if (retrySegmentId !== null) {
        const cur = ctx.segmentsOf(bookId, c.id);
        const index = cur.findIndex((x) => x.id === retrySegmentId);
        if (index >= 0) {
          const original = cur[index];
          const fresh = generateSegments(bookId, c.id).slice(0, original.fallbackCount ?? 6);
          // the whole chapter goes back through `setSegments`: one write path, so the script this
          // re-split replaces is preserved exactly as a full re-script's would be
          const next = [...cur.slice(0, index), ...fresh, ...cur.slice(index + 1)].map((x, i) =>
            x.id === i + 1 ? x : { ...x, id: i + 1 },
          );
          ctx.setSegments(bookId, c.id, next);
          c.scripting = next.some((x) => x.fallback) ? "fallback" : "done";
          c.narration = c.duration ? "stale" : "none";
          ctx.absorbCast(bookId, c.id);
        }
        delete c.rescript;
        ctx.finishJob(job, "done");
        done();
        return;
      }
      let segs = generateSegments(bookId, c.id, { aliasNoise: true });
      if (outcome === "fallback") segs = collapseChunk(segs); // verifier couldn't reconstruct one chunk → kept whole as narration
      const prev = ctx.previousSegments(bookId, c.id);
      if (prev) {
        // mock a *different* LLM run: a few speakers move, one narration pair merges
        segs = reseg(segs);
        const asked = !!c.rescript?.keepEdits;
        const report = reapplyCorrections(prev, segs, asked);
        ctx.noteCorrections(bookId, c.id, {
          profile: profile.name,
          model: profile.model,
          asked,
          ...report,
        });
        logJob(
          job,
          asked
            ? `Manual corrections: ${report.kept} re-applied, ${report.unmatched.length} could not be`
            : `${report.unmatched.length} manual corrections discarded as asked`,
          report.unmatched.length ? "warning" : "info",
          {
            reApplied: report.kept,
            unmatched: report.unmatched.length,
            ...(report.unmatched.length
              ? { why: "the new script does not have the line the correction was made on" }
              : {}),
          },
        );
      }
      ctx.setSegments(bookId, c.id, segs);
      ctx.absorbCast(bookId, c.id);
      delete c.rescript;
      c.narration = "none";
      c.narrationProgress = 0;
      c.duration = 0;
      ctx.finishJob(job, "done");
      done();
    }
  }, 220);
}

/**
 * Say how the estimate held up, once every request has come back.
 *
 * The estimate was conservative on purpose — no cache savings, at the rates in force when the run
 * was planned — so the real figure is usually lower and the difference is worth naming rather than
 * leaving as a number nobody reconciles. The cached tokens that came back are what explains most of
 * it; requests whose provider reported no cache detail are counted separately, because those are
 * the ones whose cost is an upper bound rather than a fact.
 */
function reconcile(job: Job): void {
  const run = job.scriptRun;
  if (!run || run.estimated == null) return;
  const cached = run.cachedInput ?? 0;
  const unreported = run.cacheUnreported ?? 0;
  const delta = run.cost - run.estimated;
  logJob(job, "Estimate reconciled against reported usage", "info", {
    estimatedUSD: run.estimated,
    chargedUSD: run.cost,
    difference: `${delta >= 0 ? "+" : ""}${money(delta)}`,
    inputTokens: run.inputTokens,
    cachedInputTokens: cached,
    cacheShare: run.inputTokens ? `${Math.round((cached / run.inputTokens) * 100)}%` : "0%",
    ...(unreported
      ? {
          unreportedCache: `${unreported} of ${run.requests} requests reported no cache detail; their cost is an upper bound`,
        }
      : {}),
  });
}

/**
 * A run that produced nothing leaves the chapter as it found it. A chapter that still holds a
 * script goes back to reading as scripted — a failed or cancelled *replacement* must not make
 * finished work look unscripted, unnarratable and unexportable — and one that never had a script
 * reads as failed, or as untouched when it was simply called off.
 */
function settleWithoutWriting(
  ctx: ScriptSimContext,
  bookId: string,
  c: Chapter,
  job: Job,
  cancelled: boolean,
): void {
  const was = c.rescript?.was;
  const kept = ctx.segmentsOf(bookId, c.id).length;
  c.scripting = kept
    ? was === "done" || was === "fallback"
      ? was
      : "done"
    : cancelled
      ? (was ?? "none")
      : "failed";
  c.scriptingProgress = 0;
  if (kept)
    logJob(
      job,
      cancelled
        ? "Cancelled before a script was written; the previous script is unchanged"
        : "Nothing was written; the previous script is unchanged",
      "warning",
      { lines: kept, chapterStatus: c.scripting },
    );
  delete c.rescript; // nothing from this run may land on the chapter afterwards
}

/**
 * Carry the manual corrections of the previous script onto the new one, and say what could not be
 * carried. A correction belongs to the line it was made on, so it is re-applied when the new run
 * wrote that line the same way; a line the new run rewrote, split or dropped takes its correction
 * with it, and that correction is named rather than quietly lost.
 */
export function reapplyCorrections(
  prev: Segment[],
  next: Segment[],
  keepEdits: boolean,
): Pick<RescriptReport, "kept" | "unmatched"> {
  const corrections = prev.filter((p) => p.edited);
  const unmatched: RescriptReport["unmatched"] = [];
  let kept = 0;
  const taken = new Set<number>();
  for (const p of corrections) {
    const target = keepEdits ? next.find((x) => x.text === p.text && !taken.has(x.id)) : undefined;
    if (!target) {
      unmatched.push({
        speaker: p.speaker,
        text: p.text,
        direction: p.direction ?? "",
        type: p.type,
      });
      continue;
    }
    taken.add(target.id);
    target.speaker = p.speaker;
    target.direction = p.direction;
    target.type = p.type;
    if (p.expressions) target.expressions = clone(p.expressions);
    target.edited = true;
    kept++;
  }
  return { kept, unmatched };
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
