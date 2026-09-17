// The simulated TTS transport. One run renders two kinds of clip: a segment's own audio, and the
// retake standing beside it — `slot` says which one a target writes to, so a retake never lands on
// the book's clip.
//
// Latency, rate limits and failures are drawn from each endpoint's own configured numbers, so
// pausing an endpoint, tightening its concurrency or raising its failure rate all show up here.
import { keyring } from "@/lib/keyring";
import { billingOf, billingUnitLabel } from "@/lib/endpoints";
import { logJob, jobWaiting, startJob } from "@/lib/jobActivity";
import {
  PRICING_RULE,
  ensurePricing,
  measureSpeech,
  money,
  priceSpeechRequest,
  speechWhy,
} from "@/lib/pricing";
import { speechInstructions } from "@/lib/speech";
import { simulateSpeechUsage, speechUsageFormatFor } from "@/mock/simulators/usage";
import { expressionParts } from "@/lib/expressions";
import { requeue } from "@/lib/takes";
import { rnd } from "@/mock/random";
import { REQUEST_ERRORS } from "@/mock/fixtures/errors";
import { simMs } from "@/mock/simulators/clock";
import type { SimulatorContext } from "@/mock/simulators/context";
import type { ExpressionPlan } from "@/lib/expressions";
import type {
  AudioStatus,
  Chapter,
  Character,
  EffectiveVoice,
  Job,
  NarrationStatus,
  ReqError,
  Segment,
  SegmentAudio,
  SpeechCharge,
} from "@/types";

export interface NarrationSimContext extends SimulatorContext {
  segmentsOf(bookId: string, chId: number): Segment[];
  charactersOf(bookId: string): Character[];
  effectiveVoice(bookId: string, speaker: string): EffectiveVoice;
  expressionRender(bookId: string, segment: Segment): ExpressionPlan;
  clipDrift(bookId: string, segment: Segment, audio?: SegmentAudio): string[];
  markStale(bookId: string, chId: number, segment: Segment): void;
  /** a replacement queued by a bulk run rendered successfully; it becomes the clip in the book */
  acceptReplacement(bookId: string, chId: number, segId: number): void;
  /** what the chapter's narration reads as, from its clips as they now stand */
  chapterNarration(bookId: string, chId: number): NarrationStatus;
  retime(bookId: string, chId: number): void;
  /**
   * One settled speech request, appended to the ledger with the receipt it was charged at.
   *
   * Every request that reached the provider goes here — the ones that failed too, because a
   * provider charges for what was sent whatever came back of it, and because the clip itself is a
   * poor record: it is overwritten by the next take and pushed aside by the next run. What was
   * spent is a fact about the request, not about whatever the line happens to be holding now.
   */
  recordSpeech(r: {
    bookId: string;
    chapterId: number;
    endpointId: string;
    label: string;
    status: "done" | "failed";
    queuedAt: number;
    startedAt: number;
    finishedAt: number;
    charge: SpeechCharge;
    error?: ReqError;
  }): void;
  /** A request the provider refused outright. Nobody bills a 429, but it happened. */
  recordRefused(r: {
    bookId: string;
    chapterId: number;
    endpointId: string;
    label: string;
    at: number;
    startedAt: number;
    error: ReqError;
  }): void;
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
  /**
   * What this chapter has actually been charged, as each request settles.
   *
   * Every **billable attempt** counts, not every successful clip: a render that failed still sent
   * its text and is still charged for it by a per-character, per-byte or per-request provider, and
   * a line that succeeded on its second try was paid for twice. Counting finished clips instead
   * would quietly report a run as cheaper than the ledger says it was — which is the same mistake
   * that made spending fall when a retake was accepted.
   */
  const charged = {
    amount: 0,
    inputAmount: 0,
    audioAmount: 0,
    requests: 0,
    unpriced: 0,
    failedRequests: 0,
    /** generated audio only: the silence stitched between clips is never rendered or billed */
    audioSeconds: 0,
    estimatedLines: 0,
  };
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
      // Everything already rendered stays rendered — a cancelled run keeps what it finished. A clip
      // that never started goes back to having no audio, and a replacement that never started is
      // dropped, which leaves the clip it would have replaced exactly as it was.
      for (const t of targets("queued"))
        if (t.slot === "candidate") delete t.s.candidate;
        else t.s.audio.status = "none";
      if (!targets("generating").length) {
        c.narration = ctx.chapterNarration(bookId, c.id);
        ctx.retime(bookId, c.id);
        ctx.finishJob(job, "cancelled");
        return done();
      }
      return setTimeout(tick, simMs(200));
    }
    // A segment is rendered by the endpoint that owns its speaker's voice (falling back to the
    // Narrator's). Long text is split into `parts` requests against that endpoint's limit.
    const waiting = new Set<string>();
    const bookPaused = ctx.paused(bookId);
    if (bookPaused) waiting.add("Book is paused");
    for (const target of bookPaused ? [] : targets("queued")) {
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
          ...(queued.auto ? { auto: true } : {}),
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
      // What else goes over the wire with the line. A provider that meters what it receives meters
      // this too, so it is composed once, recorded on the clip, and counted by `measureSpeech`.
      const who = ctx.charactersOf(bookId).find((x) => x.name === next.speaker);
      const instructions = speechInstructions({ style: who?.style, direction: next.direction });
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
        ...(instructions ? { instructions } : {}),
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
        `Segment ${next.id}${slot === "candidate" ? (queued.auto ? " replacement" : " retake") : ""} started`,
        "info",
        diagnostic,
      );
      next[slot] = {
        status: "generating",
        endpoint: ep.id,
        ms: 0,
        duration: 0,
        startedAt: Date.now(),
        // the take number, the history of this clip and what it is for survive the render
        ...(queued.takes?.length ? { takes: queued.takes } : {}),
        ...(queued.n ? { n: queued.n } : {}),
        ...(queued.auto ? { auto: true } : {}),
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
        ...(instructions ? { instructions } : {}),
        type: next.type,
        text: next.text,
        pronounced: said.pronounced,
        expressionSignature: said.signature,
        expressions: said.tags,
        ...(sent !== next.text ? { said: sent, lex: said.hits.length } : {}),
        at: Date.now(),
        // No cost yet. A clip is priced when it *lands*, not when it goes out: a per-minute
        // endpoint cannot be charged before there is any audio, and a run long enough to cross an
        // off-peak boundary or a promotion expiry has to charge the clips either side of it
        // differently. `PRICING_RULE` is the same rule the scripting side records.
      };
      const dur = ep.latency * rnd(0.5, 1.1) * parts + sent.length * 6;
      // when this request actually went out, for the row the ledger keeps of it
      const dispatchedAt = Date.now();
      const rowLabel = `${slot === "candidate" ? (queued.auto ? "Replacement" : "Retake") : "Line"} ${next.id} · ${next.speaker}`;
      // the wait is shortened by the demo speed; `dur` is what the clip records as its latency
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
          // the attempt is over even though nothing was rendered and nothing was charged; it stays
          // in the ledger because it is the reason the queue stopped moving
          ctx.recordRefused({
            bookId,
            chapterId: c.id,
            endpointId: ep.id,
            label: rowLabel,
            at: Date.now(),
            startedAt: dispatchedAt,
            error: { ...ep.lastError },
          });
          next[slot] = requeue(clip);
          return;
        }
        const fail = Math.random() < ep.failRate;
        clip.ms = Math.round(dur);
        clip.duration = fail ? 0 : said.pronounced.split(" ").length / 2.6;
        // Priced here, at the rates in force now, from what was actually sent and what came back.
        // A clip that failed produced no audio, so a per-minute endpoint charges it nothing while a
        // per-character or per-request one still charges for what it sent — which is what those
        // providers do. The receipt is kept on the clip and never recalculated.
        // What was actually submitted, counted every way a provider can bill it: the line after the
        // dictionary and the expression tags, plus the voice instructions sent beside it. Not the
        // source text, and not the split limit — those are different questions with different
        // answers. `clip.duration` is generated audio only; the silence stitched between clips is
        // never rendered and so is never billed.
        const billing = billingOf(ep);
        const units = measureSpeech(
          { text: sent, instructions, requests: parts, audioSeconds: clip.duration },
          billing,
        );
        // What the provider itself said about this request, in its own payload shape and read back
        // through the normalizer exactly as a real response would be. A provider that reports
        // nothing leaves every field null, and the charge falls back to what we counted.
        const answer = fail
          ? null
          : simulateSpeechUsage({ units }, speechUsageFormatFor(ep.model, ep.baseUrl));
        const charge = priceSpeechRequest(billing, ensurePricing(ep), units, {
          at: Date.now(),
          rule: PRICING_RULE,
          reported: answer?.usage ?? null,
        });
        clip.charge = charge;
        if (charge.amount != null) clip.cost = charge.amount;
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
        // The request is settled, so it goes into the ledger now — before anything is decided about
        // which clip ends up in the book. What it cost is a fact about the request; the clip is
        // only where the audio landed, and a retake, a replacement or a later run moves that.
        charged.requests++;
        if (fail) charged.failedRequests++;
        charged.audioSeconds += charge.units.audioSeconds;
        if (charge.amount == null) charged.unpriced++;
        else charged.amount += charge.amount;
        if (charge.basis === "estimated") charged.estimatedLines++;
        for (const l of charge.lines) {
          if (l.amount == null) continue;
          if (l.component === "audioTokens" || charge.unit === "minute")
            charged.audioAmount += l.amount;
          else charged.inputAmount += l.amount;
        }
        ctx.recordSpeech({
          bookId,
          chapterId: c.id,
          endpointId: ep.id,
          label: rowLabel,
          status: fail ? "failed" : "done",
          queuedAt: dispatchedAt,
          startedAt: dispatchedAt,
          finishedAt: Date.now(),
          charge,
          ...(clip.error ? { error: { ...clip.error } } : {}),
        });
        logJob(
          job,
          `Segment ${next.id} ${fail ? "failed" : clip.status === "stale" ? "completed with outdated audio" : "completed"}`,
          fail ? "error" : clip.status === "stale" ? "warning" : "info",
          {
            ...diagnostic,
            responseMs: clip.ms,
            audioSeconds: clip.duration,
            pricedAt: new Date(charge.at).toISOString(),
            pricingRule: charge.rule,
            billedBy: billingUnitLabel(charge.unit),
            rates: charge.lines
              .map(
                (l) =>
                  `${l.component}: ${l.rate == null ? "not known" : money(l.rate)} on ${Math.round(l.quantity).toLocaleString()} (${l.source})`,
              )
              .join(" + "),
            ...(speechWhy(charge).length ? { why: speechWhy(charge).join(" · ") } : {}),
            costUSD: charge.amount ?? "unknown",
            costBasis: charge.basis,
            ...(clip.error ? { code: clip.error.code, error: clip.error.message } : {}),
          },
        );
        // A bulk replacement is accepted by the run that asked for it: the new clip takes over and
        // the one it displaces joins the take list. A replacement that failed leaves the book's own
        // clip untouched and stays where the listener can see it.
        if (slot === "candidate" && clip.auto) {
          if (fail)
            logJob(
              job,
              `Segment ${next.id} replacement failed; the clip already in the book is unchanged`,
              "warning",
              { segment: next.id, keptTake: next.audio.n ?? 1 },
            );
          else {
            ctx.acceptReplacement(bookId, c.id, next.id);
            logJob(job, `Segment ${next.id} replaced take ${next.audio.n ?? 1}`, "info", {
              segment: next.id,
              take: clip.n ?? 1,
            });
          }
        }
      }, simMs(dur));
    }
    jobWaiting(job, [...waiting].sort().join("; "));
    const pending = targets("queued", "generating");
    // a line is outstanding wherever its render is going: counting only `audio` showed a run that
    // replaces finished clips as 100% done before it had rendered a single one
    const busy = new Set(pending.map((t) => t.s.id));
    c.narrationProgress = Math.round(((segs.length - busy.size) / segs.length) * 100);
    job.progress = c.narrationProgress;
    // Pausing an endpoint holds its queued clips rather than failing them: that is the whole
    // difference between Pause and Cancel. The run stays open, waiting, until the endpoint is
    // resumed or the job is cancelled.
    const held =
      bookPaused ||
      targets("queued").some((t) => {
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
      const failed =
        segs.some((s) => !["done", "stale"].includes(s.audio.status)) ||
        segs.some((s) => s.candidate?.auto && s.candidate.status === "failed");
      c.narration = ctx.chapterNarration(bookId, c.id);
      ctx.retime(bookId, c.id);
      reconcile(job, charged);
      ctx.finishJob(job, failed ? "failed" : "done");
      done();
      return;
    }
    setTimeout(tick, simMs(200));
  };
  tick();
}

/**
 * Say how this chapter's estimate held up, once every request has settled.
 *
 * The estimate was worked out from the text that was going to be submitted and — where the endpoint
 * bills on the audio — from this app's own reading-speed guess and the endpoint's configured
 * audio-token conversion. Those are the two assumptions worth reporting against, so the two halves
 * are reconciled separately rather than netted off against each other: an input side that lands on
 * the nose and an audio side 30% out is a very different story from both being 15% out, and only
 * one of them is fixed by changing a number on the Pricing tab.
 *
 * `charged` counts billable attempts, so a run that retried three lines reports what those retries
 * cost rather than what the clips that survived did.
 */
function reconcile(
  job: Job,
  charged: {
    amount: number;
    inputAmount: number;
    audioAmount: number;
    requests: number;
    unpriced: number;
    failedRequests: number;
    audioSeconds: number;
    estimatedLines: number;
  },
): void {
  const run = job.narrationRun;
  if (!run || run.estimated == null || !charged.requests) return;
  const delta = charged.amount - run.estimated;
  const drift = (estimated: number | null | undefined, actual: number): string =>
    estimated == null || estimated === 0
      ? "—"
      : `${actual >= estimated ? "+" : ""}${Math.round(((actual - estimated) / estimated) * 100)}%`;
  logJob(job, "Estimate reconciled against what was charged", "info", {
    estimatedUSD: run.estimated,
    chargedUSD: charged.amount,
    difference: `${delta >= 0 ? "+" : ""}${money(delta)}`,
    billableAttempts: charged.requests,
    ...(charged.failedRequests
      ? {
          failedButCharged: `${charged.failedRequests} request${charged.failedRequests === 1 ? "" : "s"} failed and were still charged for what they sent`,
        }
      : {}),
    // the two halves, where this chapter had an audio-billed endpoint in it at all
    ...(run.estimatedAudio != null
      ? {
          inputEstimatedUSD: run.estimatedInput ?? 0,
          inputChargedUSD: charged.inputAmount,
          inputDrift: drift(run.estimatedInput, charged.inputAmount),
          audioEstimatedUSD: run.estimatedAudio,
          audioChargedUSD: charged.audioAmount,
          audioDrift: drift(run.estimatedAudio, charged.audioAmount),
          audioSeconds: Number(charged.audioSeconds.toFixed(2)),
          note: "generated audio only — silence stitched between clips is not rendered and is not billed",
        }
      : {}),
    ...(charged.estimatedLines
      ? {
          estimatedUsage: `${charged.estimatedLines} of ${charged.requests} requests were priced from counts worked out here rather than reported by the provider`,
        }
      : {}),
    ...(charged.unpriced
      ? {
          unpriced: `${charged.unpriced} request${charged.unpriced === 1 ? "" : "s"} went to an endpoint with no rate, so the charged figure is a floor`,
        }
      : {}),
  });
}
