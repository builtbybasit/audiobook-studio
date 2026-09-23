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
// Which slot a line renders into is the store's rule, kept exactly. A line with no usable clip
// renders in place. A line that already has one renders a **candidate** beside it, marked `auto`,
// so the chapter keeps playing the old clip until the new one lands; a replacement that lands
// takes over and pushes the old clip into the take list, and one that fails leaves the old clip
// exactly as it was. A cancelled run keeps what it finished and puts back what it did not start.
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
import { and, eq } from "drizzle-orm";

import type { Job, NarrationScope, NarrationStatus, Segment, SegmentAudio } from "@/types";
import { NARRATOR } from "@/lib/cast";
import { chapterNarration, narrationTargets, SCOPE_LABEL } from "@/lib/runPlan";
import { pacingOrDefault, silenceOf, speak, speechInstructions } from "@/lib/speech";
import { nextTakeNumber, requeue } from "@/lib/takes";
import type { AudioFiles } from "~/audio/files";
import { readCast, readLexicon } from "~/db/cast";
import type { Db, Tx } from "~/db/client";
import { activeJob, getJob, nextRunId } from "~/db/jobs";
import * as library from "~/db/library";
import { chapters } from "~/db/schema";
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
import { locate } from "~/jobs/scripting";
import { conflict, notFound } from "~/lib/errors";
import type { SpeechProvider } from "~/providers/speech";

/** The label a retake job carries as its scope and its `bulk.op`; the Queue page shows it as it is. */
export const RETAKE_LABEL = "Retake";

/**
 * What a run renders: one of the store's scopes, or `pending` — nothing new, only the clips
 * already queued or generating when the run starts. A retake queues its lines when its job is
 * created, so its job runs at `pending` and the handler's in-flight rule does the rest.
 */
export type RunScope = NarrationScope | "pending";

/**
 * The scope a job was queued at, read back off its row.
 *
 * The row keeps the scope as the label the Queue page shows (`bulk.scope` is text to the
 * frontend), and `SCOPE_LABEL` is one-to-one, so the label is enough to find the way back. A row
 * with no label — none should exist — is read as `all`, the scope that leaves nothing out.
 */
const SCOPE_OF_LABEL = new Map<string, RunScope>(
  (Object.entries(SCOPE_LABEL) as [NarrationScope, string][]).map(([scope, label]) => [
    label,
    scope,
  ]),
);
SCOPE_OF_LABEL.set(RETAKE_LABEL, "pending");
export const scopeOf = (label: string | undefined): RunScope =>
  SCOPE_OF_LABEL.get(label ?? "") ?? "all";
const labelOf = (scope: RunScope): string =>
  scope === "pending" ? RETAKE_LABEL : SCOPE_LABEL[scope];

export const inFlight = (status: SegmentAudio["status"]): boolean =>
  status === "queued" || status === "generating";

export function setChapterNarration(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  narration: NarrationStatus,
  progress?: number,
  duration?: number,
): void {
  db.update(chapters)
    .set({
      narration,
      ...(progress != null ? { narrationProgress: progress } : {}),
      ...(duration != null ? { duration } : {}),
    })
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .run();
}

/**
 * Settle a chapter's status and its length from the clips as they now stand, and say what they
 * came to. The status is `chapterNarration`, the same reading the demo makes. The silence between
 * clips is the book's pacing, stitched rather than rendered, and is part of how long the chapter
 * plays even though no provider produced it. A run's last write and a verdict on a retake both
 * end here, so a chapter never has two ways of adding itself up.
 */
export function settleChapter(
  tx: Tx,
  bookId: string,
  chapterId: number,
): { narration: NarrationStatus; seconds: number } {
  const segs = readScript(tx, bookId, chapterId);
  const pacing = pacingOrDefault(library.getBook(tx, bookId)?.pacing);
  const seconds = segs.reduce((n, s) => n + s.audio.duration, 0) + silenceOf(segs, pacing);
  const narration = chapterNarration(segs);
  setChapterNarration(tx, bookId, chapterId, narration, 100, seconds);
  return { narration, seconds };
}

/** The chapter as the job needs it: where it is, and the identity to find it by again. */
function readChapter(db: Db, bookId: string, chapterId: number) {
  const row = db
    .select({ uid: chapters.uid, title: chapters.title })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!row) throw notFound("The chapter no longer exists");
  return row;
}

/** Which clip of its line a render is going to, and the queued clip that holds the slot meanwhile. */
type Slot = "current" | "candidate";
interface Target {
  s: Segment;
  slot: Slot;
  queued: SegmentAudio;
}

/**
 * Put one line in the queue, the store's `_queueRender` on rows.
 *
 * A retake already waiting is not thrown away: if it rendered it joins the take list marked
 * rejected, so the comparison the listener was in the middle of is still playable afterwards. A
 * line that has a clip with audio gets a replacement beside it; one that has none renders in place.
 */
function queueRender(tx: Tx, at: { bookId: string; id: number }, s: Segment): Target {
  let audio = s.audio;
  if (s.candidate) {
    const take = rejectCandidate(tx, at.bookId, at.id, s.id);
    if (take) audio = { ...audio, takes: [...(audio.takes ?? []), take] };
  }
  if (audio.duration > 0)
    return {
      s,
      slot: "candidate",
      queued: {
        status: "queued",
        endpoint: null,
        ms: 0,
        duration: 0,
        n: nextTakeNumber(audio),
        auto: true,
      },
    };
  return { s, slot: "current", queued: requeue(audio) };
}

/** Everything a clip records about how it was asked for, so drift can compare the line to it later. */
interface Delivery {
  voiceRef: string | null;
  voice: string | null;
  endpoint: string | null;
  style: string;
}

export function narrationHandler(provider: SpeechProvider, files: AudioFiles): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      if (job.chapterId == null) throw new Error("A narration job is for one chapter");
      const chapter = readChapter(db, job.bookId, job.chapterId);
      const scope = scopeOf(job.bulk?.scope);

      // A speaker's voice is their own or the Narrator's, and their style is their own: the cast
      // store's `effectiveVoice`, read once, because the cast is the book's and a rename mid-run
      // is the rename's problem — it marks the clips it moved stale.
      const cast = readCast(db, job.bookId);
      const narratorVoice = cast.find((c) => c.name === NARRATOR)?.voice ?? null;
      const deliveryOf = (speaker: string): Delivery => {
        const who = cast.find((c) => c.name === speaker);
        const voiceRef = who?.voice || narratorVoice;
        const slash = voiceRef?.indexOf("/") ?? -1;
        return {
          voiceRef,
          voice: voiceRef ? voiceRef.slice(slash + 1) : null,
          endpoint: voiceRef && slash > 0 ? voiceRef.slice(0, slash) : null,
          style: who?.style ?? "",
        };
      };

      // The plan, written in one transaction: every line this run renders holds its slot with a
      // queued clip before the first request goes out, so the chapter reads as a run in progress
      // from the first moment. A line found already queued or generating is this job's own: the
      // queue allows one narration job per chapter, so an in-flight clip can only be what the last
      // attempt was holding when the server stopped, and it is picked up rather than skipped.
      const targets: Target[] = [];
      let lines = 0;
      let replacing = 0;
      db.transaction((tx) => {
        const at = locate(tx, chapter.uid);
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
          if (t.slot === "candidate") replacing++;
          targets.push(t);
        }
        if (!targets.length) {
          setChapterNarration(tx, at.bookId, at.id, chapterNarration(segs), 100);
          return;
        }
        setChapterNarration(tx, at.bookId, at.id, "running", 0);
        bumpRevision(tx, at.bookId, at.id);
      });
      if (!targets.length) {
        ctx.note("Nothing to narrate", "info", { scope: labelOf(scope) });
        return;
      }
      ctx.note("Narration started", "info", {
        provider: provider.name,
        lines: targets.length,
        replacing,
        scope: labelOf(scope),
      });

      /** One write against the chapter wherever it is now, moving the revision with it. */
      const write = (fn: (tx: Tx, at: { bookId: string; id: number }) => void): void =>
        db.transaction((tx) => {
          const at = locate(tx, chapter.uid);
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
        const at = locate(db, chapter.uid);
        if (at) setChapterNarration(db, at.bookId, at.id, "running", pct);
      };

      // What counts as the run failing is the demo's rule: a line rendered in place that has no
      // clip, and a replacement the run itself chose to make. A retake a person asked for is theirs
      // to judge, so one that fails is a failed candidate for them to discard, not a failed job.
      let rendered = 0;
      let waiting = 0;
      let failed = 0;
      for (const t of targets) {
        if (signal.aborted) throw signal.reason;
        const { s, slot } = t;
        const who = deliveryOf(s.speaker);
        const instructions = speechInstructions({ style: who.style, direction: s.direction });
        // The dictionary as it stands when this line goes out, not when the run began: a term
        // added mid-run applies to every line not yet sent, as it does in the demo.
        const spoken = speak(s.text, readLexicon(db, job.bookId));
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
          pronounced: spoken.text,
          ...(spoken.text !== s.text ? { said: spoken.text, lex: spoken.hits.length } : {}),
        };
        const gone = (): void => {
          ctx.note(`Line ${s.id} was removed while it rendered; the clip was dropped`, "warning", {
            line: s.id,
          });
          landed++;
        };
        try {
          write((tx, at) => writeClip(tx, at.bookId, at.id, s.id, slot, generating));
        } catch (e) {
          if (!(e instanceof LineGone)) throw e;
          gone();
          continue;
        }

        let clip: SegmentAudio;
        try {
          const rendered = await provider.speak({
            text: spoken.text,
            speaker: s.speaker,
            type: s.type,
            direction: s.direction,
            voiceRef: who.voiceRef,
            signal,
          });
          if (signal.aborted) throw signal.reason;
          // by the book, which is where the file stays whatever the chapter's number becomes
          const { url } = await files.write(job.bookId, rendered.bytes, "wav");
          clip = {
            ...generating,
            status: "done",
            ms: rendered.ms,
            duration: rendered.duration,
            url,
            at: Date.now(),
            model: rendered.model,
            ...(rendered.voice != null ? { voice: rendered.voice } : {}),
          };
        } catch (e) {
          if (signal.aborted) throw e;
          // A line that could not be rendered is a failed clip where the run put it — a failed
          // replacement stays a candidate beside the clip it did not replace, and a failed render
          // in place is the gap the chapter's status will say it has.
          const message = e instanceof Error ? e.message : String(e);
          clip = {
            ...generating,
            status: "failed",
            ms: Date.now() - startedAt,
            duration: 0,
            at: Date.now(),
            error: { code: 0, message, body: "", at: Date.now() },
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
            // write — the words it was sent may no longer be the words the book would send.
            if (
              clip.status === "done" &&
              speak(s.text, readLexicon(tx, at.bookId)).text !== spoken.text
            )
              clip = { ...clip, status: "stale" };
            writeClip(tx, at.bookId, at.id, s.id, slot, clip);
            if (replacement && clip.status !== "failed")
              acceptCandidate(tx, at.bookId, at.id, s.id);
          });
        } catch (e) {
          if (!(e instanceof LineGone)) throw e;
          gone();
          continue;
        }
        landed++;
        const detail = { line: s.id, speaker: s.speaker };
        if (clip.status === "stale")
          ctx.note(
            `Line ${s.id} was sent before the dictionary changed; it reads as stale`,
            "warning",
            detail,
          );
        if (clip.status !== "failed") {
          const arrived = {
            ...detail,
            seconds: Number(clip.duration.toFixed(2)),
            ms: clip.ms,
            ...(slot === "candidate" ? { take: clip.n ?? 1 } : {}),
          };
          if (retake) {
            waiting++;
            ctx.note(
              `Line ${s.id} take ${clip.n ?? 1} rendered, waiting for a verdict`,
              "info",
              arrived,
            );
          } else {
            rendered++;
            ctx.note(
              replacement
                ? `Line ${s.id} replaced take ${s.audio.n ?? 1}`
                : `Line ${s.id} rendered`,
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
            failed++;
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
      }

      let seconds = 0;
      db.transaction((tx) => {
        const at = locate(tx, chapter.uid);
        if (!at) throw notFound("The chapter was removed while it was being narrated");
        seconds = settleChapter(tx, at.bookId, at.id).seconds;
      });
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
        const exists = tx
          .select({ id: chapters.id })
          .from(chapters)
          .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
          .get();
        if (!exists) return;
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
        setChapterNarration(tx, bookId, chapterId, chapterNarration(segs), putBack ? 0 : undefined);
        if (putBack) bumpRevision(tx, bookId, chapterId);
      });
    },
  };
}

export interface NarrationQueued {
  jobs: Job[];
  /** chapters left out of this run, and why */
  skipped: { id: number; why: "excluded" | "busy" | "missing" | "unscripted" | "nothing" }[];
  runId: number;
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

  const targets: { id: number; clips: number; replacing: boolean }[] = [];
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
    });
  }

  const runId = nextRunId(db);
  const jobs: Job[] = [];
  targets.forEach(({ id, clips, replacing }, i) => {
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
      // the fake costs nothing to reserve; a real provider's price is the server's to meter
      run: { narrationRun: { reserved: 0, clips } },
      // in the same transaction as the row, so it cannot land after the worker has moved on
      onCreated: (tx) => setChapterNarration(tx, bookId, id, "queued", 0),
    });
    jobs.push(job);
  });
  return { jobs, skipped, runId };
}
