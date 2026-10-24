// Transcribe: a transcription endpoint hears each clip back and flags lines whose clip says
// something else. Findings are keyed by clip file + line text (`heard`), so an edited or re-rendered
// line is heard again. Never touches a clip, and never replaces or clears a flag a person set.
// Failed requests are counted and the job fails at the end, so a retry hears only what was missed.
import type {
  Book,
  ChapterHeard,
  TranscribeQueued,
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
import { fileName, formatOfFile, type AudioFiles } from "~/audio/files";
import { readLexicon, readSpeakers } from "~/db/cast";
import type { Db } from "~/db/client";
import { readTranscriber } from "~/db/endpoints";
import { activeJob, enqueueJob, getJob, nextRunId, setTranscribeRun } from "~/db/jobs";
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
import type { GateLimits, SpeechGate } from "~/providers/gate";
import { transcriberTarget } from "~/providers/target";
import type { TranscriptionProvider } from "~/providers/transcription";
import { assertWithinBudget, budgetProblem } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";

const NOTE_CHARS = 140;

const NO_TRANSCRIBER = "No transcription endpoint is switched on. Add one on the Endpoints page.";

interface Clip {
  s: Segment;
  file: string;
}

const clipsOf = (segs: readonly Segment[], book: Pick<Book, "readNotes"> | undefined): Clip[] =>
  segs
    .filter(
      (s) => isSpoken(s, book) && s.audio.status === "done" && s.audio.url && s.audio.duration > 0,
    )
    .map((s) => ({ s, file: fileName(s.audio.url!) }));

function unheard(db: Db, bookId: string, clips: readonly Clip[]): Clip[] {
  const found = readHeard(
    db,
    bookId,
    clips.map((c) => c.file),
  );
  return clips.filter((c) => found.get(c.file)?.text !== c.s.text);
}

/**
 * Dictionary substitutions as the clip was sent; none if the dictionary changed since
 * (`pronounced` no longer matches), so the line is compared as written.
 */
function sentHits(s: Segment, lexicon: LexEntry[]): LexHit[] {
  const sent = speak(s.text, lexicon);
  return s.audio.pronounced == null || s.audio.pronounced === sent.text ? sent.hits : [];
}

const costOf = (t: Transcriber, seconds: number): number => (seconds / 60) * t.perMinute;

const heardFlag = (heard: string, at: number): SegmentFlag => {
  const said = heard.length > NOTE_CHARS ? `${heard.slice(0, NOTE_CHARS).trimEnd()}…` : heard;
  return { kind: "mismatch", note: `Heard: “${said}”`, at };
};

export function transcribeHandler(
  provider: TranscriptionProvider,
  files: AudioFiles,
  gate: SpeechGate,
): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      if (job.chapterId == null) throw new Error("A transcription is for one chapter");
      const chapter = library.getChapter(db, job.bookId, job.chapterId);
      const uid = library.chapterUid(db, job.bookId, job.chapterId);
      if (!chapter || uid == null) throw notFound("The chapter no longer exists");
      const id = job.transcribeRun?.endpoint;
      const t = readTranscriber(db, id);
      if (!t?.enabled)
        throw new Error(`The transcription endpoint “${id ?? ""}” is no longer switched on`);

      const book = library.getBook(db, job.bookId);
      const again = job.transcribeRun?.again === true;
      const clips = clipsOf(readScript(db, job.bookId, job.chapterId), book);
      const todo = again ? clips : unheard(db, job.bookId, clips);
      const run: NonNullable<Job["transcribeRun"]> = {
        endpoint: t.id,
        lines: todo.length,
        transcribed: 0,
        mismatched: 0,
        failed: 0,
        ...(again ? { again } : {}),
      };
      setTranscribeRun(db, job.id, run);
      if (!todo.length) {
        ctx.note("Nothing to transcribe", "info");
        return;
      }
      ctx.note("Transcription started", "info", { endpoint: t.name, lines: todo.length });

      // Phonon favours these words, so a mispronounced name may still be heard right
      const castWords = nameWords(readSpeakers(db, job.bookId));
      const lexicon = readLexicon(db, job.bookId);
      const label = "Transcribe";
      let refused: string | null = null;
      let unhinted = false;

      const record = (c: Clip, line: HeardLine): void =>
        db.transaction((tx) => {
          writeHeard(tx, job.bookId, c.file, line, t.id);
          const at = library.locateChapter(tx, uid);
          if (!at) return;
          // skip if the line changed while heard, and never touch a person's flag
          const now = lineNow(tx, at.bookId, at.id, c.s.id);
          if (!now || now.url == null || fileName(now.url) !== c.file || now.text !== line.text)
            return;
          if (now.flag && now.flag.kind !== "mismatch") return;
          if (line.mismatch) setFlag(tx, at.bookId, at.id, c.s.id, heardFlag(line.heard, line.at));
          else if (now.flag) setFlag(tx, at.bookId, at.id, c.s.id, null);
          else return;
          bumpRevision(tx, at.bookId, at.id);
        });

      // a refusal takes the lines still waiting out of the gate
      const waits = new AbortController();
      const waiting = AbortSignal.any([signal, waits.signal]);
      /** read on every acquire, so a concurrency change applies live */
      const limits = (): GateLimits => ({
        concurrency: (readTranscriber(db, t.id) ?? t).concurrency,
        enabled: true,
      });
      /** Line `c` in its turn at the endpoint's slots, shared with other jobs. */
      const heardInTurn = async (c: Clip): Promise<void> => {
        let leave: () => void;
        try {
          leave = await gate.acquire(t.id, limits, { signal: waiting });
        } catch (e) {
          if (refused != null) return;
          throw e;
        }
        try {
          if (refused == null && !signal.aborted) await hear(c);
        } finally {
          leave();
        }
      };

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
          waits.abort();
          ctx.note(`Stopped before line ${c.s.id}: the budget does not cover it`, "warning", {
            line: c.s.id,
            why: problem,
          });
          return;
        }
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
          run.transcribed++;
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
        setTranscribeRun(db, job.id, run);
        ctx.progress(((run.transcribed + run.failed) / todo.length) * 100);
      };

      // FIFO slots, so lines are heard in order
      await Promise.all(todo.map(heardInTurn));
      if (signal.aborted) throw signal.reason;
      const { transcribed, mismatched, failed } = run;
      ctx.note("Transcription finished", failed || mismatched ? "warning" : "info", {
        transcribed,
        mismatched,
        failed,
      });
      if (refused != null) throw new Error(refused);
      if (failed) throw new Error(`${failed} line${failed === 1 ? "" : "s"} could not be heard`);
    },
  };
}

/**
 * Queue a transcription per chapter on the first enabled transcription endpoint (400 if none). Chapters with
 * nothing to hear are skipped; `again` re-hears clips already heard. The whole run is priced per
 * minute of audio and held against the budget before anything is queued.
 */
export function enqueueTranscribe(
  db: Db,
  runner: Pick<Runner, "enqueue">,
  bookId: string,
  ids: readonly number[],
  { again = false }: { again?: boolean } = {},
): TranscribeQueued {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  if (library.inReview(book, ids))
    throw conflict("Finish the contents review before transcribing this book");
  const t = readTranscriber(db);
  if (!t) throw badRequest(NO_TRANSCRIBER);
  const known = new Map(library.listChapters(db, bookId).map((c) => [c.id, c]));

  const targets: { id: number; clips: Clip[] }[] = [];
  const skipped: TranscribeQueued["skipped"] = [];
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
    if (activeJob(db, "narration", bookId, id) || activeJob(db, "transcribe", bookId, id)) {
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
        kind: "transcribe",
        bookId,
        chapterId: id,
        label: "Transcribe",
        bulk: { id: runId, op: "Transcribe", index: i + 1, total: targets.length },
        run: {
          transcribeRun: {
            endpoint: t.id,
            lines: clips.length,
            transcribed: 0,
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
 * After a narration ends, queue a transcription of its chapter if the book transcribes after narration. One that
 * can't be queued is logged on the narration and doesn't change its outcome.
 */
export function transcribeAfterNarration(ctx: JobContext): void {
  const { db } = ctx;
  const job = getJob(db, ctx.job.id);
  if (job?.chapterId == null) return;
  if (!library.getBook(db, job.bookId)?.autoTranscribe || !readTranscriber(db)) return;
  try {
    const queued = enqueueTranscribe(
      db,
      // straight into the queue: this worker takes it up next
      { enqueue: (input) => enqueueJob(db, input) },
      job.bookId,
      [job.chapterId],
    );
    if (queued.jobs.length) ctx.note("Transcription queued", "info", { job: queued.jobs[0].id });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    ctx.note("Transcription not queued", "warning", { why });
    ctx.log.warn({ err: e }, "transcription not queued after narration");
  }
}

export function chapterHeard(db: Db, bookId: string, chapterId: number): ChapterHeard {
  if (scriptRevision(db, bookId, chapterId) == null) throw notFound("No such chapter");
  const clips = readScript(db, bookId, chapterId)
    .filter((s) => s.audio.url)
    .map((s) => ({ s, file: fileName(s.audio.url!) }));
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
