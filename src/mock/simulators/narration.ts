// The simulated TTS transport. One run renders two kinds of clip: a segment's own audio, and the
// retake standing beside it — `slot` says which one a target writes to, so a retake never lands on
// the book's clip.
//
// Latency, rate limits and failures are drawn from each endpoint's own configured numbers, so
// pausing an endpoint, tightening its concurrency or raising its failure rate all show up here.
import { keyring } from "@/lib/keyring";
import { logJob, jobWaiting, startJob } from "@/lib/jobActivity";
import { expressionParts } from "@/lib/expressions";
import { requeue } from "@/lib/takes";
import { rnd } from "../random";
import { REQUEST_ERRORS } from "../fixtures/errors";
import type { SimulatorContext } from "./context";
import type { ExpressionPlan } from "@/lib/expressions";
import type {
  AudioStatus,
  Chapter,
  Character,
  EffectiveVoice,
  Job,
  Segment,
  SegmentAudio,
} from "@/types";

export interface NarrationSimContext extends SimulatorContext {
  segmentsOf(bookId: string, chId: number): Segment[];
  charactersOf(bookId: string): Character[];
  effectiveVoice(bookId: string, speaker: string): EffectiveVoice;
  expressionRender(bookId: string, segment: Segment): ExpressionPlan;
  clipDrift(bookId: string, segment: Segment, audio?: SegmentAudio): string[];
  markStale(bookId: string, chId: number, segment: Segment): void;
  retime(bookId: string, chId: number): void;
}

/** Render every queued clip of one chapter, then settle the job. */
export function dispatchNarration(
  ctx: NarrationSimContext,
  bookId: string,
  c: Chapter,
  job: Job,
  done: () => void,
): void {
  c.narration = "running";
  jobWaiting(job, "");
  startJob(job);
  const segs = ctx.segmentsOf(bookId, c.id);
  const attempts = new Map<string, number>();
  // A run renders two kinds of clip: a segment's own audio, and the retake standing beside it.
  // `slot` says which one a target writes to, so a retake never lands on the book's clip.
  type Slot = "audio" | "candidate";
  interface Target {
    s: Segment;
    slot: Slot;
  }
  const clipOf = (t: Target): SegmentAudio => (t.slot === "audio" ? t.s.audio : t.s.candidate!);
  const targets = (...status: AudioStatus[]): Target[] =>
    segs.flatMap((s) => [
      ...(status.includes(s.audio.status) ? [{ s, slot: "audio" as Slot }] : []),
      ...(s.candidate && status.includes(s.candidate.status)
        ? [{ s, slot: "candidate" as Slot }]
        : []),
    ]);
  logJob(job, "Narration plan prepared", "info", {
    clips: targets("queued").length,
    segments: segs.length,
  });
  const tick = () => {
    // the world this run was dispatched against is gone: stop without writing to the new one
    if (ctx.stale()) return;
    if (job.cancelled) {
      for (const t of targets("queued"))
        if (t.slot === "candidate") delete t.s.candidate;
        else t.s.audio.status = "none";
      if (!targets("generating").length) {
        c.narration = segs.every((s) => s.audio.status === "done") ? "done" : "failed";
        ctx.finishJob(job, "cancelled");
        return done();
      }
      return setTimeout(tick, 200);
    }
    // A segment is rendered by the endpoint that owns its speaker's voice (falling back to the
    // Narrator's). Long text is split into `parts` requests against that endpoint's limit.
    const waiting = new Set<string>();
    for (const target of targets("queued")) {
      const next = target.s;
      const slot = target.slot;
      const queued = clipOf(target);
      const route = ctx.effectiveVoice(bookId, next.speaker);
      const ep = route.endpoint;
      // A paused endpoint *holds* its work — the clip stays queued until it is resumed or the
      // job is cancelled. That is what separates Pause from Cancel. Everything else below is a
      // configuration error the run should report rather than wait on.
      if (ep && !ep.enabled) {
        waiting.add(`${ep.name} is paused`);
        continue;
      }
      if (!ep || (ep.needsKey && !keyring.has(ep.id))) {
        next[slot] = {
          status: "failed",
          endpoint: ep?.id ?? null,
          ms: 0,
          duration: 0,
          ...(queued.n ? { n: queued.n } : {}),
          ...(queued.takes?.length ? { takes: queued.takes } : {}),
          error: {
            code: 0,
            message: !route.ref
              ? "no voice for speaker"
              : !ep
                ? `voice ${route.ref} no longer exists`
                : `${ep.name} has no API key`,
            body: "",
          },
        };
        logJob(job, `Segment ${next.id}: ${next[slot]!.error!.message}`, "error", {
          segment: next.id,
          target: slot,
        });
        continue;
      }
      if (ep.backoffUntil > Date.now()) {
        waiting.add(`${ep.name}: rate-limit cooldown`);
        continue;
      }
      const active = targets("generating").filter((t) => clipOf(t).endpoint === ep.id).length;
      if (active >= ep.concurrency) {
        waiting.add(`${ep.name}: concurrency full (${ep.concurrency})`);
        continue;
      }
      // the dictionary is applied here, on the way out: the script itself keeps the author's spelling
      const said = ctx.expressionRender(bookId, next);
      if (said.issues.length) {
        const message = `Expression needs attention: ${said.issues[0].reason}`;
        next[slot] = { ...queued, status: "failed", error: { code: 0, message, body: "" } };
        logJob(job, `Segment ${next.id} blocked before dispatch`, "error", {
          segment: next.id,
          error: message,
        });
        continue;
      }
      const sent = said.text;
      const cuts = expressionParts(said, ep);
      const parts = cuts.length;
      const attemptKey = `${next.id}:${slot}`;
      const attempt = (attempts.get(attemptKey) ?? 0) + 1;
      attempts.set(attemptKey, attempt);
      const diagnostic = {
        segment: next.id,
        target: slot,
        attempt,
        endpoint: ep.name,
        model: ep.model,
        parts,
        characters: sent.length,
        ...(said.tags.length ? { expressions: said.tags.join(" ") } : {}),
        ...(next.expressions?.some((a) => a.omitted)
          ? {
              omittedExpressions: next.expressions
                .filter((a) => a.omitted)
                .map((a) => a.label)
                .join(", "),
            }
          : {}),
      };
      logJob(
        job,
        `Segment ${next.id}${slot === "candidate" ? " retake" : ""} started`,
        "info",
        diagnostic,
      );
      const who = ctx.charactersOf(bookId).find((x) => x.name === next.speaker);
      next[slot] = {
        status: "generating",
        endpoint: ep.id,
        ms: 0,
        duration: 0,
        startedAt: Date.now(),
        // the take number and the history of this clip survive the render
        ...(queued.takes?.length ? { takes: queued.takes } : {}),
        ...(queued.n ? { n: queued.n } : {}),
        parts,
        cuts:
          parts > 1
            ? cuts.map((c) => ({ from: c.from, to: c.to, at: c.at, fallback: c.fallback }))
            : undefined,
        splitAt: ep.splitAt,
        // audit trail: exactly what this clip was rendered with, so later edits can be compared against it
        voiceRef: route.ref ?? undefined,
        voice: route.voice ?? undefined,
        model: ep.model,
        direction: next.direction,
        style: who?.style ?? "",
        type: next.type,
        text: next.text,
        pronounced: said.pronounced,
        expressionSignature: said.signature,
        expressions: said.tags,
        ...(sent !== next.text ? { said: sent, lex: said.hits.length } : {}),
        at: Date.now(),
        cost: (sent.length / 1e6) * ep.price,
      };
      const dur = ep.latency * rnd(0.5, 1.1) * parts + sent.length * 6;
      setTimeout(() => {
        // a request still in flight when the world was replaced: its result belongs to nothing
        if (ctx.stale()) return;
        const clip = next[slot];
        if (!clip) {
          logJob(
            job,
            `Segment ${next.id} result discarded; retake was removed`,
            "warning",
            diagnostic,
          );
          return;
        }
        if (Math.random() < 0.03) {
          // rate limited → back off, put the segment back
          const cooldown = ep.cooldownSec ?? 8;
          ep.backoffUntil = Date.now() + cooldown * 1000;
          ep.rateLimits = (ep.rateLimits ?? 0) + 1;
          ep.lastError = {
            code: 429,
            message: "rate limited",
            body: `{"error":{"message":"Rate limit reached. Please retry after ${cooldown} seconds.","type":"rate_limit_error"}}`,
            retryAfter: cooldown,
            at: Date.now(),
          };
          logJob(job, `Segment ${next.id} rate limited; retry after ${cooldown}s`, "warning", {
            ...diagnostic,
            code: 429,
          });
          next[slot] = requeue(clip);
          return;
        }
        const fail = Math.random() < ep.failRate;
        clip.ms = Math.round(dur);
        clip.duration = fail ? 0 : said.pronounced.split(" ").length / 2.6;
        // the script can move while a request is in flight — a clip that no longer matches what
        // the line says now arrives stale, not done
        clip.status = fail ? "failed" : ctx.clipDrift(bookId, next, clip).length ? "stale" : "done";
        if (!fail && clip.status === "stale" && slot === "audio") ctx.markStale(bookId, c.id, next);
        if (fail) {
          const e = REQUEST_ERRORS[Math.floor(Math.random() * REQUEST_ERRORS.length)];
          clip.error = {
            ...e,
            part: parts > 1 ? 1 + Math.floor(Math.random() * parts) : undefined,
            at: Date.now(),
          };
          ep.lastError = { ...clip.error };
        }
        ep.history = [
          ...(ep.history ?? []),
          { t: Date.now(), ms: Math.round(dur), ok: !fail },
        ].slice(-40);
        if (fail) ep.failures = (ep.failures ?? 0) + 1;
        logJob(
          job,
          `Segment ${next.id} ${fail ? "failed" : clip.status === "stale" ? "completed with outdated audio" : "completed"}`,
          fail ? "error" : clip.status === "stale" ? "warning" : "info",
          {
            ...diagnostic,
            responseMs: clip.ms,
            audioSeconds: clip.duration,
            ...(clip.error ? { code: clip.error.code, error: clip.error.message } : {}),
          },
        );
      }, dur);
    }
    jobWaiting(job, [...waiting].sort().join("; "));
    const pending = targets("queued", "generating");
    const finished = segs.length - pending.filter((t) => t.slot === "audio").length;
    c.narrationProgress = Math.round((finished / segs.length) * 100);
    job.progress = c.narrationProgress;
    // Pausing an endpoint holds its queued clips rather than failing them: that is the whole
    // difference between Pause and Cancel. The run stays open, waiting, until the endpoint is
    // resumed or the job is cancelled.
    const held = targets("queued").some((t) => {
      const ep = ctx.effectiveVoice(bookId, t.s.speaker).endpoint;
      return !!ep && !ep.enabled;
    });
    // stalled: nothing in flight and no queued clip can ever be placed — the voice or its
    // endpoint is gone, not merely paused
    const stalled =
      !held &&
      !targets("generating").length &&
      !targets("queued").some((t) => ctx.effectiveVoice(bookId, t.s.speaker).endpoint?.enabled);
    if (pending.length === 0 || stalled) {
      for (const t of targets("queued")) {
        t.s[t.slot] = {
          ...clipOf(t),
          status: "failed",
          error: { code: 0, message: "no endpoint available for this voice", body: "" },
        };
        logJob(job, `Segment ${t.s.id} failed: no endpoint available for this voice`, "error", {
          segment: t.s.id,
          target: t.slot,
        });
      }
      // a retake that failed is the listener's to discard: only the book's own clips decide
      // whether this chapter is finished. A clip the script moved under while it rendered came
      // back stale — that is not a failed run, it is one more line to render again.
      const failed = segs.some((s) => !["done", "stale"].includes(s.audio.status));
      const stale = segs.some((s) => s.audio.status === "stale");
      c.narration = failed ? "failed" : stale ? "stale" : "done";
      ctx.retime(bookId, c.id);
      ctx.finishJob(job, failed ? "failed" : "done");
      done();
      return;
    }
    setTimeout(tick, 200);
  };
  tick();
}
