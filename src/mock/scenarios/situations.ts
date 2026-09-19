// What each Demo tools row does to the world.
//
// A situation is applied to a world that has just been restored to its seeded state, so every
// function here can assume the book it is handed is the pristine one and say plainly what it
// changes. That is what makes the rows repeatable: picking the same row twice, or picking three
// others in between, gives the same situation every time.
//
// Nothing here starts a timer or touches a store. A situation mutates the entities the context
// hands it and reports what it did; the caller owns the state, the queue and the clock — exactly
// the split the simulators use.
import { money as rateMoney, promotionRunning } from "@/lib/pricing";
import { clockLabel, localTimezone } from "@/lib/wallClock";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { snapshotScript } from "@/lib/scriptHistory";
import { snapshotTake } from "@/lib/takes";
import { EXPRESSION_TAGS } from "@/mock/fixtures/endpoints";
import { gapsOf } from "@/lib/gaps";
import { SHELF_BOOKS, type ShelfBook } from "@/mock/fixtures/shelf";
import { voiceRef } from "@/mock/fixtures/voices";
import { routeOf, seedClip, type ClipWorld } from "@/mock/world/audio";
import { exportDemoPrep, freshenChapters } from "@/mock/scenarios/export";
import { applySearchDemo, searchDemoTarget } from "@/mock/scenarios/search";
import type {
  Book,
  Chapter,
  Character,
  DemoResult,
  HistoryHead,
  JobKind,
  JobStatus,
  Profile,
  RateWindow,
  ScriptEndpointTelemetry,
  ScriptVersion,
  Segment,
} from "@/types";

/** A row an earlier session would have left in the queue: finished, and there to be acted on. */
export interface HistoryRow {
  kind: JobKind;
  bookId: string;
  chapterId: number | null;
  label: string;
  status: JobStatus;
  /** how long ago it started */
  minutesAgo: number;
  /** how long it took */
  seconds: number;
  /** the bulk run this chapter belonged to, when it was one chapter of several */
  bulk?: { id: number; op: string; index: number; total: number; scope?: string };
  /**
   * What the run reported, oldest first, without timestamps — the caller dates these between the
   * row's start and its finish. A failed row needs the reason here: the Queue's detail panel is
   * where a failure is diagnosed, and a log that says only "Job queued" cannot be read.
   */
  activity?: {
    level?: "info" | "warning" | "error";
    message: string;
    detail?: Record<string, string | number>;
  }[];
}

/**
 * The slice of the application a situation is allowed to reach for. Like `SimulatorContext`, it is
 * declared here rather than implied by a store handle: what a scenario can touch is readable at the
 * top of this file, and the store stays the only place reactive state is defined.
 */
export interface ScenarioContext {
  now(): number;
  /** the cast, dictionaries and endpoints a seeded clip has to agree with */
  world: ClipWorld;
  book(bookId: string): Book | undefined;
  chapters(bookId: string): Chapter[];
  cast(bookId: string): Character[];
  segmentsOf(bookId: string, chId: number): Segment[];
  /** back to a chapter nothing has been run on: no script, no saved revision and no history */
  clearScript(bookId: string, chId: number): void;
  /** the versions a chapter's script has been through, as an earlier session would have left them */
  seedHistory(
    bookId: string,
    chId: number,
    history: { versions: Omit<ScriptVersion, "id">[]; head: HistoryHead },
  ): void;
  profiles(): Profile[];
  telemetry(profileId: string): ScriptEndpointTelemetry;
  addHistory(row: HistoryRow): void;
  clearJobs(bookId: string): void;
  clearExports(bookId: string): void;
  /** a build running now, one that failed and is waiting for a retry, and one that finished */
  seedBuilds(bookId: string): void;
  /** what this book has cost so far, for a budget that is meant to have run out */
  spent(bookId: string): number;
  addScriptUsage(bookId: string, profileId: string, cost: number): void;
  /** the chapter's running time, after its clips changed */
  retime(bookId: string, chId: number): void;
  /** an EPUB just read, waiting in the contents review; returns the book's id */
  importSample(sampleId: string, bookId: string): string;
  /** a book straight onto the shelf, its review already done; returns the book's id */
  shelveBook(spec: ShelfBook): string;
  /** an audiobook built earlier from exactly these chapters, as they stand now */
  addFinishedExport(bookId: string, ids: number[]): void;
}

const rateLimitBody = (cooldown: number): string =>
  `{"error":{"message":"Rate limit reached. Please retry after ${cooldown} seconds.","type":"rate_limit_error"}}`;

const money = (n: number): string => "$" + n.toFixed(2);

const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

/** Apply one situation to the seeded world and say what it did. Unknown ids do nothing. */
export function applySituation(ctx: ScenarioContext, id: string, bookId: string): DemoResult {
  if (id.startsWith("import-")) return importReview(ctx, id.slice("import-".length), bookId);
  switch (id) {
    case "full-shelf":
      return fullShelf(ctx);
    case "fresh-book":
      return freshBook(ctx, bookId);
    case "resume-book":
      return partWayThrough(ctx, bookId);
    case "scripting-failed":
      return scriptingTrouble(ctx, bookId);
    case "narration-failed":
      return narrationTrouble(ctx, bookId);
    case "no-voices":
      return missingVoices(ctx, bookId);
    case "budget-spent":
      return budgetSpent(ctx, bookId);
    case "stale-audio":
      return staleAndRetakes(ctx, bookId);
    case "mis-attributed":
      return misAttributed(ctx, bookId);
    case "script-history":
      return chapterHistory(ctx, bookId);
    case "bulk-rework":
      return bulkRework(ctx, bookId);
    case "bulk-recovery":
      return bulkRecovery(ctx, bookId);
    case "expressions":
      return expressionsPlaced(ctx, bookId);
    case "cache-mix":
      return cacheMix(ctx);
    case "off-peak":
      return offPeakNow(ctx);
    case "promo-live":
      return promotionsLive(ctx);
    case "promo-expired":
      return promotionsExpired(ctx);
    case "rate-boundary":
      return rateBoundary(ctx);
    case "speech-discount":
      return speechDiscount(ctx);
    case "billing-models":
      return billingModels(ctx, bookId);
    default:
      return exportSituation(ctx, id, bookId);
  }
}

// ---------- a full shelf ----------

/**
 * Eighteen more books, each left at one point in the pipeline. Their reviews are done — flagged
 * chapters skipped, the ones to look at kept — so the shelf reads them as books, not imports.
 * The chapter flags are set directly: these books are here to be found, filtered and ordered,
 * not to be scripted, and the seeded four remain the ones with real scripts and clips.
 */
function fullShelf(ctx: ScenarioContext): DemoResult {
  const counts: Record<string, number> = {};
  for (const spec of SHELF_BOOKS) {
    const id = ctx.shelveBook(spec);
    const chapters = ctx.chapters(id);
    for (const c of chapters) {
      if (c.note?.verdict === "skip") c.excluded = true;
      else if (c.note) c.kept = true;
    }
    const inBook = chapters.filter((c) => !c.excluded);
    const n = inBook.length;
    const script = (c: Chapter) => {
      c.scripting = "done";
      c.scriptingProgress = 100;
    };
    const narrate = (c: Chapter) => {
      script(c);
      c.narration = "done";
      c.narrationProgress = 100;
      c.duration = Math.round((c.words / 150) * 60);
    };
    switch (spec.state) {
      case "fresh":
        break;
      case "scripting":
        inBook.slice(0, Math.ceil(n / 3)).forEach(script);
        break;
      case "narrating":
        inBook.forEach(script);
        inBook.slice(0, Math.floor(n / 2)).forEach(narrate);
        break;
      case "failed": {
        const half = Math.ceil(n / 2);
        inBook.slice(0, half).forEach(script);
        for (const c of inBook.slice(half, half + 2)) {
          c.scripting = "failed";
          ctx.addHistory({
            kind: "scripting",
            bookId: id,
            chapterId: c.id,
            label: `Script · ch ${c.id}`,
            status: "failed",
            minutesAgo: 35 + c.id,
            seconds: 14,
            activity: [
              { message: "Scripting plan prepared", detail: { requests: 3 } },
              {
                level: "error",
                message: "The scripting endpoint returned 502 Bad Gateway",
                detail: { status: 502 },
              },
            ],
          });
        }
        break;
      }
      case "stale":
        inBook.forEach(narrate);
        for (const c of inBook.slice(1, 4)) c.narration = "stale";
        break;
      case "ready":
        inBook.forEach(narrate);
        break;
      case "built":
        inBook.forEach(narrate);
        ctx.addFinishedExport(
          id,
          inBook.map((c) => c.id),
        );
        break;
      case "behind":
        // built before the last three chapters were narrated
        inBook.forEach(narrate);
        ctx.addFinishedExport(
          id,
          inBook.slice(0, n - 3).map((c) => c.id),
        );
        break;
    }
    counts[spec.state] = (counts[spec.state] ?? 0) + 1;
  }
  const failed = SHELF_BOOKS.filter((b) => b.state === "failed").length;
  const behind = SHELF_BOOKS.filter((b) => b.state === "behind").length;
  return {
    note:
      `${SHELF_BOOKS.length} books added to the shelf: ${failed} with failed scripting, ` +
      `${behind} whose audiobook is behind the book, and the rest at every step between.`,
  };
}

// ---------- expressions on a line ----------

/**
 * Two dialogue lines in the first scripted chapter: one with a sigh before it and a softer
 * delivery placed mid-line, both fine; the next with a laugh whose anchor the text moved out from
 * under, so it asks to be placed again. The reader opens on the first.
 */
function expressionsPlaced(ctx: ScenarioContext, bookId: string): DemoResult {
  const chapter = ctx.chapters(bookId).find(isScripted);
  if (!chapter)
    return { note: "Nothing is scripted, so there is no line to place an expression on." };
  const lines = ctx
    .segmentsOf(bookId, chapter.id)
    .filter((s) => s.type === "dialogue" && s.speaker !== "Narrator" && s.text.length > 24);
  const [a, b] = lines;
  const tag = (id: string) => EXPRESSION_TAGS.find((t) => t.id === id)!;
  if (a) {
    const gaps = gapsOf(a.text, "split");
    const mid = gaps[Math.floor(gaps.length / 2)]?.at ?? 0;
    a.expressions = [
      { ...tag("sighs"), annotationId: 1, at: 0 },
      { ...tag("softly"), annotationId: 2, at: mid },
    ];
    a.edited = true;
    if (a.audio.status === "done") a.audio.status = "stale";
  }
  if (b) {
    const first = gapsOf(b.text, "split")[0]?.at ?? 0;
    b.expressions = [{ ...tag("laughs"), annotationId: 1, at: first, needsReview: true }];
    b.edited = true;
    if (b.audio.status === "done") b.audio.status = "stale";
  }
  return {
    note: `Two expressions placed on line ${a?.id ?? "?"}, and one on line ${b?.id ?? "?"} that needs its position chosen again.`,
    open: a ? `/book/${bookId}/scripting?ch=${chapter.id}&seg=${a.id}` : undefined,
  };
}

// ---------- importing an EPUB ----------

/** A file just read, with nothing decided: the review opens on it exactly as the import left it. */
function importReview(ctx: ScenarioContext, sampleId: string, bookId: string): DemoResult {
  ctx.importSample(sampleId, bookId);
  const chapters = ctx.chapters(bookId);
  const suggested = chapters.filter((c) => c.note?.verdict === "skip").length;
  const review = chapters.filter((c) => c.note?.verdict === "review").length;
  return {
    note:
      `${plural(chapters.length, "chapter")} read from the file` +
      (suggested ? `, ${suggested} suggested for skipping` : "") +
      (review ? `, ${review} to look at` : "") +
      (!suggested && !review ? ", nothing flagged" : "") +
      ". Nothing is added until you confirm.",
  };
}

// ---------- starting a book ----------

/** A book as it stands the moment its EPUB finished importing: chapters, and nothing else. */
function freshBook(ctx: ScenarioContext, bookId: string): DemoResult {
  const chapters = ctx.chapters(bookId);
  for (const c of chapters) {
    c.scripting = "none";
    c.scriptingProgress = 0;
    c.narration = "none";
    c.narrationProgress = 0;
    c.duration = 0;
    delete c.rescript;
    ctx.clearScript(bookId, c.id);
  }
  // a book nothing has been run on has no cast yet — every speaker is found by scripting it
  const cast = ctx.cast(bookId);
  const narrator = cast.find((c) => c.name === "Narrator");
  cast.splice(0, cast.length, ...(narrator ? [narrator] : []));
  ctx.clearExports(bookId);
  ctx.clearJobs(bookId);
  const skipped = chapters.filter((c) => c.excluded).length;
  return {
    note:
      `${plural(chapters.length, "chapter")} imported and nothing run on any of them` +
      (skipped ? `, ${plural(skipped, "chapter")} already marked as matter to skip` : "") +
      ". The cast is the Narrator alone.",
  };
}

/** Work in progress: enough finished to be worth resuming, enough unfinished to have to decide. */
function partWayThrough(ctx: ScenarioContext, bookId: string): DemoResult {
  const chapters = ctx.chapters(bookId);
  const scripted = chapters.filter(isScripted).length;
  const narrated = chapters.filter(isNarrated).length;
  const stale = chapters.filter((c) => c.narration === "stale").length;
  const failed = chapters.filter((c) => c.narration === "failed" || c.scripting === "failed");
  const unverified = chapters.filter((c) => c.scripting === "fallback");
  return {
    note:
      `${scripted} of ${plural(chapters.length, "chapter")} scripted, ${narrated} narrated` +
      (stale ? `, ${stale} stale` : "") +
      (failed.length ? `, ch ${failed.map((c) => c.id).join(" and ")} failed` : "") +
      (unverified.length ? `, ch ${unverified[0].id} kept an unverified chunk` : "") +
      ". More chapters are scripting now.",
  };
}

// ---------- runs that go wrong ----------

/** Two chapters that kept nothing, and a scripting endpoint inside a retry-after window. */
function scriptingTrouble(ctx: ScenarioContext, bookId: string): DemoResult {
  const chapters = ctx.chapters(bookId);
  const targets = chapters.filter((c) => c.id === 2 || c.id === 3);
  const profile = ctx.profiles().find((p) => p.enabled) ?? ctx.profiles()[0];
  const cooldown = profile.cooldownSec ?? 20;
  // the scenario owns this book's queue: the sample history has its own failed row for one of these
  // chapters, and two rows for one failure is a queue nobody can read
  ctx.clearJobs(bookId);
  const first = chapters[0];
  if (first)
    ctx.addHistory({
      kind: "scripting",
      bookId,
      chapterId: first.id,
      label: `Script · ch ${first.id}`,
      status: "done",
      minutesAgo: 12,
      seconds: 27,
      activity: [
        {
          message: "Scripting plan prepared",
          detail: { endpoint: profile.name, model: profile.model, requests: 4 },
        },
        { message: "4 of 4 requests completed", detail: { costUSD: 0.02 } },
      ],
    });
  for (const c of targets) {
    c.scripting = "failed";
    c.scriptingProgress = 0;
    delete c.rescript;
    ctx.clearScript(bookId, c.id);
    // the account the Queue's detail panel is read from: what was tried, what came back, why it
    // ended where it did
    ctx.addHistory({
      kind: "scripting",
      bookId,
      chapterId: c.id,
      label: `Script · ch ${c.id}`,
      status: "failed",
      minutesAgo: 4 + c.id,
      seconds: 31 + c.id,
      activity: [
        {
          message: "Scripting plan prepared",
          detail: {
            endpoint: profile.name,
            model: profile.model,
            requests: 4,
            concurrency: profile.concurrency,
          },
        },
        {
          message: "Request 1 started",
          detail: { request: 1, attempt: 1, endpoint: profile.name },
        },
        {
          level: "warning",
          message: `Request 1 rate limited; retry after ${cooldown}s`,
          detail: { request: 1, attempt: 1, code: 429, endpoint: profile.name },
        },
        {
          level: "warning",
          message: `Waiting: Rate-limit cooldown`,
          detail: { retryAfterSec: cooldown },
        },
        {
          level: "error",
          message: "Script verification failed",
          detail: {
            request: 2,
            reason: "the model's segments could not be matched back to the chapter text",
            kept: "nothing — the chapter is unchanged",
          },
        },
      ],
    });
  }
  const t = ctx.telemetry(profile.id);
  t.failures += targets.length;
  t.rateLimits += 1;
  t.backoffUntil = ctx.now() + cooldown * 1000;
  t.lastError = {
    code: 429,
    message: "Rate limited",
    body: rateLimitBody(cooldown),
    at: ctx.now(),
    bookId,
    chapterId: targets.at(-1)?.id ?? 1,
    model: profile.model,
    baseUrl: profile.baseUrl,
  };
  t.history = [
    ...t.history.slice(-28),
    { at: ctx.now() - 9000, ms: 0, ok: false },
    { at: ctx.now(), ms: 0, ok: false },
  ];
  return {
    note: `Ch ${targets.map((c) => c.id).join(" and ")} kept nothing, ${profile.name} is rate-limited for ${cooldown}s, and both rows are in the queue to retry.`,
  };
}

/** One chapter with failed clips, one only part rendered, and the endpoint backing off. */
function narrationTrouble(ctx: ScenarioContext, bookId: string): DemoResult {
  const chapters = ctx.chapters(bookId);
  const already = chapters.filter((c) => c.narration === "failed");
  // the scenario owns this book's queue, so every failed row here carries the account that explains
  // it rather than the sample history's bare one
  ctx.clearJobs(bookId);
  const done = chapters.find((c) => c.narration === "done");
  if (done)
    ctx.addHistory({
      kind: "narration",
      bookId,
      chapterId: done.id,
      label: `Narrate · ch ${done.id}`,
      status: "done",
      minutesAgo: 21,
      seconds: 61,
      activity: [
        {
          message: "Narration plan prepared",
          detail: { clips: ctx.segmentsOf(bookId, done.id).length },
        },
        { message: "Every clip rendered", detail: { failed: 0 } },
      ],
    });
  for (const c of already)
    ctx.addHistory({
      kind: "narration",
      bookId,
      chapterId: c.id,
      label: `Narrate · ch ${c.id}`,
      status: "failed",
      minutesAgo: 14,
      seconds: 58,
      activity: [
        {
          message: "Narration plan prepared",
          detail: { clips: ctx.segmentsOf(bookId, c.id).length },
        },
        {
          level: "error",
          message: "Segments failed: the endpoint returned a server error",
          detail: {
            code: 500,
            body: "the provider had an error while processing the request",
            retry: "Retry failed clips renders only those lines",
          },
        },
      ],
    });
  // the next scripted chapter that has never been narrated: a run that got part-way and stopped
  const partial = chapters.find((c) => isScripted(c) && c.narration === "none" && !c.excluded);
  let failedClips = 0;
  let endpointId = "";
  if (partial) {
    const segs = ctx.segmentsOf(bookId, partial.id);
    segs.forEach((s, i) => {
      const ep = routeOf(ctx.world, bookId, s.speaker);
      endpointId ||= ep.id;
      if (i % 6 === 2) {
        s.audio = {
          status: "failed",
          endpoint: ep.id,
          ms: 0,
          duration: 0,
          error: {
            code: 429,
            message: "rate limited",
            body: rateLimitBody(ep.cooldownSec ?? 8),
            at: ctx.now() - 60000,
          },
        };
        failedClips++;
      } else s.audio = seedClip(ctx.world, bookId, s, ep, i);
    });
    partial.narration = "failed";
    partial.narrationProgress = 100;
    ctx.retime(bookId, partial.id);
    ctx.addHistory({
      kind: "narration",
      bookId,
      chapterId: partial.id,
      label: `Narrate · ch ${partial.id}`,
      status: "failed",
      minutesAgo: 7,
      seconds: 64,
      activity: [
        {
          message: "Narration plan prepared",
          detail: { clips: segs.length, segments: segs.length },
        },
        {
          level: "warning",
          message: `${plural(failedClips, "clip")} rate limited; the endpoint backed off`,
          detail: { code: 429, endpoint: endpointId },
        },
        {
          level: "error",
          message: `${plural(failedClips, "segment")} failed; the rest of the chapter rendered`,
          detail: {
            failed: failedClips,
            rendered: segs.length - failedClips,
            retry: "Retry failed clips renders only those lines",
          },
        },
      ],
    });
  }
  const ep =
    ctx.world.endpoints.find((e) => e.id === endpointId) ??
    ctx.world.endpoints.find((e) => e.enabled)!;
  const cooldown = ep.cooldownSec ?? 8;
  ep.backoffUntil = ctx.now() + cooldown * 1000;
  ep.rateLimits = (ep.rateLimits ?? 0) + 1;
  ep.failures = (ep.failures ?? 0) + failedClips;
  ep.lastError = {
    code: 429,
    message: "rate limited",
    body: rateLimitBody(cooldown),
    retryAfter: cooldown,
    at: ctx.now(),
  };
  ep.history = [...(ep.history ?? []).slice(-38), { t: ctx.now(), ms: 0, ok: false }];
  return {
    note:
      (already.length
        ? `Ch ${already.map((c) => c.id).join(", ")} failed outright`
        : "A chapter failed") +
      (partial
        ? `, ch ${partial.id} has ${plural(failedClips, "failed clip")} among finished ones`
        : "") +
      `, and ${ep.name} is backing off for ${cooldown}s.`,
  };
}

// ---------- blocked before a run ----------

/** Every way a line can fail to reach an endpoint: unassigned, removed, and paused. */
function missingVoices(ctx: ScenarioContext, bookId: string): DemoResult {
  const cast = ctx.cast(bookId);
  const narrator = cast.find((c) => c.name === "Narrator");
  // with no Narrator voice there is nothing to fall back to, so an unvoiced speaker is unrouted
  if (narrator) narrator.voice = null;
  const majors = cast.filter((c) => c.major && c.name !== "Narrator");
  const unset: string[] = narrator ? ["the Narrator"] : [];
  if (majors[0]) {
    majors[0].voice = null;
    unset.push(majors[0].name);
  }
  const removed = majors[1];
  if (removed) removed.voice = voiceRef("openai", "retired-voice");
  const paused = ctx.world.endpoints.find((e) => !e.enabled);
  const held = majors[2];
  if (held && paused?.voices[0]) held.voice = voiceRef(paused.id, paused.voices[0].id);
  return {
    note:
      `${unset.join(" and ")} have no voice` +
      (removed ? `, ${removed.name} points at a voice that no longer exists` : "") +
      (held && paused ? `, and ${held.name} at the paused ${paused.name}` : "") +
      ".",
  };
}

/** A book that has spent what it was allowed to spend. */
function budgetSpent(ctx: ScenarioContext, bookId: string): DemoResult {
  const book = ctx.book(bookId);
  if (!book) return { note: "" };
  const profile = ctx.profiles().find((p) => p.enabled) ?? ctx.profiles()[0];
  const scripting = 0.42;
  ctx.addScriptUsage(bookId, profile.id, scripting);
  book.scriptBudget = scripting;
  // a cap the last run went slightly past, which is how a cap is usually discovered
  const spent = ctx.spent(bookId);
  const cap = Math.floor(spent * 100) / 100;
  book.budget = { cap, paused: false };
  return {
    note: `${money(spent)} of a ${money(cap)} cap is spent and the ${money(scripting)} scripting budget is used up — every estimate now reports a blocker.`,
  };
}

// ---------- rates, cache and promotions ----------
//
// These rows change one endpoint's rate card and nothing else. They are cheap on purpose: the point
// is what the pricing panel and the receipts *say* about a card, so the situation is the card.

/** The endpoint the pricing rows work on: the one with cached pricing and a schedule. */
const pricingEndpoint = (ctx: ScenarioContext): Profile | undefined =>
  ctx.profiles().find((p) => p.id === "openai") ?? ctx.profiles()[0];

/** A window covering right now, in the browser's own zone so "it is off-peak" is visibly true. */
function windowAroundNow(ctx: ScenarioContext, label: string, percent: number): RateWindow {
  const d = new Date(ctx.now());
  const from = (d.getHours() * 60 + d.getMinutes() - 90 + 1440) % 1440;
  const to = (from + 240) % 1440;
  return { id: "demo-window", label, days: [], from, to, percent };
}

function offPeakNow(ctx: ScenarioContext): DemoResult {
  const p = pricingEndpoint(ctx);
  if (!p?.pricing) return { note: "" };
  // the browser's own zone, so the window on screen really is the one covering this minute
  p.pricing.timezone = localTimezone();
  p.pricing.windows = [windowAroundNow(ctx, "Off-peak", 40)];
  // nothing else may be moving the price, or the window is not what the page is demonstrating
  p.pricing.promotions = p.pricing.promotions.filter((x) => !promotionRunning(x, ctx.now()));
  const w = p.pricing.windows[0];
  return {
    note: `${p.name} is inside a 40% off-peak window (${clockLabel(w.from)}–${clockLabel(w.to)}, ${p.pricing.timezone}) that runs past midnight. Every rate is discounted and the page says when it ends.`,
  };
}

function promotionsLive(ctx: ScenarioContext): DemoResult {
  const p = pricingEndpoint(ctx);
  if (!p?.pricing) return { note: "" };
  const now = ctx.now();
  // no schedule, so the promotion is unambiguously what moved the price
  p.pricing.windows = [];
  p.pricing.promotions = [
    {
      id: "half-model",
      label: "50% off gpt-4o-mini",
      from: now - 2 * 86400e3,
      until: now + 2 * 86400e3,
      scope: ["model"],
      percent: 50,
      note: "Covers every component this model prices.",
    },
    {
      id: "input-third",
      label: "Input −30%",
      from: now - 86400e3,
      until: now + 6 * 86400e3,
      scope: ["input"],
      percent: 30,
      note: "Running, but outranked on input: 50% off the model is cheaper, and discounts do not stack.",
    },
    {
      id: "output-half-later",
      label: "Half-price output",
      from: now + 2 * 86400e3,
      until: now + 16 * 86400e3,
      scope: ["output"],
      percent: 50,
      note: "Starts in two days. Nothing is charged at this rate until then.",
    },
    {
      id: "cache-free-past",
      label: "Free cache reads",
      from: now - 21 * 86400e3,
      until: now - 7 * 86400e3,
      scope: ["cachedInput"],
      rates: { cachedInput: 0 },
      note: "Ended a week ago. Kept so the history is readable; it prices nothing now.",
    },
  ];
  return {
    note: `${p.name} has one promotion applying, one running but outranked, one starting in two days and one that ended a week ago and is kept as history.`,
  };
}

function promotionsExpired(ctx: ScenarioContext): DemoResult {
  const p = pricingEndpoint(ctx);
  if (!p?.pricing) return { note: "" };
  const now = ctx.now();
  p.pricing.windows = [];
  p.pricing.promotions = p.pricing.promotions.map((x) => ({
    ...x,
    from: now - 30 * 86400e3,
    until: now - 86400e3,
    note: "Ended yesterday. Requests charged while it ran keep the price they were charged at.",
  }));
  return {
    note: `Every promotion on ${p.name} ended yesterday, so the base rates are back — and the spend recorded while they ran is unchanged.`,
  };
}

/** Cache reported, partly reported, not reported and contradictory, all on one endpoint. */
function cacheMix(ctx: ScenarioContext): DemoResult {
  const p = pricingEndpoint(ctx);
  if (!p?.pricing) return { note: "" };
  p.pricing.cachedInput = Number((p.inPrice * 0.25).toFixed(4));
  p.pricing.cacheWrite = null;
  return {
    note: `${p.name} charges ${rateMoney(p.pricing.cachedInput)} per 1M cached input tokens against ${rateMoney(p.inPrice)} ordinary. Its history has requests with no cache use, requests part cached, requests whose provider reported nothing, and a few whose counts contradict each other.`,
  };
}

/**
 * A run that will still be going when the rates change under it.
 *
 * The run has to outlast the boundary for the row to demonstrate anything, so the endpoint is
 * re-tuned to make one: smaller chunks, so each chapter is several requests, and a slower request,
 * so four chapters take minutes rather than seconds. The window then closes a minute in.
 */
function rateBoundary(ctx: ScenarioContext): DemoResult {
  const p = pricingEndpoint(ctx);
  if (!p?.pricing) return { note: "" };
  p.maxChars = 800;
  p.secPerChunk = 20;
  p.concurrency = 2;
  const d = new Date(ctx.now());
  const to = (d.getHours() * 60 + d.getMinutes() + 1) % 1440;
  p.pricing.timezone = localTimezone();
  p.pricing.windows = [
    { id: "closing", label: "Off-peak", days: [], from: (to - 300 + 1440) % 1440, to, percent: 40 },
  ];
  p.pricing.promotions = [];
  return {
    note: `${p.name} leaves its 40% off-peak window at ${clockLabel(to)}, about a minute from now. The four chapters queued behind it are priced request by request, so the ones that land after it are charged at the full rate.`,
  };
}

/**
 * A speech endpoint inside an off-peak window with a promotion on top, and one whose rate is
 * unknown so neither does anything. The same engine as the LLM rows: what differs is that the rate
 * is written in the endpoint's own billing unit, and there is one of it rather than four.
 */
function speechDiscount(ctx: ScenarioContext): DemoResult {
  const zone = localTimezone();
  const now = ctx.now();
  const d = new Date(now);
  const from = (d.getHours() * 60 + d.getMinutes() - 60 + 1440) % 1440;
  const to = (from + 300) % 1440;

  const main = ctx.world.endpoints.find((e) => e.id === "openai");
  if (main?.pricing) {
    main.pricing.timezone = zone;
    main.pricing.windows = [
      { id: "tts-off-peak", label: "Off-peak", days: [], from, to, percent: 40 },
    ];
    main.pricing.promotions = [
      {
        id: "tts-launch",
        label: "20% off speech",
        from: now - 2 * 86400e3,
        until: now + 3 * 86400e3,
        scope: ["model"],
        percent: 20,
        note: "Applies on top of the off-peak window rather than compounding with it.",
      },
    ];
  }
  const proxy = ctx.world.endpoints.find((e) => e.id === "proxy");
  if (proxy?.pricing) {
    proxy.pricing.timezone = zone;
    proxy.pricing.windows = [
      { id: "proxy-night", label: "Night rate", days: [], from, to, percent: 30 },
    ];
  }
  return {
    note: `${main?.name ?? "The speech endpoint"} is inside a 40% off-peak window (${clockLabel(from)}–${clockLabel(to)}, ${zone}) with a 20% promotion on top — and they do not stack. ${proxy?.name ?? "The proxy"} has the same window over a rate nobody knows, so its price stays unknown.`,
  };
}

/** The chapter this scenario uses: the one where all five seeded speakers have lines. */
export const BILLING_CHAPTER = 2;

/**
 * One chapter spread across every billing model at once.
 *
 * The point is the *comparison*: the same run produces requests billed on characters, on UTF-8
 * bytes, on two kinds of token and on nothing at all, and the estimate has to add four different
 * kinds of arithmetic into one figure without ever charging the same usage twice. The Narrator is
 * left on the free local model so "free" and "unknown" are both visible beside real prices.
 *
 * The Mandarin is not decoration: the pronunciation dictionary rewrites "outer sect" into Hanzi on
 * the way out, so the byte-billed speaker's bill is about three times what its character count
 * suggests — which is the whole reason byte billing is a model of its own.
 */
function billingModels(ctx: ScenarioContext, bookId: string): DemoResult {
  const by = (id: string) => ctx.world.endpoints.find((e) => e.id === id);
  const cast = ctx.cast(bookId);
  const route = (name: string, endpointId: string, voiceIndex = 0) => {
    const who = cast.find((c) => c.name === name);
    const ep = by(endpointId);
    if (!who || !ep?.voices.length) return "";
    who.voice = voiceRef(ep.id, ep.voices[Math.min(voiceIndex, ep.voices.length - 1)].id);
    return ep.name;
  };

  for (const ep of ctx.world.endpoints) {
    ep.enabled = true;
    ep.backoffUntil = 0;
  }
  // One speaker per model, so a single chapter exercises all of them. The Narrator goes to the
  // byte-billed endpoint on purpose: the narration is where "outer sect" appears, and that is the
  // phrase the dictionary rewrites into Hanzi, so the divergence between characters and bytes
  // lands on the endpoint that actually bills on bytes.
  route("Narrator", "fish");
  route("Ji Ning", "openai");
  route("Xiao Lan", "gemini");
  route("Bai Feng", "local");
  route("Elder Mo", "proxy");

  // the chapter is put back to unnarrated so the estimate is about work that has not happened
  const chapter = ctx.chapters(bookId).find((c) => c.id === BILLING_CHAPTER);
  if (chapter) {
    chapter.narration = "none";
    chapter.narrationProgress = 0;
    for (const seg of ctx.segmentsOf(bookId, BILLING_CHAPTER)) {
      seg.audio = { status: "none", endpoint: null, ms: 0, duration: 0 };
      delete seg.candidate;
    }
  }
  const fish = by("fish");
  const gemini = by("gemini");
  return {
    note:
      `Chapter ${BILLING_CHAPTER} now routes five speakers at five billing models: ${by("openai")?.name} per 1M characters, ` +
      `${fish?.name} per 1M UTF-8 bytes (${rateMoney(fish?.billing?.rate ?? 0)}), ` +
      `${gemini?.name} at ${rateMoney(gemini?.billing?.rate ?? 0)} per 1M input text tokens plus ` +
      `${rateMoney(gemini?.billing?.audioRate ?? 0)} per 1M output audio tokens, the local model free, ` +
      `and the paused proxy at a rate nobody typed in. Narrate it and compare the estimate with the receipts.`,
  };
}

// ---------- review and retakes ----------

/** The state a book gets into while it is being listened to: edits, drift, flags, second takes. */
function staleAndRetakes(ctx: ScenarioContext, bookId: string): DemoResult {
  const chapters = ctx.chapters(bookId);
  const narrated = chapters.filter(isNarrated);
  let edited = 0;
  let retakes = 0;
  let flagged = 0;
  // a chapter edited after it was narrated: the clips no longer say what the script says
  const second = narrated[1];
  if (second) {
    const segs = ctx.segmentsOf(bookId, second.id);
    const done = segs.filter((s) => s.audio.status === "done");
    const [a, b, c] = done;
    if (a) {
      a.direction = "quieter, almost to herself";
      a.edited = true;
      a.audio.status = "stale";
      edited++;
    }
    if (b) {
      b.text = b.text.replace(/[.!?]?$/, "") + " — and then said nothing at all.";
      b.edited = true;
      b.audio.status = "stale";
      edited++;
    }
    if (c && c.type === "dialogue") {
      const other = ctx.cast(bookId).find((x) => x.name !== c.speaker && x.name !== "Narrator");
      if (other) {
        c.speaker = other.name;
        c.edited = true;
        c.audio.status = "stale";
        edited++;
      }
    }
    if (edited) second.narration = "stale";
    ctx.retime(bookId, second.id);
  }
  // and one being listened to: a take waiting to be compared, and one already rejected
  const third = narrated[2] ?? narrated[0];
  if (third) {
    const segs = ctx.segmentsOf(bookId, third.id);
    const spoken = segs.filter((s) => s.type !== "narration" && s.audio.duration > 0);
    const waiting = spoken[0];
    if (waiting) {
      waiting.flag = {
        kind: "delivery",
        note: "rushed — the beat before it should land",
        at: ctx.now() - 24 * 60000,
      };
      const first = { ...waiting.audio };
      waiting.audio = { ...first, n: 1 };
      waiting.candidate = {
        ...first,
        n: 2,
        ms: Math.round(first.ms * 1.08),
        duration: first.duration * 1.12,
        at: ctx.now() - 12 * 60000,
      };
      retakes++;
      flagged++;
    }
    const settled = spoken[1];
    if (settled) {
      const kept = { ...settled.audio, n: 3 };
      settled.audio = {
        ...kept,
        takes: [
          snapshotTake({ ...kept, n: 1 }),
          { ...snapshotTake({ ...kept, n: 2 }), rejected: true },
        ],
      };
      retakes++;
    }
    const complained = spoken[2];
    if (complained) {
      complained.flag = {
        kind: "pronunciation",
        note: "the name is read as two words",
        at: ctx.now() - 18 * 60000,
      };
      flagged++;
    }
    ctx.retime(bookId, third.id);
  }
  return {
    note: `${plural(edited, "line")} edited after narration and marked stale, ${plural(flagged, "flagged clip")}, and ${plural(retakes, "second take")} to compare against the clip in the book.`,
  };
}

/** One character's alias scattered through the book, as a re-script would leave it. */
function misAttributed(ctx: ScenarioContext, bookId: string): DemoResult {
  const cast = ctx.cast(bookId);
  const target = searchDemoTarget(cast);
  if (!target) return { note: "This book has nothing scripted to scatter an alias through." };
  const { moved, flagged, staled } = applySearchDemo(
    target,
    cast,
    ctx.chapters(bookId).filter(isScripted),
    (chId) => ctx.segmentsOf(bookId, chId),
  );
  return {
    note: `${plural(moved, "line")} re-attributed to “${target.alias}”, ${flagged} flagged and ${staled} clips made stale.`,
    open: `/book/${bookId}/search?q=${encodeURIComponent(target.alias)}&speaker=${encodeURIComponent(target.alias)}`,
  };
}

// ---------- re-doing chapters that are already finished ----------

/**
 * One book holding every state a bulk run has to tell apart: chapters nothing has been run on,
 * chapters finished at both stages, a chapter somebody corrected by hand, one whose script moved
 * after it was narrated, one whose clips failed, and one line with a retake still waiting for a
 * verdict. The point of the row is the *selection*: what the shortcuts pick, what the summary says
 * the selection contains, and what the two run panels say pressing the button would do.
 */
function bulkRework(ctx: ScenarioContext, bookId: string): DemoResult {
  const chapters = ctx.chapters(bookId);
  ctx.clearJobs(bookId);
  const scripted = chapters.filter(isScripted);
  const narrated = chapters.filter(isNarrated);

  // ---- a chapter corrected by hand after the model wrote it
  let corrections = 0;
  const corrected = scripted[0];
  if (corrected) {
    const segs = ctx.segmentsOf(bookId, corrected.id);
    const others = ctx.cast(bookId).filter((c) => c.name !== "Narrator" && c.major);
    for (const line of segs.filter((x) => x.type === "dialogue").slice(0, 3)) {
      line.direction = "flatter — she is holding something back";
      line.edited = true;
      corrections++;
    }
    // corrections on narration lines, which a second pass is likely to lay out differently: these
    // are what "could not be re-applied" is meant to show
    for (const line of segs.filter((x) => x.type === "narration").slice(0, 2)) {
      line.direction = "unhurried";
      line.edited = true;
      corrections++;
    }
    const mis = segs.find((x) => x.type === "dialogue" && x.speaker === "Narrator");
    if (mis && others[0]) {
      mis.speaker = others[0].name;
      mis.edited = true;
      corrections++;
    }
  }

  // ---- a narrated chapter whose script moved under its audio
  let stale = 0;
  const drifted = narrated.find((c) => c.id !== corrected?.id) ?? narrated[0];
  if (drifted) {
    for (const line of ctx
      .segmentsOf(bookId, drifted.id)
      .filter((x) => x.audio.status === "done")
      .slice(0, 4)) {
      line.direction = "half a step slower";
      line.edited = true;
      line.audio.status = "stale";
      stale++;
    }
    if (stale) drifted.narration = "stale";
    ctx.retime(bookId, drifted.id);
  }

  // ---- a narrated chapter with failed clips among finished ones, and a retake to judge
  let failedClips = 0;
  let waiting = 0;
  const partly = narrated.find((c) => c.id !== drifted?.id) ?? narrated.at(-1);
  if (partly) {
    const segs = ctx.segmentsOf(bookId, partly.id);
    segs.forEach((line, i) => {
      if (i % 7 !== 3 || line.audio.status !== "done") return;
      line.audio = {
        ...line.audio,
        status: "failed",
        duration: 0,
        error: {
          code: 500,
          message: "the provider had an error while processing the request",
          body: "",
          at: ctx.now() - 9 * 60000,
        },
      };
      failedClips++;
    });
    if (failedClips) partly.narration = "failed";
    // and one line being listened to: a second take beside the clip in the book
    const judge = segs.find((x) => x.audio.status === "done" && x.audio.duration > 0);
    if (judge) {
      const first = { ...judge.audio };
      judge.audio = { ...first, n: 1 };
      judge.candidate = {
        ...first,
        n: 2,
        ms: Math.round(first.ms * 1.06),
        duration: first.duration * 1.09,
        at: ctx.now() - 6 * 60000,
      };
      waiting++;
    }
    ctx.retime(bookId, partly.id);
  }

  // ---- and one chapter whose scripting kept nothing at all
  const blank = chapters.find(
    (c) =>
      isScripted(c) &&
      !c.excluded &&
      !c.duration &&
      ![corrected?.id, drifted?.id, partly?.id].includes(c.id),
  );
  if (blank) {
    blank.scripting = "failed";
    blank.scriptingProgress = 0;
    delete blank.rescript;
    ctx.clearScript(bookId, blank.id);
  }

  const fresh = chapters.filter((c) => !c.excluded && c.scripting === "none").length;
  return {
    note:
      `${plural(fresh, "chapter")} never scripted, ${scripted.length - (blank ? 1 : 0)} scripted, ` +
      `${plural(corrections, "hand correction")} in ch ${corrected?.id ?? "?"}, ${plural(stale, "stale clip")} in ch ${drifted?.id ?? "?"}, ` +
      `${plural(failedClips, "failed clip")} in ch ${partly?.id ?? "?"}` +
      (waiting ? ", and one retake waiting for a verdict" : "") +
      (blank ? `. Ch ${blank.id} kept no script at all.` : "."),
  };
}

/**
 * A bulk re-script that went wrong in both of the ways worth watching, and a bulk re-narration
 * whose replacements failed. The whole row exists to show what *survived*: two chapters kept
 * nothing and still read as scripted, because the script each run was replacing is still the
 * chapter's script; a cancelled chapter stopped the ones behind it without touching the ones in
 * front; and every clip whose replacement failed is still the clip in the book.
 */
function bulkRecovery(ctx: ScenarioContext, bookId: string): DemoResult {
  const chapters = ctx.chapters(bookId);
  ctx.clearJobs(bookId);
  const profiles = ctx.profiles();
  const profile =
    profiles.find((p) => p.id === "deepseek") ?? profiles.find((p) => p.enabled) ?? profiles[0];
  const scripted = chapters.filter(isScripted).slice(0, 4);
  const op = "Re-script 4 chapters";
  const bulk = (index: number) => ({
    id: 1,
    op,
    index,
    total: scripted.length,
    scope: "preserving manual corrections",
  });
  const plan = {
    message: "Scripting plan prepared",
    detail: {
      endpoint: profile.name,
      model: profile.model,
      requests: 3,
      operation: "replace the existing script",
      manualCorrections: "re-applied where the line still matches",
    },
  };
  scripted.forEach((c, i) => {
    const replaced = i < 2;
    const cancelled = i === 3;
    ctx.addHistory({
      kind: "scripting",
      bookId,
      chapterId: c.id,
      label: `Re-script · ch ${c.id} · ${profile.name}`,
      status: replaced ? "done" : cancelled ? "cancelled" : "failed",
      minutesAgo: 22 - i * 4,
      seconds: replaced ? 38 : cancelled ? 9 : 26,
      bulk: bulk(i + 1),
      activity: replaced
        ? [
            plan,
            { message: "3 of 3 requests completed", detail: { costUSD: 0.01 } },
            {
              message: "Manual corrections: 4 re-applied, 1 could not be",
              level: "warning" as const,
              detail: {
                reApplied: 4,
                unmatched: 1,
                why: "the new script does not have the line the correction was made on",
              },
            },
          ]
        : cancelled
          ? [
              plan,
              {
                level: "warning" as const,
                message: "Cancellation requested",
                detail: { behavior: "Stops on the next scheduler tick" },
              },
              {
                level: "warning" as const,
                message: "Cancelled before a script was written; the previous script is unchanged",
                detail: { lines: ctx.segmentsOf(bookId, c.id).length, chapterStatus: "done" },
              },
            ]
          : [
              plan,
              {
                level: "error" as const,
                message: "Script verification failed",
                detail: {
                  reason: "the model's segments could not be matched back to the chapter text",
                },
              },
              {
                level: "warning" as const,
                message: "Nothing was written; the previous script is unchanged",
                detail: { lines: ctx.segmentsOf(bookId, c.id).length, chapterStatus: "done" },
              },
            ],
    });
  });

  // ---- narration replacements that failed beside clips that are still playable
  let kept = 0;
  const narrated = chapters.find(isNarrated);
  if (narrated) {
    const segs = ctx.segmentsOf(bookId, narrated.id);
    segs.forEach((line, i) => {
      if (i % 5 !== 1 || line.audio.status !== "done" || line.audio.duration <= 0) return;
      line.audio = { ...line.audio, n: line.audio.n ?? 1 };
      line.candidate = {
        status: "failed",
        endpoint: line.audio.endpoint,
        ms: 0,
        duration: 0,
        n: (line.audio.n ?? 1) + 1,
        auto: true,
        error: {
          code: 500,
          message: "the provider had an error while processing the request",
          body: "",
          at: ctx.now() - 3 * 60000,
        },
      };
      kept++;
    });
    ctx.addHistory({
      kind: "narration",
      bookId,
      chapterId: narrated.id,
      label: `Re-narrate · ch ${narrated.id}`,
      status: "failed",
      minutesAgo: 6,
      seconds: 54,
      bulk: { id: 2, op: "Re-narrate 1 chapter", index: 1, total: 1, scope: "Everything" },
      activity: [
        {
          message: "Narration plan prepared",
          detail: { scope: "Everything", clips: segs.length, replacing: segs.length },
        },
        {
          level: "warning" as const,
          message: `${plural(kept, "replacement")} failed; the clips already in the book are unchanged`,
          detail: { failed: kept, keptClips: kept },
        },
      ],
    });
  }
  return {
    note:
      `A four-chapter re-script: 2 replaced, 1 kept nothing and 1 was cancelled — all four still read as scripted ` +
      `because each run's own result is the only thing that was ever going to change. ` +
      `${plural(kept, "narration replacement")} failed in ch ${narrated?.id ?? "?"}, and every one of those clips still plays.`,
  };
}

// ---------- a chapter's script history ----------

/**
 * One chapter with a past worth looking at: the model's first pass, the corrections a person made
 * to it, the checkpoint they saved before trying another model, and the re-script that followed.
 *
 * The clips were rendered from the corrected script, so the re-script leaves audio that no longer
 * matches it — which is what makes restoring the checkpoint worth watching: the clips come back to
 * the lines they belong to, including the one whose paragraph the new model cut in two.
 */
function chapterHistory(ctx: ScenarioContext, bookId: string): DemoResult {
  const chapters = ctx.chapters(bookId);
  const chapter = chapters.find(isNarrated) ?? chapters.find(isScripted);
  if (!chapter) return { note: "This book has no scripted chapter to keep a history for." };
  const live = ctx.segmentsOf(bookId, chapter.id);
  const cast = ctx.cast(bookId);
  const majors = cast.filter((c) => c.major && c.name !== "Narrator").map((c) => c.name);
  const main = cast.find((c) => c.major && c.name !== "Narrator");
  const rotate = (name: string): string =>
    majors.length > 1 ? majors[(majors.indexOf(name) + 1) % majors.length] : name;
  const profiles = ctx.profiles();
  const firstPass = profiles.find((p) => p.id === "openai") ?? profiles[0];
  const secondPass = profiles.find((p) => p.id === "deepseek") ?? profiles[1] ?? firstPass;
  const minutes = (n: number): number => ctx.now() - n * 60000;

  // the script the clips were rendered from — every version below is a variation on this one
  const corrected = snapshotScript(live);

  // ---- the model's first pass, before anybody corrected it
  const initial = snapshotScript(live);
  let corrections = 0;
  // An alias the first pass invented for the main character and the person renamed away, so the
  // book's cast no longer has it: what previewing an old version has to be able to say, and what
  // restoring one has to be able to put right.
  const alias = main?.aliases.find((a) => !cast.some((c) => c.name === a));
  const own = initial.find((s) => s.type === "dialogue" && s.speaker === main?.name);
  if (own && alias) {
    own.speaker = alias;
    corrections++;
  }
  for (const s of initial
    .filter((s) => s.type === "dialogue" && s.speaker !== main?.name && s !== own)
    .slice(0, 2)) {
    s.speaker = rotate(s.speaker);
    corrections++;
  }
  const directed = initial.find((s) => s.direction && s.type !== "narration");
  if (directed) {
    directed.direction = "";
    corrections++;
  }
  const named = initial.find((s) => !!main && s.text.includes(main.name));
  if (named && main) {
    named.text = named.text.replace(main.name, main.name.replace(/[\s’']/g, ""));
    corrections++;
  }
  // a quote the first pass kept in the same chunk as the line that introduces it
  const merged = initial.findIndex(
    (s, i) => s.type === "dialogue" && initial[i + 1]?.type === "narration",
  );
  if (merged >= 0) {
    const [after] = initial.splice(merged + 1, 1);
    initial[merged] = {
      ...initial[merged],
      type: "narration",
      speaker: "Narrator",
      direction: "",
      text: `${initial[merged].text} ${after.text}`,
    };
    corrections++;
  }
  initial.forEach((s, i) => (s.id = i + 1));

  // ---- and two pauses nudged after the checkpoint was saved: script, but no clip goes stale
  const settled = snapshotScript(live);
  const held = settled.filter((s) => s.type === "dialogue").slice(0, 2);
  for (const s of held) s.pause = 1.5;

  // ---- the re-script that is now the current script
  let moved = 0;
  let dropped = 0;
  const reattributed = live
    .filter((s) => s.type === "dialogue" && s.speaker !== "Narrator")
    .slice(0, 3);
  for (const s of reattributed) {
    s.speaker = rotate(s.speaker);
    if (s.audio.status === "done") s.audio.status = "stale";
    moved++;
  }
  for (const s of live.filter((s) => s.direction && !reattributed.includes(s)).slice(0, 2)) {
    s.direction = "";
    if (s.audio.status === "done") s.audio.status = "stale";
    dropped++;
  }
  // one paragraph the new model cut in two: the first half keeps the clip, the second has none
  const long = live.find(
    (s) => s.type === "narration" && s.audio.duration > 0 && s.text.length > 80,
  );
  const gaps = long ? gapsOf(long.text, "split") : [];
  const strong = gaps.filter((g) => g.strong);
  const cut = (strong[Math.floor(strong.length / 2)] ?? gaps[Math.floor(gaps.length / 2)])?.at ?? 0;
  if (long && cut) {
    const head = long.text.slice(0, cut).trimEnd();
    const tail = long.text.slice(cut).trimStart();
    const sep = long.text.slice(head.length, long.text.length - tail.length);
    const id = Math.max(0, ...live.map((s) => s.id)) + 1;
    const index = live.indexOf(long);
    long.text = head;
    if (sep === " ") delete long.sep;
    else long.sep = sep;
    if (long.audio.status === "done") long.audio.status = "stale";
    live.splice(index + 1, 0, {
      id,
      type: "narration",
      speaker: long.speaker,
      text: tail,
      direction: long.direction,
      audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
    });
  }
  chapter.narration = "stale";
  ctx.retime(bookId, chapter.id);

  ctx.seedHistory(bookId, chapter.id, {
    versions: [
      {
        at: minutes(190),
        origin: { kind: "scripted", profile: firstPass.name, model: firstPass.model },
        segments: initial,
      },
      {
        at: minutes(42),
        origin: {
          kind: "checkpoint",
          name: "Before trying DeepSeek",
          was: { kind: "edited", edits: corrections },
        },
        segments: corrected,
      },
      { at: minutes(12), origin: { kind: "edited", edits: held.length }, segments: settled },
    ],
    head: {
      at: minutes(4),
      origin: {
        kind: "scripted",
        profile: secondPass.name,
        model: secondPass.model,
        again: true,
      },
    },
  });
  ctx.addHistory({
    kind: "scripting",
    bookId,
    chapterId: chapter.id,
    label: `Script · ch ${chapter.id} · ${secondPass.name}`,
    status: "done",
    minutesAgo: 5,
    seconds: 41,
    activity: [
      {
        message: "Scripting plan prepared",
        detail: { endpoint: secondPass.name, model: secondPass.model, requests: 3 },
      },
      { message: "3 of 3 requests completed", detail: { costUSD: 0.01 } },
    ],
  });

  const stale = moved + dropped + (long && cut ? 1 : 0);
  return {
    note:
      `Chapter ${chapter.id} has three saved versions: ${firstPass.name}’s first pass, ` +
      `${plural(corrections, "correction")} kept as “Before trying DeepSeek”, and two pause edits. ` +
      `The ${secondPass.name} re-script that replaced them moved ${plural(moved, "speaker")}, dropped ${plural(dropped, "direction")} ` +
      `and cut one paragraph in two, so ${plural(stale, "clip")} are stale and one line has no audio at all.`,
    open: `/book/${bookId}/scripting?ch=${chapter.id}&history=1`,
  };
}

// ---------- export ----------

/** The Export rows, which are the same preparations the Export page's own chip has always used. */
function exportSituation(ctx: ScenarioContext, id: string, bookId: string): DemoResult {
  const prep = exportDemoPrep(id);
  if (prep.freshen) freshenChapters(ctx.chapters(bookId), (chId) => ctx.segmentsOf(bookId, chId));
  if (prep.clearExports) ctx.clearExports(bookId);
  if (prep.buildHistory) ctx.seedBuilds(bookId);
  return { note: prep.note };
}
