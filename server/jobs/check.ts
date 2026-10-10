// The check by ear: a chapter's clips heard back by a transcription endpoint, and each set against
// its line, so a clip that says something other than the line is found without anyone listening.
//
// What is heard is every spoken line's clip in the book (`current`, `done`) that has not been
// heard as the line now reads. A finding is kept by the clip's **file**, the one name a render keeps
// for life (`heard` in the schema), with the line's text as it was checked: a line edited since, or
// rendered again, has no finding that matches it and is heard at the next check; one that has is
// left alone. Nothing a check does touches a clip.
//
// A line is set against what was heard both as written and as its clip was sent through the
// pronunciation dictionary (`sentHits`), and the closer stands. A clip heard saying something else
// (`alignHeard`) flags its line `heard`, with what was heard in
// the note; one heard right takes a `heard` flag down. A flag a person set is theirs: a check never
// replaces it and never takes it down. A flag is part of the script a client writes back whole, so
// a write that changes one moves the chapter's revision, as a landed clip does in narration, and
// finds the chapter by its uid because a removed volume renumbers the book mid-run.
//
// The run goes to the transcription endpoint it was queued with (`checkRun.endpoint`), up to its
// concurrency at once, each request priced into the ledger by the minute of audio as it settles
// and held to the endpoint's daily limit while it is out. A request that fails is counted and the
// run goes on; the job fails at the end, as a narration with a failed line does, so a retry hears
// only what was missed. A book that switches it on (`Book.checkByEar`) has each chapter checked
// once a narration of it ends (`checkAfterNarration`).
import type {
  Book,
  ChapterHeard,
  CheckQueued,
  HeardLine,
  Job,
  LexEntry,
  Segment,
  SegmentFlag,
  Transcriber,
} from "@/types";
import { nameWords, namesIn } from "@/lib/cast";
import { AUDIO_MIME } from "@/lib/endpointShapes";
import { alignHeard } from "@/lib/heard";
import { isSpoken } from "@/lib/siteText";
import { speak, type LexHit } from "@/lib/speech";
import { formatOfFile, type AudioFiles } from "~/audio/files";
import { readLexicon, readSpeakers } from "~/db/cast";
import type { Db } from "~/db/client";
import { readTranscriber } from "~/db/endpoints";
import { activeJob, enqueueJob, getJob, nextRunId, setCheckRun } from "~/db/jobs";
import * as library from "~/db/library";
import {
  bumpRevision,
  lineNow,
  readHeard,
  readScript,
  scriptRevision,
  setFlag,
  writeHeard,
} from "~/db/script";
import type { JobContext, JobHandler, Runner } from "~/jobs/runner";
import { badRequest, conflict, notFound } from "~/lib/errors";
import { transcriberTarget } from "~/providers/target";
import type { TranscriptionProvider } from "~/providers/transcription";
import { assertWithinBudget, budgetProblem } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";

/** How much of what was heard a flag's note quotes. */
const NOTE_CHARS = 140;

const NO_TRANSCRIBER = "No transcription endpoint is switched on. Add one on the Endpoints page.";

/** A clip's file name, which is how its url ends (`audio/files.ts`). */
const fileOf = (url: string): string => url.slice(url.lastIndexOf("/") + 1);

/** A line whose clip is in the book, and the file that clip is. */
interface Clip {
  s: Segment;
  file: string;
}

/** The chapter's spoken lines that play a clip, each with its clip's file. */
const clipsOf = (segs: readonly Segment[], book: Pick<Book, "readNotes"> | undefined): Clip[] =>
  segs
    .filter(
      (s) => isSpoken(s, book) && s.audio.status === "done" && s.audio.url && s.audio.duration > 0,
    )
    .map((s) => ({ s, file: fileOf(s.audio.url!) }));

/** Those of `clips` not yet heard as their line now reads. */
function unheard(db: Db, bookId: string, clips: readonly Clip[]): Clip[] {
  const found = readHeard(
    db,
    bookId,
    clips.map((c) => c.file),
  );
  return clips.filter((c) => found.get(c.file)?.text !== c.s.text);
}

/**
 * The dictionary's substitutions in the line as its clip was sent — the dictionary as it stands,
 * when it still makes what the clip records it was sent (`pronounced`), else none: a clip sent
 * before the dictionary last changed is compared with the line as written.
 */
function sentHits(s: Segment, lexicon: LexEntry[]): LexHit[] {
  const sent = speak(s.text, lexicon);
  return s.audio.pronounced == null || s.audio.pronounced === sent.text ? sent.hits : [];
}

/** What hearing these clips costs at `t`'s rate per minute of audio. */
const costOf = (t: Transcriber, seconds: number): number => (seconds / 60) * t.perMinute;

/** The flag a mismatch raises: what was heard, quoted, cut to a note's length. */
const heardFlag = (heard: string, at: number): SegmentFlag => {
  const said = heard.length > NOTE_CHARS ? `${heard.slice(0, NOTE_CHARS).trimEnd()}…` : heard;
  return { kind: "heard", note: `Heard: “${said}”`, at };
};

export function checkHandler(provider: TranscriptionProvider, files: AudioFiles): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      if (job.chapterId == null) throw new Error("A check is for one chapter");
      const chapter = library.getChapter(db, job.bookId, job.chapterId);
      const uid = library.chapterUid(db, job.bookId, job.chapterId);
      if (!chapter || uid == null) throw notFound("The chapter no longer exists");
      const id = job.checkRun?.endpoint;
      const t = readTranscriber(db, id);
      if (!t?.enabled)
        throw new Error(`The transcription endpoint “${id ?? ""}” is no longer switched on`);

      const book = library.getBook(db, job.bookId);
      const again = job.checkRun?.again === true;
      const clips = clipsOf(readScript(db, job.bookId, job.chapterId), book);
      const todo = again ? clips : unheard(db, job.bookId, clips);
      const run: NonNullable<Job["checkRun"]> = {
        endpoint: t.id,
        lines: todo.length,
        checked: 0,
        mismatched: 0,
        failed: 0,
        ...(again ? { again } : {}),
      };
      setCheckRun(db, job.id, run);
      if (!todo.length) {
        ctx.note("Nothing to check", "info");
        return;
      }
      ctx.note("Check started", "info", { endpoint: t.name, lines: todo.length });

      // the cast's name words a clip's line is written with, which Phonon reads as words to
      // favour: a name said wrong may be heard right for it, a cost a check of names alone would
      // not pay
      const castWords = nameWords(readSpeakers(db, job.bookId));
      const lexicon = readLexicon(db, job.bookId);
      const label = "Check";
      let refused: string | null = null;
      let unhinted = false;

      /** Keep what was heard, and raise or take down the line's `heard` flag to match it. */
      const record = (c: Clip, line: HeardLine): void =>
        db.transaction((tx) => {
          writeHeard(tx, job.bookId, c.file, line, t.id);
          const at = library.locateChapter(tx, uid);
          if (!at) return;
          // the line as it is now: one edited or rendered again while it was heard is not flagged
          // for a clip it no longer plays, and a person's flag is never touched
          const now = lineNow(tx, at.bookId, at.id, c.s.id);
          if (!now || now.url == null || fileOf(now.url) !== c.file || now.text !== line.text)
            return;
          if (now.flag && now.flag.kind !== "heard") return;
          if (line.mismatch) setFlag(tx, at.bookId, at.id, c.s.id, heardFlag(line.heard, line.at));
          else if (now.flag) setFlag(tx, at.bookId, at.id, c.s.id, null);
          else return;
          bumpRevision(tx, at.bookId, at.id);
        });

      /** Hear one clip; a failure is counted and said, and the run goes on. */
      const hear = async (c: Clip): Promise<void> => {
        const seconds = c.s.audio.duration;
        const cost = costOf(t, seconds);
        const problem = budgetProblem(db, job.bookId, {
          kind: "transcription",
          cost,
          jobId: job.id,
          what: "the next line",
          requests: [{ endpoint: t.id, cost }],
        });
        if (problem) {
          refused = problem;
          ctx.note(`Stopped before line ${c.s.id}: the budget does not cover it`, "warning", {
            line: c.s.id,
            why: problem,
          });
          return;
        }
        // its money (`~/usage/dispatch`): held to the endpoint's limit while it is out, priced
        // into the ledger as it settles, and given back once it has
        const money = dispatch(db, {
          kind: "transcription",
          endpoint: t,
          work: { bookId: job.bookId, chapterUid: uid, label, queuedAt: job.queuedAt },
          hold: cost,
        });
        try {
          // `ready`: a demo clip nobody has played yet is made now
          const path = await files.ready(job.bookId, c.file);
          const audio = path ? Bun.file(path) : null;
          if (!audio || !(await audio.exists())) throw new Error("The clip's file is missing");
          const heard = await provider.transcribe(
            {
              audio: new Blob([await audio.bytes()], {
                type: AUDIO_MIME[formatOfFile(c.file) ?? "wav"],
              }),
              name: c.file,
              seconds,
              words: true,
              hints: namesIn(c.s.text, castWords),
              signal,
              sent: money.sent,
            },
            transcriberTarget(db, t),
          );
          if (heard.unhinted && !unhinted) {
            unhinted = true;
            ctx.note(
              `${t.name} gives no answer when sent the cast's names; heard without them`,
              "warning",
            );
          }
          const line: HeardLine = {
            text: c.s.text,
            heard: heard.text,
            ...alignHeard(c.s.text, heard.words, heard.text, sentHits(c.s, lexicon)),
            at: Date.now(),
          };
          record(c, line);
          run.checked++;
          if (line.mismatch) {
            run.mismatched++;
            ctx.note(`Line ${c.s.id} was heard saying something else`, "warning", {
              line: c.s.id,
              heard: heard.text,
              score: Number(line.score.toFixed(2)),
            });
          }
        } catch (e) {
          if (signal.aborted) throw e;
          run.failed++;
          ctx.note(`Line ${c.s.id} could not be heard`, "warning", {
            line: c.s.id,
            error: e instanceof Error ? e.message : String(e),
          });
        } finally {
          money.release();
        }
        setCheckRun(db, job.id, run);
        ctx.progress(((run.checked + run.failed) / todo.length) * 100);
      };

      // ponytail: a local pool at the concurrency the endpoint had when the run started; the speech
      // gate's live limits, pause and rate-limit cooldown are the upgrade if checks ever need them
      let next = 0;
      const lanes = Math.max(1, Math.min(t.concurrency, todo.length));
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          while (next < todo.length && refused == null && !signal.aborted) await hear(todo[next++]);
        }),
      );
      if (signal.aborted) throw signal.reason;
      const { checked, mismatched, failed } = run;
      ctx.note("Check finished", failed || mismatched ? "warning" : "info", {
        checked,
        mismatched,
        failed,
      });
      if (refused != null) throw new Error(refused);
      if (failed) throw new Error(`${failed} line${failed === 1 ? "" : "s"} could not be heard`);
    },
  };
}

/**
 * Queue a check by ear for each chapter, as one run, on the first transcription endpoint switched
 * on — refused whole, with a 400, when there is none.
 *
 * Chapters that are missing, skipped for the audiobook, being narrated or checked already, with no
 * clip to hear (`unnarrated`) or with every clip already heard as its line reads (`nothing`) are
 * left out and said so, as narration leaves chapters out — `again` hears every clip, those already
 * heard too, so a chapter heard before the comparison changed is heard by it. The run is priced by the minute of audio
 * it will send and checked against the book's budget whole, and the endpoint's daily limit against
 * its first line, before anything is queued.
 */
export function enqueueCheck(
  db: Db,
  runner: Pick<Runner, "enqueue">,
  bookId: string,
  ids: readonly number[],
  { again = false }: { again?: boolean } = {},
): CheckQueued {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  if (book.importing) throw conflict("Finish the contents review before checking this book");
  const t = readTranscriber(db);
  if (!t) throw badRequest(NO_TRANSCRIBER);
  const known = new Map(library.listChapters(db, bookId).map((c) => [c.id, c]));

  const targets: { id: number; clips: Clip[] }[] = [];
  const skipped: CheckQueued["skipped"] = [];
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
    if (activeJob(db, "narration", bookId, id) || activeJob(db, "check", bookId, id)) {
      skipped.push({ id, why: "busy" });
      continue;
    }
    const clips = clipsOf(readScript(db, bookId, id), book);
    if (!clips.length) {
      skipped.push({ id, why: "unnarrated" });
      continue;
    }
    const todo = again ? clips : unheard(db, bookId, clips);
    if (!todo.length) {
      skipped.push({ id, why: "nothing" });
      continue;
    }
    targets.push({ id, clips: todo });
  }
  if (targets.length)
    assertWithinBudget(db, bookId, {
      kind: "transcription",
      cost: costOf(
        t,
        targets.reduce((n, x) => n + x.clips.reduce((m, c) => m + c.s.audio.duration, 0), 0),
      ),
      requests: [{ endpoint: t.id, cost: costOf(t, targets[0].clips[0].s.audio.duration) }],
      request: "the first line",
    });

  const runId = nextRunId(db);
  const jobs = targets.map(
    ({ id, clips }, i) =>
      runner.enqueue({
        kind: "check",
        bookId,
        chapterId: id,
        label: "Check",
        bulk: { id: runId, op: "Check", index: i + 1, total: targets.length },
        run: {
          checkRun: {
            endpoint: t.id,
            lines: clips.length,
            checked: 0,
            mismatched: 0,
            failed: 0,
            ...(again ? { again: true as const } : {}),
          },
        },
      }).job,
  );
  return { jobs, skipped, runId, chapters: library.listChapters(db, bookId) };
}

/**
 * Queue a check of the chapter a narration job was for, when its book checks by ear and a
 * transcription endpoint is switched on. Called once the narration has finished, so the chapter is
 * no longer busy with it; a check that cannot be queued — the budget, a check already queued — is
 * said in the narration's log and leaves the narration as it ended.
 */
export function checkAfterNarration(ctx: JobContext): void {
  const { db } = ctx;
  const job = getJob(db, ctx.job.id);
  if (job?.chapterId == null) return;
  if (!library.getBook(db, job.bookId)?.checkByEar || !readTranscriber(db)) return;
  try {
    const queued = enqueueCheck(
      db,
      // straight into the queue: the worker that finished the narration takes it up next
      { enqueue: (input) => enqueueJob(db, input) },
      job.bookId,
      [job.chapterId],
    );
    if (queued.jobs.length) ctx.note("Check by ear queued", "info", { job: queued.jobs[0].id });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    ctx.note("Check by ear not queued", "warning", { why });
    ctx.log.warn({ err: e }, "check by ear not queued after narration");
  }
}

/** What was heard of a chapter's clips in the book, by line. */
export function chapterHeard(db: Db, bookId: string, chapterId: number): ChapterHeard {
  if (scriptRevision(db, bookId, chapterId) == null) throw notFound("No such chapter");
  const clips = readScript(db, bookId, chapterId)
    .filter((s) => s.audio.url)
    .map((s) => ({ s, file: fileOf(s.audio.url!) }));
  const found = readHeard(
    db,
    bookId,
    clips.map((c) => c.file),
  );
  const lines: ChapterHeard = {};
  for (const { s, file } of clips) {
    const line = found.get(file);
    if (line) lines[s.id] = line;
  }
  return lines;
}
