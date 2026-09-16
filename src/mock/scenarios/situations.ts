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
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { snapshotTake } from "@/lib/takes";
import { voiceRef } from "../fixtures/voices";
import { routeOf, seedClip, type ClipWorld } from "../world/audio";
import { exportDemoPrep, freshenChapters } from "./export";
import { applySearchDemo, searchDemoTarget } from "./search";
import type {
  Book,
  Chapter,
  Character,
  DemoResult,
  JobKind,
  JobStatus,
  Profile,
  ScriptEndpointTelemetry,
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
  /** back to a chapter nothing has been run on: no script, and no saved revision of one */
  clearScript(bookId: string, chId: number): void;
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
}

const rateLimitBody = (cooldown: number): string =>
  `{"error":{"message":"Rate limit reached. Please retry after ${cooldown} seconds.","type":"rate_limit_error"}}`;

const money = (n: number): string => "$" + n.toFixed(2);

const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

/** Apply one situation to the seeded world and say what it did. Unknown ids do nothing. */
export function applySituation(ctx: ScenarioContext, id: string, bookId: string): DemoResult {
  switch (id) {
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
    default:
      return exportSituation(ctx, id, bookId);
  }
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

// ---------- export ----------

/** The Export rows, which are the same preparations the Export page's own chip has always used. */
function exportSituation(ctx: ScenarioContext, id: string, bookId: string): DemoResult {
  const prep = exportDemoPrep(id);
  if (prep.freshen) freshenChapters(ctx.chapters(bookId), (chId) => ctx.segmentsOf(bookId, chId));
  if (prep.clearExports) ctx.clearExports(bookId);
  if (prep.buildHistory) ctx.seedBuilds(bookId);
  return { note: prep.note };
}
