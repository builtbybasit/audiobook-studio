// The narration job: a chapter's lines in, a clip on disk for each, written one line at a time so
// that a person watching the chapter sees them land rather than waiting for the run.
//
// The job mirrors the scripting job in how it finds its chapter — by number when it starts, by
// **uid** at every write, because a removed volume renumbers the book mid-run — and differs in
// what it writes. A scripting run replaces the script whole, once, against the revision it read;
// a narration run touches one clip of one line at a time and never the line itself, so it has
// nothing to refuse and instead moves the revision on with every clip it lands. That is what
// keeps an edit made from a copy read before a clip landed from writing the clip's old state
// back over it: the edit is refused with the 409 it already handles, and reads the chapter again.
//
// Which slot a line renders into is the store's rule, kept exactly (`queuedSlot`, in
// `server/narration/chapter.ts` with the other rules a retake and a verdict share). A line with no
// usable clip renders in place. A line that already has one renders a **candidate** beside it,
// marked `auto`, so the chapter keeps playing the old clip until the new one lands; a replacement
// that lands takes over and pushes the old clip into the take list, and one that fails leaves the
// old clip exactly as it was. A cancelled run keeps what it finished and puts back what it did not
// start.
//
// A retake is the same render without the `auto`: the candidate a person asked for stays beside
// the clip in the book when it lands, for them to judge (`server/narration/ops.ts`), and one that
// fails is theirs to discard rather than a gap in the chapter, so it does not fail the job. The
// retake's job puts its lines in the queue when it is created and runs at a scope that wants
// nothing new, so the handler renders exactly what it finds in flight.
//
// The chapter's `narration` status is the job's to keep honest, and it is asked of the clips —
// `chapterNarration` — rather than remembered: `queued` when the job is, `running` while it runs,
// and afterwards whatever the lines say, which is `failed` for a chapter with a gap in it.
//
// What a line is sent as is the demo's rule too, `expressionPlan`: the words after the book's
// dictionary, with the expression tags placed on the line written in as the speaker's endpoint
// spells them. The endpoint is read from the stored configuration as each line goes out, and a
// line whose tags that endpoint cannot say is failed before any request, with the reason, exactly
// as the demo blocks it. The endpoint's sample rate and format go with the request, and the clip
// records the rate the file actually came back at, read from the file (`probeClip`), and is kept
// under the extension of the format it actually came back in — which for the fake is always WAV.
// The format is not part of what a clip is compared against later: changing an endpoint from WAV
// to MP3 applies to the lines rendered after it, and leaves the ones already in the book alone.
//
// The handler plans the run (`planRun`), sends its lines and settles the chapter. What every line
// goes through — a slot, the budget, the audit trail, the landing — is `lineRun`; what sending a
// line in parts adds is `server/narration/parts.ts`, and what sending lines in batches adds is
// `server/narration/batch.ts`.
import type { Job, NarrationQueued, NarrationScope, Segment, SegmentAudio } from "@/types";
import { encodingOf } from "@/lib/endpointShapes";
import { chapterNarration, narrationTargets, SCOPE_LABEL } from "@/lib/runPlan";
import { expressionParts, expressionPlan, type ExpressionPlan } from "@/lib/expressions";
import { speechInstructions } from "@/lib/speech";
import { requeue } from "@/lib/takes";
import type { AudioFiles } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import { readCast, readLexicon } from "~/db/cast";
import type { Db, Tx } from "~/db/client";
import { readEndpoint } from "~/db/endpoints";
import { activeJob, getJob, nextRunId, setReserved } from "~/db/jobs";
import * as library from "~/db/library";
import {
  acceptCandidate,
  bumpRevision,
  dropCandidate,
  LineGone,
  readScript,
  rejectCandidate,
  writeClip,
} from "~/db/script";
import type { JobContext, JobHandler, Runner } from "~/jobs/runner";
import { conflict, notFound } from "~/lib/errors";
import { batchLines, type BatchLine, type LineRun } from "~/narration/batch";
import {
  inFlight,
  narrationRunOf,
  queuedSlot,
  RETAKE_LABEL,
  settleChapter,
  type RunScope,
  type Slot,
} from "~/narration/chapter";
import {
  deliveryFor,
  lineWorstCase,
  narrationCost,
  type Delivery,
  type NarrationCost,
} from "~/narration/cost";
import {
  failureCode,
  opusInParts,
  PartFailed,
  speakInParts,
  type Outcome,
} from "~/narration/parts";
import {
  createSpeechGate,
  type GateLimits,
  type GateWait,
  type SpeechGate,
} from "~/providers/gate";
import type { SentSpeech } from "~/providers/sent";
import type { BatchLimits, RenderedClip, SpeechProvider } from "~/providers/speech";
import { speechTarget } from "~/providers/target";
import { assertWithinBudget, budgetProblem } from "~/usage/budget";
import { settleSpeech } from "~/usage/ledger";

/** The way back from a label the Queue page shows to the scope it names; `SCOPE_LABEL` is one-to-one. */
const SCOPE_OF_LABEL = new Map<string, RunScope>(
  (Object.entries(SCOPE_LABEL) as [NarrationScope, string][]).map(([scope, label]) => [
    label,
    scope,
  ]),
);
SCOPE_OF_LABEL.set(RETAKE_LABEL, "pending");

/**
 * The scope a job was queued at: kept on its run detail, since the label beside it is display text
 * that may be reworded. A job queued before the scope was kept is read back from its label, and
 * a row with neither — none should exist — as `all`, the scope that leaves nothing out.
 */
export const scopeOf = (job: Job): RunScope =>
  job.narrationRun?.scope ?? SCOPE_OF_LABEL.get(job.bulk?.scope ?? "") ?? "all";
const labelOf = (scope: RunScope): string =>
  scope === "pending" ? RETAKE_LABEL : SCOPE_LABEL[scope];

/** The chapter as the job needs it: where it is, and the identity to find it by again. */
function readChapter(db: Db, bookId: string, chapterId: number) {
  const chapter = library.getChapter(db, bookId, chapterId);
  const uid = library.chapterUid(db, bookId, chapterId);
  if (!chapter || uid == null) throw notFound("The chapter no longer exists");
  return { uid, title: chapter.title };
}

/** A line this run renders: the slot its render goes to, and the queued clip holding it meanwhile. */
interface Target {
  s: Segment;
  slot: Slot;
  queued: SegmentAudio;
}

/**
 * Put one line in the queue.
 *
 * A retake already waiting is not thrown away: if it rendered it joins the take list marked
 * rejected, so the comparison the listener was in the middle of is still playable afterwards. A
 * line that has a clip with audio gets a replacement beside it, marked `auto`; one that has none
 * renders in place (`queuedSlot`).
 */
function queueRender(tx: Tx, at: { bookId: string; id: number }, s: Segment): Target {
  let audio = s.audio;
  if (s.candidate) {
    const take = rejectCandidate(tx, at.bookId, at.id, s.id);
    if (take) audio = { ...audio, takes: [...(audio.takes ?? []), take] };
  }
  return { s, ...queuedSlot(audio, { auto: true }) };
}

/**
 * The plan, written in one transaction: every line this run renders holds its slot with a queued
 * clip before the first request goes out, so the chapter reads as a run in progress from the first
 * moment. A line found already queued or generating is this job's own: the queue allows one
 * narration job per chapter, so an in-flight clip can only be what the last attempt was holding
 * when the server stopped, and it is picked up rather than skipped. A plan with nothing in it
 * settles the chapter's status as it stands.
 */
function planRun(db: Db, uid: string, scope: RunScope): { targets: Target[]; lines: number } {
  const targets: Target[] = [];
  let lines = 0;
  db.transaction((tx) => {
    const at = library.locateChapter(tx, uid);
    if (!at) throw notFound("The chapter was removed before it was narrated");
    const segs = readScript(tx, at.bookId, at.id);
    lines = segs.length;
    const wanted = new Set(
      scope === "pending" ? [] : narrationTargets(segs, scope, true).run.map((s) => s.id),
    );
    for (const s of segs) {
      let t: Target | null = null;
      if (inFlight(s.audio.status)) t = { s, slot: "current", queued: requeue(s.audio) };
      else if (s.candidate && inFlight(s.candidate.status))
        t = { s, slot: "candidate", queued: requeue(s.candidate) };
      else if (wanted.has(s.id)) t = queueRender(tx, at, s);
      if (!t) continue;
      writeClip(tx, at.bookId, at.id, s.id, t.slot, t.queued);
      targets.push(t);
    }
    if (!targets.length) {
      library.setChapterNarration(tx, at.bookId, at.id, chapterNarration(segs), 100);
      return;
    }
    library.setChapterNarration(tx, at.bookId, at.id, "running", 0);
    bumpRevision(tx, at.bookId, at.id);
  });
  return { targets, lines };
}

/**
 * A line on its way out: what it is sent as, read as it goes — the dictionary and the endpoint as
 * they stand now, not when the run began, so a term added or a tag defined mid-run applies to every
 * line not yet sent, as it does in the demo — and its queued clip turned `generating`.
 */
interface Line extends BatchLine<Target> {
  who: Delivery;
  plan: ExpressionPlan;
  generating: SegmentAudio;
  startedAt: number;
  /** hands back whatever of the line's reservation its requests did not use */
  release(): void;
}

/** What a run's lines came to, for the log's last word and the job's verdict. */
interface Tally {
  rendered: number;
  waiting: number;
  failed: number;
}

/**
 * Everything a line goes through, whichever way it is sent: a slot on its endpoint, the budget,
 * the reservation it holds, the audit trail written as it goes out, and what came back written
 * where its slot is. The run holds one of these for its lines; a batch borrows it (`LineRun`).
 */
function lineRun(o: {
  ctx: JobContext;
  provider: SpeechProvider;
  files: AudioFiles;
  gate: SpeechGate;
  chapter: { uid: string };
  deliveryOf: (speaker: string) => Delivery;
  targets: readonly Target[];
  lines: number;
  stop: AbortSignal;
}): LineRun<Target, Line> & {
  renderLine(t: Target): Promise<void>;
  /** why the budget stopped the run, or null */
  refused(): string | null;
  tally: Tally;
} {
  const { ctx, provider, files, gate, chapter, deliveryOf, targets, lines, stop } = o;
  const { job, db } = ctx;

  /** One write against the chapter wherever it is now, moving the revision with it. */
  const write = (fn: (tx: Tx, at: { bookId: string; id: number }) => void): void =>
    db.transaction((tx) => {
      const at = library.locateChapter(tx, chapter.uid);
      if (!at) throw notFound("The chapter was removed while it was being narrated");
      fn(tx, at);
      bumpRevision(tx, at.bookId, at.id);
    });

  // Progress is the demo's: how many of the chapter's lines are not still waiting on this
  // run, counted over the whole chapter so a run over three stale lines of three hundred does
  // not start at nought.
  let landed = 0;
  const progress = (): void => {
    const pct = Math.round(((lines - (targets.length - landed)) / lines) * 100);
    ctx.progress(pct);
    const at = library.locateChapter(db, chapter.uid);
    if (at) library.setChapterNarration(db, at.bookId, at.id, "running", pct);
  };

  // What counts as the run failing is the demo's rule: a line rendered in place that has no
  // clip, and a replacement the run itself chose to make. A retake a person asked for is theirs
  // to judge, so one that fails is a failed candidate for them to discard, not a failed job.
  const tally: Tally = { rendered: 0, waiting: 0, failed: 0 };
  // What this job still holds against the book's cap: the worst case it was queued with, less
  // each line's as that line settles. The column the budget sums is kept in step with it.
  let held = job.narrationRun?.reserved ?? 0;
  let refused: string | null = null;

  /** the endpoint's limits as they are saved now, which is what "applies live" means */
  const limitsOf = (id: string | null) => (): GateLimits | undefined => {
    const ep = id ? readEndpoint(db, id) : undefined;
    return ep && { concurrency: ep.concurrency, enabled: ep.enabled };
  };
  // A wait worth a line in the job's log is one a person caused or can do something about — a
  // pause, a rate limit — said once per endpoint until a line gets through again, not once for
  // every line that queues behind it. A full concurrency is the normal state of a busy run.
  const told = new Map<string, GateWait>();
  const waited = (id: string | null) => (why: GateWait) => {
    if (!id || why === "concurrency" || told.get(id) === why) return;
    told.set(id, why);
    const name = readEndpoint(db, id)?.name ?? id;
    ctx.note(
      why === "paused"
        ? `Waiting: ${name} is paused; its lines go out when it is resumed`
        : `Waiting: ${name} was rate limited; its lines go out when the cooldown ends`,
      "info",
      { endpoint: id, why },
    );
  };
  const acquire = async (id: string | null): Promise<() => void> => {
    const leave = await gate.acquire(id, limitsOf(id), { signal: stop, waiting: waited(id) });
    if (id) told.delete(id);
    return leave;
  };

  /** Whether nothing more should go out: the run was stopped, or the budget no longer covers it. */
  const halted = (): boolean => stop.aborted || refused != null;

  /**
   * The budget, asked before a line goes out, with what the job still holds and its own
   * reservation left out of the book's: a run that fitted when it was queued stops here when the
   * cap was lowered, the book was paused, or other lines cost more than they held. The lines not
   * yet sent are put back as they were (`onSettled`), and the clips landed stay.
   */
  const budgetStops = ({ s }: Target): boolean => {
    const problem = budgetProblem(db, job.bookId, {
      kind: "narration",
      cost: held,
      jobId: job.id,
      what: "the next line",
    });
    if (!problem) return false;
    refused = problem;
    const note = `Stopped before line ${s.id}: the book's budget does not cover it`;
    ctx.note(note, "warning", { line: s.id, why: problem });
    return true;
  };

  /** A line removed while it rendered: said, and counted as landed, and its hold given back. */
  const gone = (s: Segment, release: () => void): void => {
    const note = `Line ${s.id} was removed while it rendered; the clip was dropped`;
    ctx.note(note, "warning", { line: s.id });
    landed++;
    release();
  };

  /**
   * Commit a line to going out: its reservation, its ledger reports and the audit trail on its
   * clip. `maxChars` is where it is cut when a batch takes shorter items than the endpoint does.
   * Null when the line was removed before it could go.
   */
  const commit = (t: Target, maxChars?: number | null): Line | null => {
    const { s, slot } = t;
    const who = deliveryOf(s.speaker);
    const instructions = speechInstructions({ style: who.style, direction: s.direction });
    const ep = who.endpoint ? readEndpoint(db, who.endpoint) : undefined;
    const plan = expressionPlan(s, ep, readLexicon(db, job.bookId));
    // What this line gives back to the cap: each request's charge as it is written to the
    // ledger, so what a line has spent is never also still held while another line asks the
    // budget, and whatever is left once the line has settled, whether it rendered, failed or
    // was never sent — from then on its cost is in the ledger, or it was never going to be.
    let left = lineWorstCase(ep, plan, instructions, Date.now());
    const give = (amount: number): void => {
      const back = Math.min(left, Math.max(0, amount));
      if (!back) return;
      left -= back;
      held = Math.max(0, held - back);
      setReserved(db, job.id, held);
    };
    // Every request that reached the wire — each part of a split line is its own, and so is
    // each item of a batch — is priced into the ledger as it settles, against the endpoint as
    // it is stored at that moment. A request whose endpoint has been removed since has no rate
    // card to be priced on and is left out, as is one whose book has gone.
    const work = {
      bookId: job.bookId,
      label: `${slot === "candidate" ? (t.queued.auto ? "Replacement" : "Retake") : "Line"} ${s.id} · ${s.speaker}`,
      queuedAt: job.queuedAt,
      ...(who.voiceRef ? { voiceRef: who.voiceRef } : {}),
    };
    const settle = (sent: SentSpeech): void => {
      const priced = who.endpoint ? readEndpoint(db, who.endpoint) : undefined;
      if (!priced || !library.getBook(db, job.bookId)) return;
      // a chapter removed mid-request is still where the money went; the label says which
      const chapterUid = library.locateChapter(db, chapter.uid) ? chapter.uid : null;
      give(settleSpeech(db, priced, { ...work, chapterUid }, sent).cost ?? 0);
    };
    // Where the line is cut to fit the endpoint's `maxChars` — or a batch's shorter limit —
    // decided before it goes out so the clip can say so while it renders. A line with an issue
    // is not sent at all, and the one issue `splitText` would throw on — a tag longer than the
    // limit — is one of them.
    const limit =
      ep && maxChars ? { ...ep, maxChars: Math.min(ep.maxChars || maxChars, maxChars) } : ep;
    const cuts = limit && !plan.issues.length ? expressionParts(plan, limit) : null;
    const startedAt = Date.now();
    // The audit trail, written when the request goes out: exactly what this clip is being
    // rendered with, so a later edit to the line, the cast or the voice reads as drift.
    const generating: SegmentAudio = {
      ...t.queued,
      status: "generating",
      endpoint: who.endpoint,
      startedAt,
      at: startedAt,
      ...(who.voiceRef ? { voiceRef: who.voiceRef } : {}),
      ...(who.voice ? { voice: who.voice } : {}),
      model: provider.name,
      direction: s.direction,
      style: who.style,
      ...(instructions ? { instructions } : {}),
      type: s.type,
      text: s.text,
      // what the dictionary made of it, recorded whether or not it changed anything: the
      // browser's drift rule compares this against the dictionary as it now stands
      pronounced: plan.pronounced,
      ...(plan.signature ? { expressionSignature: plan.signature } : {}),
      ...(plan.tags.length ? { expressions: plan.tags } : {}),
      ...(plan.text !== s.text ? { said: plan.text, lex: plan.hits.length } : {}),
      // Recorded as the demo records them: how many requests and at which boundary always,
      // where each cut fell only when there was more than one part. Set every time rather than
      // carried from the clip this one replaces, whose endpoint may have had another limit.
      parts: cuts?.length,
      splitAt: cuts ? limit!.splitAt : undefined,
      cuts:
        cuts && cuts.length > 1
          ? cuts.map((c) => ({ from: c.from, to: c.to, at: c.at, fallback: c.fallback }))
          : undefined,
    };
    const release = (): void => give(left);
    try {
      write((tx, at) => writeClip(tx, at.bookId, at.id, s.id, slot, generating));
    } catch (e) {
      if (!(e instanceof LineGone)) throw e;
      gone(s, release);
      return null;
    }
    return {
      t,
      who,
      plan,
      cuts,
      input: {
        text: plan.text,
        speaker: s.speaker,
        type: s.type,
        direction: s.direction,
        instructions,
        voiceRef: who.voiceRef,
        sampleRate: ep?.sampleRate ?? null,
        encoding: ep ? encodingOf(ep) : { format: "wav" },
        // the endpoint as saved now and its key read now, for the provider alone
        target: ep ? speechTarget(db, ep) : null,
        signal: stop,
        sent: settle,
        ...(who.endpoint
          ? { rateLimited: (ms: number) => gate.rateLimited(who.endpoint!, ms) }
          : {}),
      },
      generating,
      startedAt,
      release,
      tries: 0,
    };
  };

  /**
   * Why a committed line cannot be sent at all, or null: a tag the endpoint cannot say is the
   * demo's "blocked before dispatch" — the line is not sent, rather than sent without the tag
   * and marked stale on arrival — and an Opus line in parts could not be kept (`speakInParts`).
   */
  const unsendable = (line: Line): Error | null =>
    line.plan.issues.length
      ? new Error(`Expression needs attention: ${line.plan.issues[0].reason}`)
      : line.cuts && line.cuts.length > 1 && line.input.encoding.format === "opus"
        ? opusInParts(line.cuts.length)
        : null;

  const outcomeOf = async (send: () => Promise<RenderedClip>): Promise<Outcome> => {
    try {
      const rendered = await send();
      if (stop.aborted) throw stop.reason;
      return { rendered };
    } catch (e) {
      if (stop.aborted) throw e;
      return { error: e };
    }
  };

  /** Write what came back — a clip, or the failure — where the line's slot is, and say so. */
  const land = async (line: Line, outcome: Outcome): Promise<void> => {
    const { t, who, plan, generating, startedAt, release } = line;
    const { s, slot } = t;
    let clip: SegmentAudio;
    try {
      if ("error" in outcome) throw outcome.error;
      const { rendered } = outcome;
      // the rate is read off the file, whatever was asked for: audio a build cannot read is a
      // failed line now rather than a failed audiobook later
      let sampleRate: number;
      try {
        ({ sampleRate } = await probeClip(rendered.bytes, rendered.format));
      } catch (e) {
        const why = (e as Error).message;
        throw new Error(`The audio that came back could not be read: ${why}`, { cause: e });
      }
      // by the book, which is where the file stays whatever the chapter's number becomes
      const { url } = await files.write(job.bookId, rendered.bytes, rendered.format);
      clip = {
        ...generating,
        status: "done",
        ms: rendered.ms,
        duration: rendered.duration,
        url,
        at: Date.now(),
        model: rendered.model,
        ...(rendered.voice != null ? { voice: rendered.voice } : {}),
        sampleRate,
      };
    } catch (e) {
      if (stop.aborted) throw e;
      // A line that could not be rendered is a failed clip where the run put it — a failed
      // replacement stays a candidate beside the clip it did not replace, and a failed render
      // in place is the gap the chapter's status will say it has.
      clip = {
        ...generating,
        status: "failed",
        ms: Date.now() - startedAt,
        duration: 0,
        at: Date.now(),
        error: {
          code: failureCode(e),
          message: e instanceof Error ? e.message : String(e),
          body: "",
          at: Date.now(),
          ...(e instanceof PartFailed ? { part: e.part } : {}),
        },
      };
    }

    // A replacement the run made for itself takes over as it lands; a retake stays beside the
    // clip in the book for the verdict.
    const replacement = slot === "candidate" && !!clip.auto;
    const retake = slot === "candidate" && !clip.auto;
    try {
      write((tx, at) => {
        // A dictionary replaced while the line was out marked stale only the clips that had
        // landed, so one that lands after it is checked here, in the same transaction as the
        // write — the words it was sent may no longer be the words the book would send. An
        // endpoint saved meanwhile is the same question about its tags and its rate.
        if (clip.status === "done" && movedOn(tx, at.bookId, s, who.endpoint, plan, clip))
          clip = { ...clip, status: "stale" };
        writeClip(tx, at.bookId, at.id, s.id, slot, clip);
        if (replacement && clip.status !== "failed") acceptCandidate(tx, at.bookId, at.id, s.id);
      });
    } catch (e) {
      if (!(e instanceof LineGone)) throw e;
      gone(s, release);
      return;
    }
    landed++;
    release();
    const detail = { line: s.id, speaker: s.speaker };
    if (clip.status === "stale")
      ctx.note(
        `Line ${s.id} was sent before the dictionary or its endpoint changed; it reads as stale`,
        "warning",
        detail,
      );
    if (clip.status !== "failed") {
      const arrived = {
        ...detail,
        seconds: Number(clip.duration.toFixed(2)),
        ...(clip.parts && clip.parts > 1 ? { parts: clip.parts } : {}),
        ms: clip.ms,
        ...(slot === "candidate" ? { take: clip.n ?? 1 } : {}),
      };
      if (retake) {
        tally.waiting++;
        ctx.note(
          `Line ${s.id} take ${clip.n ?? 1} rendered, waiting for a verdict`,
          "info",
          arrived,
        );
      } else {
        tally.rendered++;
        ctx.note(
          replacement ? `Line ${s.id} replaced take ${s.audio.n ?? 1}` : `Line ${s.id} rendered`,
          "info",
          arrived,
        );
      }
    } else {
      const error = { ...detail, error: clip.error?.message ?? "" };
      if (retake) {
        ctx.note(
          `Line ${s.id} take ${clip.n ?? 1} failed; the clip in the book is unchanged`,
          "warning",
          error,
        );
      } else {
        tally.failed++;
        ctx.note(
          replacement
            ? `Line ${s.id} replacement failed; the clip already in the book is unchanged`
            : `Line ${s.id} failed`,
          "error",
          error,
        );
      }
    }
    progress();
  };

  /** One line, on its own: a slot, then its request — or its parts, one after another. */
  const renderLine = async (t: Target): Promise<void> => {
    const leave = await acquire(deliveryOf(t.s.speaker).endpoint);
    try {
      if (halted() || budgetStops(t)) return;
      const line = commit(t);
      if (!line) return;
      const blocked = unsendable(line);
      await land(
        line,
        blocked
          ? { error: blocked }
          : await outcomeOf(() => speakInParts(provider, line.input, line.cuts)),
      );
    } finally {
      leave();
    }
  };

  return {
    provider,
    gate,
    stop,
    acquire,
    halted,
    budgetStops,
    commit,
    unsendable,
    outcomeOf,
    land,
    renderLine,
    refused: () => refused,
    tally,
  };
}

export function narrationHandler(
  provider: SpeechProvider,
  files: AudioFiles,
  gate: SpeechGate = createSpeechGate(),
): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      if (job.chapterId == null) throw new Error("A narration job is for one chapter");
      const chapter = readChapter(db, job.bookId, job.chapterId);
      const scope = scopeOf(job);

      // A speaker's voice is their own or the Narrator's, and their style is their own: the cast
      // store's `effectiveVoice`, read once, because the cast is the book's and a rename mid-run
      // is the rename's problem — it marks the clips it moved stale.
      const deliveryOf = deliveryFor(readCast(db, job.bookId));

      const { targets, lines } = planRun(db, chapter.uid, scope);
      if (!targets.length) {
        ctx.note("Nothing to narrate", "info", { scope: labelOf(scope) });
        return;
      }
      ctx.note("Narration started", "info", {
        provider: provider.name,
        lines: targets.length,
        replacing: targets.filter((t) => t.slot === "candidate").length,
        scope: labelOf(scope),
      });

      // The lines go out as their endpoints will take them (`gate.ts`): each asks the speech gate
      // for a slot on its speaker's endpoint, in the chapter's order, and is sent when it has one —
      // up to the endpoint's concurrency at once, none while it is paused or cooling down after a
      // rate limit, and lines for another endpoint alongside. They land in whatever order they are
      // answered; each is written by its own line id, so the order they land in is nobody's business
      // but the progress bar's.
      //
      // Three things stop the run short. A budget that no longer covers the next line stops anything
      // more going out, lets the lines already out land and be paid for, and fails the job after, as
      // a scripting run does. Anything else that goes wrong beyond one line — the chapter removed
      // under the run — stops every line at once, those in flight included, and is what the job
      // fails with. A cancel is the same stop, and the lines not yet written are put back
      // (`onSettled`).
      const stop = new AbortController();
      const onAbort = (): void => stop.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      let fatal: { error: unknown } | null = null;
      const run = lineRun({
        ctx,
        provider,
        files,
        gate,
        chapter,
        deliveryOf,
        targets,
        lines,
        stop: stop.signal,
      });

      // Which endpoints take batches, asked once per run of each endpoint its lines go to; one
      // that cannot say — no such route, a model it does not batch, no answer — is sent one line
      // at a time, as every endpoint was before.
      const groups = new Map<string, Target[]>();
      const alone: Target[] = [];
      for (const t of targets) {
        const id = deliveryOf(t.s.speaker).endpoint;
        const ep = id ? readEndpoint(db, id) : undefined;
        if (!id || !ep || !provider.batchLimits || !provider.speakBatch) alone.push(t);
        else groups.set(id, [...(groups.get(id) ?? []), t]);
      }
      const batched: [string, Target[], BatchLimits][] = [];
      for (const [id, lines] of groups) {
        const ep = readEndpoint(db, id)!;
        const limits = await provider.batchLimits!(speechTarget(db, ep), stop.signal).catch(
          () => null,
        );
        if (signal.aborted) throw signal.reason;
        if (limits) batched.push([id, lines, limits]);
        else alone.push(...lines);
      }
      if (batched.length)
        ctx.note("Sending in batches", "info", {
          endpoints: batched
            .map(([id, , l]) => `${id} (${l.maxItems ?? "any number"} a batch)`)
            .join(", "),
        });

      await Promise.all(
        [
          ...alone
            .sort((a, b) => targets.indexOf(a) - targets.indexOf(b))
            .map((t) => run.renderLine(t)),
          ...batched.map(([id, lines, limits]) => batchLines(run, id, lines, limits)),
        ].map((work) =>
          work.catch((e: unknown) => {
            // the first thing to go wrong is the one the job fails with; what the stop then shakes
            // loose from the other lines is only the stop
            if (stop.signal.aborted) return;
            fatal = { error: e };
            stop.abort(e);
          }),
        ),
      );
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) throw signal.reason;
      if (fatal) throw (fatal as { error: unknown }).error;
      const refused = run.refused();
      if (refused != null) throw new Error(refused);

      // Every line has settled, so what the job still holds is only the difference between pricing
      // the lines one by one and together; finishing the job gives it back (`finishJob`).
      let seconds = 0;
      db.transaction((tx) => {
        const at = library.locateChapter(tx, chapter.uid);
        if (!at) throw notFound("The chapter was removed while it was being narrated");
        seconds = settleChapter(tx, at.bookId, at.id).seconds;
      });
      const { rendered, failed, waiting } = run.tally;
      ctx.note("Narration finished", failed ? "warning" : "info", {
        rendered,
        failed,
        ...(waiting ? { waiting } : {}),
        seconds: Number(seconds.toFixed(2)),
      });
      if (failed) throw new Error(`${failed} line${failed === 1 ? "" : "s"} could not be rendered`);
    },

    onSettled(ctx, status) {
      // `done` wrote the chapter's status inside its own transaction. Anything else — a cancel, a
      // failure, a recovery that gave up on a queued job — puts back what the run was holding: a
      // line waiting to render in place goes back to having no clip, and a replacement that never
      // landed is dropped, which leaves the clip it would have replaced exactly as it was. What
      // was finished stays finished. Read off the job's row, whose chapter number has followed any
      // renumbering by cascade, rather than the number the job started with.
      if (status === "done") return;
      const fresh = getJob(ctx.db, ctx.job.id);
      if (!fresh || fresh.chapterId == null) return;
      const { bookId, chapterId } = fresh;
      ctx.db.transaction((tx) => {
        if (!library.chapterExists(tx, bookId, chapterId)) return;
        let putBack = 0;
        for (const s of readScript(tx, bookId, chapterId)) {
          if (inFlight(s.audio.status)) {
            writeClip(tx, bookId, chapterId, s.id, "current", {
              ...requeue(s.audio),
              status: "none",
            });
            putBack++;
          }
          if (s.candidate && inFlight(s.candidate.status)) {
            dropCandidate(tx, bookId, chapterId, s.id);
            putBack++;
          }
        }
        const segs = readScript(tx, bookId, chapterId);
        // a run that was interrupted starts its progress again; one that ran to its end and
        // failed on a line keeps the hundred its final write recorded
        library.setChapterNarration(
          tx,
          bookId,
          chapterId,
          chapterNarration(segs),
          putBack ? 0 : undefined,
        );
        if (putBack) bumpRevision(tx, bookId, chapterId);
      });
    },
  };
}

/**
 * Queue a narration job for each chapter, as one run at one scope.
 *
 * Chapters skipped for the audiobook, chapters with no script, chapters already being narrated and
 * chapters the scope finds nothing to do in are left out and said so, rather than refused: a bulk
 * press over a selection that includes one is a person's intent for the rest. A book still in its
 * contents review has nothing to narrate yet, and that is refused. What the scope will render is
 * decided here, by the same `narrationTargets` the run itself uses, so a chapter queued is a
 * chapter with work in it.
 *
 * The run is priced before anything is queued, chapter by chapter at its worst case, and checked
 * against the book's budget whole: a run that does not fit is refused with a 409 and no chapter of
 * it is queued, because half a run is not what anyone asked for. Each job holds its own chapter's
 * figure until its lines settle.
 */
export function enqueueNarration(
  db: Db,
  runner: Runner,
  bookId: string,
  ids: readonly number[],
  { scope }: { scope: NarrationScope },
): NarrationQueued {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  if (book.importing) throw conflict("Finish the contents review before narrating this book");
  const known = new Map(library.listChapters(db, bookId).map((c) => [c.id, c]));

  const at = Date.now();
  const targets: { id: number; clips: number; replacing: boolean; cost: NarrationCost }[] = [];
  const skipped: NarrationQueued["skipped"] = [];
  for (const id of ids) {
    const c = known.get(id);
    if (!c) {
      skipped.push({ id, why: "missing" });
      continue;
    }
    if (c.excluded) {
      skipped.push({ id, why: "excluded" });
      continue;
    }
    const segs = readScript(db, bookId, id);
    if (!segs.length) {
      skipped.push({ id, why: "unscripted" });
      continue;
    }
    if (activeJob(db, "narration", bookId, id)) {
      skipped.push({ id, why: "busy" });
      continue;
    }
    const { run } = narrationTargets(segs, scope, true);
    if (!run.length) {
      skipped.push({ id, why: "nothing" });
      continue;
    }
    targets.push({
      id,
      clips: run.length,
      replacing: c.narration === "done" || c.narration === "stale",
      cost: narrationCost(db, bookId, run, at),
    });
  }
  if (targets.length)
    assertWithinBudget(db, bookId, {
      kind: "narration",
      cost: targets.reduce((n, t) => n + t.cost.reserved, 0),
    });

  const runId = nextRunId(db);
  const jobs: Job[] = [];
  targets.forEach(({ id, clips, replacing, cost }, i) => {
    const { job } = runner.enqueue({
      kind: "narration",
      bookId,
      chapterId: id,
      label: `${replacing ? "Re-narrate" : "Narrate"} · ch ${id}`,
      bulk: {
        id: runId,
        op: replacing ? "Re-narrate" : "Narrate",
        index: i + 1,
        total: targets.length,
        scope: SCOPE_LABEL[scope],
      },
      run: { narrationRun: narrationRunOf(cost, clips, scope) },
      // in the same transaction as the row, so it cannot land after the worker has moved on
      onCreated: (tx) => library.setChapterNarration(tx, bookId, id, "queued", 0),
    });
    jobs.push(job);
  });
  // the chapters as they now stand, with the queued ones marked
  return { jobs, skipped, runId, chapters: library.listChapters(db, bookId) };
}

/**
 * Whether a clip that has just landed was rendered from a request the book would no longer send:
 * other words after the dictionary, other tags, or — when the endpoint now names a rate — another
 * rate than the file came back at. The browser's drift rule asks the same of a clip already in the
 * book; this asks it of one in flight while the dictionary or the endpoint was saved. The format
 * is not asked about: a clip in WAV is as good a clip after the endpoint moves to MP3.
 */
function movedOn(
  tx: Tx,
  bookId: string,
  s: Segment,
  endpointId: string | null,
  sent: ExpressionPlan,
  clip: SegmentAudio,
): boolean {
  const ep = endpointId ? readEndpoint(tx, endpointId) : undefined;
  const now = expressionPlan(s, ep, readLexicon(tx, bookId));
  return (
    now.text !== sent.text ||
    now.signature !== sent.signature ||
    (!!ep?.sampleRate && clip.sampleRate !== ep.sampleRate)
  );
}
