// The narration job: renders a chapter's lines to clips and lands them one at a time.
// Finds its chapter by number at start but by uid at every write (a removed volume renumbers the
// book mid-run). Each landed clip moves the revision on, so an edit from a stale copy gets a 409.
// A line that already has a clip renders an `auto` candidate beside it (`queuedSlot` in
// server/narration/chapter.ts); the old clip plays until the new one lands.
import type { Job, NarrationQueued, NarrationScope, Segment, SegmentAudio } from "@/types";
import { chainsFor, runnable, soundOf, thoughtEffectOf, type EffectContext } from "@/lib/effects";
import { encodingOf } from "@/lib/endpointShapes";
import { chapterNarration, narrationTargets, SCOPE_LABEL } from "@/lib/runPlan";
import { isSpoken } from "@/lib/siteText";
import { joinedParts } from "@/lib/split";
import { compareReading, cutReading, readingRecord, type Reading } from "@/lib/reading";
import { requeue } from "@/lib/takes";
import type { EffectRunner } from "~/audio/effects";
import type { AudioFiles } from "~/audio/files";
import { probeClip } from "~/audio/probe";
import type { ThoughtEffect } from "~/audio/thoughtEffect";
import type { Db, Tx } from "~/db/client";
import { effectContext } from "~/db/effects";
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
import { checkAfterNarration } from "~/jobs/check";
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
  bookDelivery,
  lineReading,
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
import type {
  BatchLimits,
  BatchOutcome,
  RenderedClip,
  SpeechInput,
  SpeechProvider,
} from "~/providers/speech";
import { speechTarget } from "~/providers/target";
import { assertWithinBudget, budgetProblem, type EndpointRequest } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";

/** Queue-page label back to its scope; `SCOPE_LABEL` is one-to-one. */
const SCOPE_OF_LABEL = new Map<string, RunScope>(
  (Object.entries(SCOPE_LABEL) as [NarrationScope, string][]).map(([scope, label]) => [
    label,
    scope,
  ]),
);
SCOPE_OF_LABEL.set(RETAKE_LABEL, "pending");

/** The scope a job was queued at. Falls back to its label (older rows), then `all`. */
export const scopeOf = (job: Job): RunScope =>
  job.narrationRun?.scope ?? SCOPE_OF_LABEL.get(job.bulk?.scope ?? "") ?? "all";
const labelOf = (scope: RunScope): string =>
  scope === "pending" ? RETAKE_LABEL : SCOPE_LABEL[scope];

export interface SoundPorts {
  /** Pedalboard, where this machine has it */
  effects?: EffectRunner;
  /** ffmpeg stand-in for thought lines where Pedalboard is missing */
  thoughtEffect?: ThoughtEffect;
}

interface LineSound {
  sound: string;
  apply: ThoughtEffect;
}

/**
 * Each line's sound, from effects read at run start (a mid-run change applies next run). Null for
 * a line no effect touches. Without Pedalboard, thought lines get the ffmpeg stand-in (sound
 * `"ffmpeg"`, so a later Re-apply upgrades it); other effects are left off, warned once per run.
 */
function lineSounds(
  ctx: JobContext,
  fx: EffectContext,
  { effects, thoughtEffect }: SoundPorts,
): (s: Segment) => Promise<LineSound | null> {
  // asked at the first line that needs it, so a run with no effects never waits on uv
  let pedalboard: Promise<boolean> | undefined;
  let toldSkipped = false;
  return async (s) => {
    const chains = chainsFor(s, fx);
    const sound = soundOf(chains);
    if (!sound) return null;
    if (effects && (await (pedalboard ??= effects.available()))) {
      const steps = chains.map((e) => runnable(e.chain));
      return {
        sound,
        apply: (bytes, format, signal) => effects.render(bytes, format, steps, signal),
      };
    }
    const thought = s.type === "thought" ? thoughtEffectOf(s.speaker, fx) : null;
    // chainsFor puts the thought effect last, after the speaker's own and the line's
    if (!toldSkipped && soundOf(thought ? chains.slice(0, -1) : chains)) {
      toldSkipped = true;
      ctx.note(
        "Voice effects cannot run here (Pedalboard needs uv), so speakers' own and line effects were left off; Re-apply once they can",
        "warning",
        { line: s.id, speaker: s.speaker },
      );
    }
    return thought && thoughtEffect && soundOf([thought])
      ? { sound: "ffmpeg", apply: thoughtEffect }
      : null;
  };
}

function readChapter(db: Db, bookId: string, chapterId: number) {
  const chapter = library.getChapter(db, bookId, chapterId);
  const uid = library.chapterUid(db, bookId, chapterId);
  if (!chapter || uid == null) throw notFound("The chapter no longer exists");
  return { uid, title: chapter.title };
}

/**
 * Put back in-flight lines: an in-place render goes back to no clip, an unlanded replacement is
 * dropped. Returns the count; the caller moves the revision.
 */
function putBack(tx: Tx, bookId: string, chapterId: number, segs: readonly Segment[]): number {
  let n = 0;
  for (const s of segs) {
    if (inFlight(s.audio.status)) {
      writeClip(tx, bookId, chapterId, s.id, "current", { ...requeue(s.audio), status: "none" });
      n++;
    }
    if (s.candidate && inFlight(s.candidate.status)) {
      dropCandidate(tx, bookId, chapterId, s.id);
      n++;
    }
  }
  return n;
}

interface Target {
  s: Segment;
  slot: Slot;
  queued: SegmentAudio;
}

/** Queue one line. A waiting retake that rendered joins the take list as rejected (stays playable). */
function queueRender(tx: Tx, at: { bookId: string; id: number }, s: Segment): Target {
  let audio = s.audio;
  if (s.candidate) {
    const take = rejectCandidate(tx, at.bookId, at.id, s.id);
    if (take) audio = { ...audio, takes: [...(audio.takes ?? []), take] };
  }
  return { s, ...queuedSlot(audio, { auto: true }) };
}

/**
 * Queue every target line in one transaction, before the first request. An in-flight clip can only
 * be this job's own from before a restart (one narration job per chapter), so it is picked up —
 * unless the line is no longer spoken, in which case it is put back.
 */
function planRun(db: Db, uid: string, scope: RunScope): { targets: Target[]; lines: number } {
  const targets: Target[] = [];
  let lines = 0;
  db.transaction((tx) => {
    const at = library.locateChapter(tx, uid);
    if (!at) throw notFound("The chapter was removed before it was narrated");
    const book = library.getBook(tx, at.bookId);
    let segs = readScript(tx, at.bookId, at.id);
    const cleared = putBack(
      tx,
      at.bookId,
      at.id,
      segs.filter((s) => !isSpoken(s, book)),
    );
    if (cleared) segs = readScript(tx, at.bookId, at.id);
    // progress counts spoken lines only
    lines = segs.filter((s) => isSpoken(s, book)).length;
    const wanted = new Set(
      scope === "pending" ? [] : narrationTargets(segs, scope, true, book).run.map((s) => s.id),
    );
    for (const s of segs) {
      if (!isSpoken(s, book)) continue;
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
      library.setChapterNarration(tx, at.bookId, at.id, chapterNarration(segs, book), 100);
      if (cleared) bumpRevision(tx, at.bookId, at.id);
      return;
    }
    library.setChapterNarration(tx, at.bookId, at.id, "running", 0);
    bumpRevision(tx, at.bookId, at.id);
  });
  return { targets, lines };
}

/** A line on its way out. Its reading is taken at send time, not run start (`@/lib/reading`). */
interface Line extends BatchLine<Target> {
  who: Delivery;
  reading: Reading;
  generating: SegmentAudio;
  startedAt: number;
  /** hands back whatever of the line's reservation its requests did not use */
  release: () => void;
}

interface Priced {
  who: Delivery;
  reading: Reading;
  worst: number;
}

interface Tally {
  rendered: number;
  waiting: number;
  failed: number;
}

/**
 * Every step a line goes through, alone or batched: gate slot (`acquire`), budget + reservation +
 * audit trail (`admit`), request (`speak`/`speakBatch`), write-back (`land`). Batches borrow it via
 * `LineRun`; `close` releases what is still held.
 */
function lineRun(o: {
  ctx: JobContext;
  provider: SpeechProvider;
  files: AudioFiles;
  gate: SpeechGate;
  chapter: { uid: string };
  deliveryOf: (speaker: string) => Delivery;
  soundFor: (s: Segment) => Promise<LineSound | null>;
  targets: readonly Target[];
  lines: number;
  stop: AbortSignal;
}): LineRun<Target, Line> & {
  renderLine(t: Target): Promise<void>;
  /** why the budget stopped the run, or null */
  refused(): string | null;
  /** give back what the lines still out hold: the run is over */
  close(): void;
  tally: Tally;
} {
  const { ctx, provider, files, gate, chapter, deliveryOf, soundFor, targets, lines, stop } = o;
  const { job, db } = ctx;

  /** Write against the chapter by uid, moving the revision. */
  const write = (fn: (tx: Tx, at: { bookId: string; id: number }) => void): void =>
    db.transaction((tx) => {
      const at = library.locateChapter(tx, chapter.uid);
      if (!at) throw notFound("The chapter was removed while it was being narrated");
      fn(tx, at);
      bumpRevision(tx, at.bookId, at.id);
    });

  // Counted over the whole chapter, so re-rendering 3 of 300 lines does not start at 0%.
  let landed = 0;
  const progress = (): void => {
    const pct = Math.round(((lines - (targets.length - landed)) / lines) * 100);
    ctx.progress(pct);
    const at = library.locateChapter(db, chapter.uid);
    if (at) library.setChapterNarration(db, at.bookId, at.id, "running", pct);
  };

  // A failed retake is the person's to discard, so it does not count as a failure.
  const tally: Tally = { rendered: 0, waiting: 0, failed: 0 };
  // Held against the book's cap: the queued worst case, less each line's as it settles.
  let held = job.narrationRun?.reserved ?? 0;
  let refused: string | null = null;

  /** read on every acquire, so limit changes apply live */
  const limitsOf = (id: string | null) => (): GateLimits | undefined => {
    const ep = id ? readEndpoint(db, id) : undefined;
    return ep && { concurrency: ep.concurrency, enabled: ep.enabled };
  };
  // Log pauses and rate limits once per endpoint until a line gets through; not concurrency waits.
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

  const halted = (): boolean => stop.aborted || refused != null;

  /** Priced once per line, shared by `budgetStops` and the `commit` right after it. */
  const pricing = new Map<Target, Priced>();
  const priceOf = (t: Target): Priced => {
    let p = pricing.get(t);
    if (!p) {
      const who = deliveryOf(t.s.speaker);
      const reading = lineReading(db, job.bookId, t.s, who);
      pricing.set(t, (p = { who, reading, worst: lineWorstCase(reading, Date.now()) }));
    }
    return p;
  };
  const out = new Set<() => void>();

  /**
   * Budget check before each line: a run that fit when queued still stops here if the cap was
   * lowered, the book paused, or lines cost more than held. Unsent lines are put back in `onSettled`.
   */
  const budgetStops = (t: Target): boolean => {
    const { reading, worst } = priceOf(t);
    const ep = reading.reader.endpoint;
    const problem = budgetProblem(db, job.bookId, {
      kind: "narration",
      cost: held,
      jobId: job.id,
      what: "the next line",
      requests: ep ? [{ endpoint: ep.id, cost: worst }] : [],
    });
    if (!problem) return false;
    refused = problem;
    const note = `Stopped before line ${t.s.id}: the budget does not cover it`;
    ctx.note(note, "warning", { line: t.s.id, why: problem });
    return true;
  };

  const gone = (s: Segment, release: () => void): void => {
    const note = `Line ${s.id} was removed while it rendered; the clip was dropped`;
    ctx.note(note, "warning", { line: s.id });
    landed++;
    release();
  };

  /**
   * Reserve, report and write the audit trail. `maxChars` overrides the cut when a batch's item limit
   * is shorter than the endpoint's. Null when the line was removed.
   */
  const commit = (t: Target, maxChars?: number | null): Line | null => {
    const { s, slot } = t;
    const { who, reading, worst } = priceOf(t);
    const { plan, instructions } = reading;
    const ep = reading.reader.endpoint;
    pricing.delete(t);
    // Accounting rules live in `~/usage/dispatch`; each part or batch item is its own request.
    const money =
      ep &&
      dispatch(db, {
        kind: "tts",
        endpoint: ep,
        work: {
          bookId: job.bookId,
          chapterUid: chapter.uid,
          label: `${slot === "candidate" ? (t.queued.auto ? "Replacement" : "Retake") : "Line"} ${s.id} · ${s.speaker}`,
          queuedAt: job.queuedAt,
          ...(who.voiceRef ? { voiceRef: who.voiceRef } : {}),
        },
        hold: worst,
        gaveBack: (back) => {
          held = Math.max(0, held - back);
          setReserved(db, job.id, held);
        },
      });
    if (money) out.add(money.release);
    // Cut before sending so the clip records it. No cuts means unsendable (see `unsendable`).
    const cuts = maxChars ? cutReading(plan, ep, maxChars) : reading.cuts;
    const startedAt = Date.now();
    // The audit trail: what this clip is rendered with, so later edits read as drift.
    const generating: SegmentAudio = {
      ...t.queued,
      status: "generating",
      endpoint: who.endpoint,
      startedAt,
      at: startedAt,
      ...(who.voiceRef ? { voiceRef: who.voiceRef } : {}),
      ...(who.voice ? { voice: who.voice } : {}),
      model: provider.name,
      ...readingRecord(s, reading),
      // Always set, never carried over: the replaced clip's endpoint may have had another limit.
      parts: cuts?.length,
      splitAt: cuts ? ep!.splitAt : undefined,
      cuts:
        cuts && cuts.length > 1
          ? cuts.map((c) => ({ from: c.from, to: c.to, at: c.at, fallback: c.fallback }))
          : undefined,
    };
    const release = (): void => money?.release();
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
      reading,
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
        target: ep ? speechTarget(db, ep) : null,
        signal: stop,
        ...(money ? { sent: money.sent } : {}),
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
   * Why a line cannot be sent, or null: a tag the endpoint can't say, a tag longer than a batch item
   * (tags are never cut), or Opus in parts (`speakInParts`). Fails that line; the run goes on.
   */
  const unsendable = (line: Line): Error | null => {
    const { plan, reader } = line.reading;
    if (plan.issues.length)
      return new Error(`Expression needs attention: ${plan.issues[0].reason}`);
    if (reader.endpoint && !line.cuts) {
      const tag = plan.tags.reduce((a, b) => (b.length > a.length ? b : a), "");
      return new Error(
        `The tag ${tag} is longer than one item of this endpoint's batches may be, and a tag is never cut; shorten the tag or switch this endpoint's batches off`,
      );
    }
    return joinedParts(line.cuts) && line.input.encoding.format === "opus"
      ? opusInParts(line.cuts!.length)
      : null;
  };

  /** Budget check then commit. Null when halted, removed, or unsendable (landed as failed). */
  const admit = async (t: Target, maxChars?: number | null): Promise<Line | null> => {
    if (halted() || budgetStops(t)) return null;
    const line = commit(t, maxChars);
    if (!line) return null;
    const blocked = unsendable(line);
    if (!blocked) return line;
    await land(line, { error: blocked });
    return null;
  };

  const speak = async (line: Line): Promise<Outcome> => {
    try {
      const rendered = await speakInParts(provider, line.input, line.cuts);
      if (stop.aborted) throw stop.reason;
      return { rendered };
    } catch (e) {
      if (stop.aborted) throw e;
      return { error: e };
    }
  };

  const speakBatch = (
    id: string,
    items: SpeechInput[],
    answered: (index: number, outcome: BatchOutcome) => void,
  ): Promise<void> =>
    provider.speakBatch!({
      target: items[0].target!,
      items,
      signal: stop,
      answered,
      rateLimited: (ms) => gate.rateLimited(id, ms),
    });

  /** The line's audio through its effects, as WAV. Null (logged) on failure: keep the raw clip. */
  const withEffect = async (
    s: Segment,
    rendered: RenderedClip,
    fx: LineSound,
  ): Promise<{ bytes: Uint8Array; duration: number; sound: string } | null> => {
    try {
      const bytes = await fx.apply(rendered.bytes, rendered.format, stop);
      // reverb rings past the last word, so re-read the length
      const { duration } = await probeClip(bytes, "wav");
      return { bytes, duration, sound: fx.sound };
    } catch (e) {
      if (stop.aborted) throw e;
      const why = e instanceof Error ? e.message : String(e);
      ctx.note(`Line ${s.id}: its voice effects were not applied: ${why}`, "warning", {
        line: s.id,
        error: why,
      });
      return null;
    }
  };

  const land = async (line: Line, outcome: Outcome): Promise<void> => {
    const { t, who, generating, startedAt, release } = line;
    const { s, slot } = t;
    let clip: SegmentAudio;
    try {
      if ("error" in outcome) throw outcome.error;
      const { rendered } = outcome;
      // read the rate off the file: unreadable audio fails the line now, not the export later
      let sampleRate: number;
      try {
        ({ sampleRate } = await probeClip(rendered.bytes, rendered.format));
      } catch (e) {
        const why = (e as Error).message;
        throw new Error(`The audio that came back could not be read: ${why}`, { cause: e });
      }
      // Files live under the book (chapter numbers change). With effects, the voice's file is kept
      // as `raw` so Re-apply needs no new request.
      const fx = await soundFor(s);
      const voice = await files.write(job.bookId, rendered.bytes, rendered.format);
      const processed = fx ? await withEffect(s, rendered, fx) : null;
      const kept = processed && {
        ...processed,
        url: (await files.write(job.bookId, processed.bytes, "wav")).url,
      };
      clip = {
        ...generating,
        status: "done",
        ms: rendered.ms,
        duration: kept?.duration ?? rendered.duration,
        url: kept?.url ?? voice.url,
        at: Date.now(),
        model: rendered.model,
        ...(rendered.voice != null ? { voice: rendered.voice } : {}),
        sampleRate,
        ...(kept ? { sound: kept.sound, raw: voice.url } : {}),
      };
    } catch (e) {
      if (stop.aborted) throw e;
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

    // An `auto` replacement takes over as it lands; a retake waits for a verdict.
    const replacement = slot === "candidate" && !!clip.auto;
    const retake = slot === "candidate" && !clip.auto;
    try {
      write((tx, at) => {
        // A dictionary or endpoint change while the line was out only marked landed clips stale,
        // so check this one here, in the write's transaction.
        if (
          clip.status === "done" &&
          compareReading(clip, s, lineReading(tx, at.bookId, s, who)).length
        )
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

  /** The gate slot is released once the answer is in, before effects and writes. */
  const renderLine = async (t: Target): Promise<void> => {
    const answered = await sendLine(t);
    if (answered) await land(...answered);
  };
  const sendLine = async (t: Target): Promise<[Line, Outcome] | null> => {
    const leave = await acquire(deliveryOf(t.s.speaker).endpoint);
    try {
      const line = await admit(t);
      return line && [line, await speak(line)];
    } finally {
      leave();
    }
  };

  return {
    stop,
    acquire,
    halted,
    admit,
    speak,
    speakBatch,
    land,
    renderLine,
    refused: () => refused,
    close: () => {
      for (const release of out) release();
      out.clear();
    },
    tally,
  };
}

export function narrationHandler(
  provider: SpeechProvider,
  files: AudioFiles,
  gate: SpeechGate = createSpeechGate(),
  sound: SoundPorts = {},
): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      if (job.chapterId == null) throw new Error("A narration job is for one chapter");
      const chapter = readChapter(db, job.bookId, job.chapterId);
      const scope = scopeOf(job);

      // The cast is read once; a rename mid-run marks the clips it moved stale itself.
      const deliveryOf = bookDelivery(db, job.bookId);
      const soundFor = lineSounds(ctx, effectContext(db, job.bookId), sound);

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

      // Lines go out through the speech gate (`~/providers/gate`) and land in any order.
      // A budget stop lets in-flight lines land, then fails the job. Any other error beyond one line
      // (e.g. the chapter removed) or a cancel aborts everything; `onSettled` puts back the rest.
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
        soundFor,
        targets,
        lines,
        stop: stop.signal,
      });

      // Ask each endpoint once whether it batches; no answer or batches off: one line at a time.
      const groups = new Map<string, Target[]>();
      const alone: Target[] = [];
      for (const t of targets) {
        const id = deliveryOf(t.s.speaker).endpoint;
        const ep = id ? readEndpoint(db, id) : undefined;
        if (!id || !ep || ep.batch === false || !provider.batchLimits || !provider.speakBatch)
          alone.push(t);
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
            // the first error wins; later ones are just the stop
            if (stop.signal.aborted) return;
            fatal = { error: e };
            stop.abort(e);
          }),
        ),
      );
      run.close();
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) throw signal.reason;
      if (fatal) throw (fatal as { error: unknown }).error;
      const refused = run.refused();
      if (refused != null) throw new Error(refused);

      // What is still held is the per-line vs whole-run pricing gap; `finishJob` releases it.
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
      if (status !== "done") putBackAfter(ctx);
      // no auto-check after a cancel: the person stopped the work
      if (status !== "cancelled") checkAfterNarration(ctx);
    },
  };
}

/**
 * Put back what an unfinished run held (`putBack`). Uses the job row's chapter number, which follows
 * renumbering by cascade, not the one the job started with.
 */
function putBackAfter(ctx: JobContext): void {
  const fresh = getJob(ctx.db, ctx.job.id);
  if (!fresh || fresh.chapterId == null) return;
  const { bookId, chapterId } = fresh;
  ctx.db.transaction((tx) => {
    if (!library.chapterExists(tx, bookId, chapterId)) return;
    const back = putBack(tx, bookId, chapterId, readScript(tx, bookId, chapterId));
    const segs = readScript(tx, bookId, chapterId);
    // interrupted: progress back to 0; ran to the end but failed a line: keep 100
    library.setChapterNarration(
      tx,
      bookId,
      chapterId,
      chapterNarration(segs, library.getBook(tx, bookId)),
      back ? 0 : undefined,
    );
    if (back) bumpRevision(tx, bookId, chapterId);
  });
}

/**
 * Queue one narration job per chapter as one run. Chapters with nothing to do are skipped, not
 * refused. The whole run is priced at worst case first: if it doesn't fit the book's budget,
 * nothing is queued (409). An endpoint's daily limit refuses only if it can't cover its first line.
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
    const { run } = narrationTargets(segs, scope, true, book);
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
  // each endpoint's first line, in the order the chapters were asked for
  const firsts = new Map<string, EndpointRequest>();
  for (const t of targets)
    for (const f of t.cost.firsts) if (!firsts.has(f.endpoint)) firsts.set(f.endpoint, f);
  if (targets.length)
    assertWithinBudget(db, bookId, {
      kind: "narration",
      cost: targets.reduce((n, t) => n + t.cost.reserved, 0),
      requests: [...firsts.values()],
      request: "the first line",
    });

  const runId = nextRunId(db);
  const jobs: Job[] = [];
  targets.forEach(({ id, clips, replacing, cost }, i) => {
    const { job } = runner.enqueue({
      kind: "narration",
      bookId,
      chapterId: id,
      label: replacing ? "Re-narrate" : "Narrate",
      bulk: {
        id: runId,
        op: replacing ? "Re-narrate" : "Narrate",
        index: i + 1,
        total: targets.length,
        scope: SCOPE_LABEL[scope],
      },
      run: { narrationRun: narrationRunOf(cost, clips, scope) },
      // same transaction as the row, so it can't land after the worker moved on
      onCreated: (tx) => library.setChapterNarration(tx, bookId, id, "queued", 0),
    });
    jobs.push(job);
  });
  return { jobs, skipped, runId, chapters: library.listChapters(db, bookId) };
}
