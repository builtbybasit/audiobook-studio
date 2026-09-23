// The scripting job: a chapter's prose in, an attributed script out, written only if nothing
// newer got there first.
//
// The job reads the chapter twice. Once when it starts, to take the prose and the script revision
// it is working from; and once inside the write, by the chapter's **uid**, to find where the
// chapter is now and whether its script has moved. The number a chapter goes by can change while a
// job runs — removing an earlier volume renumbers the book — and its script can change too, once
// there is a route that edits one. The uid answers the first; `replaceScript`'s revision check
// answers the second, and a result that would land on newer work is dropped with a note saying
// so rather than written over it.
//
// The chapter's `scripting` status is the job's to keep honest: `queued` when the job is, `running`
// while it runs, and afterwards whatever the chapter's script actually is — `done` if it has one,
// `none` if it never did, and `failed` only when a run that was meant to give it one could not.
import { and, count, eq } from "drizzle-orm";

import type { Job, Profile, Segment } from "@/types";
import { scriptParts } from "@/lib/scripting";
import { ensureSpeakers } from "~/db/cast";
import type { Db, Tx } from "~/db/client";
import { capture } from "~/db/history";
import { readProfiles } from "~/db/endpoints";
import { activeJob, appendEvent, getJob, nextRunId, setScriptRun } from "~/db/jobs";
import * as library from "~/db/library";
import { chapters, segments } from "~/db/schema";
import { ScriptConflict, readScript, replaceScript } from "~/db/script";
import { plainText } from "~/epub/markdown";
import type { JobContext, JobHandler, Runner } from "~/jobs/runner";
import { conflict, notFound } from "~/lib/errors";
import type { ScriptedLine, ScriptingProvider } from "~/providers/scripting";

/** The status a chapter reads as when no job is running on it: asked of its script, not remembered. */
export function settledScriptingStatus(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  outcome: "done" | "failed" | "cancelled",
): "none" | "done" | "failed" {
  const lines =
    db
      .select({ n: count() })
      .from(segments)
      .where(and(eq(segments.bookId, bookId), eq(segments.chapterId, chapterId)))
      .get()?.n ?? 0;
  // a re-script that failed leaves the old script intact, and a chapter with a usable script must
  // not read as failed — that is what would stop it being narrated or exported
  if (lines) return "done";
  return outcome === "failed" ? "failed" : "none";
}

function setChapterScripting(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  scripting: "none" | "queued" | "running" | "done" | "failed",
  progress: number,
): void {
  db.update(chapters)
    .set({ scripting, scriptingProgress: progress })
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .run();
}

/** The chapter as the job needs it: where it is, what it says, and which script it is replacing. */
function readChapter(db: Db, bookId: string, chapterId: number) {
  const row = db
    .select({ uid: chapters.uid, title: chapters.title, revision: chapters.scriptRevision })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!row) throw notFound("The chapter no longer exists");
  const body = library.getChapterBody(db, bookId, chapterId);
  if (body == null) throw notFound("The chapter has no text");
  return { ...row, text: plainText(body) };
}

/** Where a chapter is now, by the identity that does not move. The narration job asks this too. */
export function locate(db: Db | Tx, uid: string): { bookId: string; id: number } | undefined {
  return db
    .select({ bookId: chapters.bookId, id: chapters.id })
    .from(chapters)
    .where(eq(chapters.uid, uid))
    .get();
}

/**
 * The chapter cut into the requests its profile allows, exactly as the Endpoints page previews
 * them: `scriptParts` is the demo's own call, with the source's whitespace kept so the pieces
 * rejoin to the chapter. No profile, or a limit of 0, is the chapter whole.
 */
function chunksOf(text: string, profile: Profile | undefined): string[] {
  const parts = profile ? scriptParts(text, profile) : [];
  return parts.length ? parts : [text];
}

export function scriptingHandler(provider: ScriptingProvider): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      if (job.chapterId == null) throw new Error("A scripting job is for one chapter");
      const chapter = readChapter(db, job.bookId, job.chapterId);
      // The profile as it was when the run was queued, not as it has been edited since: a run
      // keeps the chunking it was previewed and started with.
      const queued = job.scriptRun;
      const chunks = chunksOf(chapter.text, queued?.profile);
      setChapterScripting(db, job.bookId, job.chapterId, "running", 0);
      ctx.note("Scripting started", "info", {
        provider: provider.name,
        characters: chapter.text.length,
        ...(queued ? { profile: queued.profile.name, requests: chunks.length } : {}),
      });

      // Each chunk's share of the chapter's progress, so the bar counts across all of them and
      // never runs backwards when a provider starts counting again for the next one.
      const share = chunks.map(() => 0);
      let lastPct = -1;
      const report = (): void => {
        // a provider that keeps reporting after it was told to stop must not mark the chapter
        // running again once settling has put it back
        if (signal.aborted) return;
        const pct = Math.round((share.reduce((a, b) => a + b, 0) / chunks.length) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        ctx.progress(pct);
        const at = locate(db, chapter.uid);
        if (at) setChapterScripting(db, at.bookId, at.id, "running", pct);
      };
      let completed = 0;
      let active = 0;
      const counted = (): void => {
        if (queued && !signal.aborted)
          setScriptRun(db, job.id, { ...queued, requests: chunks.length, completed, active });
      };

      // Up to the profile's concurrency at once, the answers kept in the chapter's order. The
      // first chunk that fails stops the others and fails the chapter: half a script is never
      // written, and the attempt says which request it was.
      const answers: ScriptedLine[][] = chunks.map(() => []);
      const stop = new AbortController();
      const onAbort = (): void => stop.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < chunks.length && !stop.signal.aborted) {
          const i = next++;
          active++;
          counted();
          try {
            answers[i] = await provider.script({
              title: chapter.title,
              text: chunks[i],
              signal: stop.signal,
              progress: (done, total) => {
                share[i] = total ? done / total : 1;
                report();
              },
            });
          } catch (e) {
            if (signal.aborted || chunks.length === 1) throw e;
            throw new Error(
              `Request ${i + 1} of ${chunks.length} failed: ${e instanceof Error ? e.message : String(e)}`,
              { cause: e },
            );
          } finally {
            active--;
          }
          share[i] = 1;
          completed++;
          counted();
          report();
          if (chunks.length > 1)
            ctx.note(`Request ${i + 1} of ${chunks.length} answered`, "info", {
              characters: chunks[i].length,
              lines: answers[i].length,
            });
        }
      };
      try {
        const width = Math.max(1, Math.min(queued?.profile.concurrency ?? 1, chunks.length));
        await Promise.all(Array.from({ length: width }, worker));
      } catch (e) {
        stop.abort(e);
        throw e;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) throw signal.reason;

      // Stitched in reading order and numbered afresh: a line belongs to the chunk it came back
      // in, and the ids are the chapter's, 1 to n.
      const segs: Segment[] = answers.flat().map((l, i) => ({
        id: i + 1,
        type: l.type,
        speaker: l.speaker,
        text: l.text,
        direction: l.direction ?? "",
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      }));

      // The write: by uid, against the revision the job started from, all in one transaction —
      // the script, the version it replaces, and the speakers it brought into the cast. A run
      // that fails, is cancelled or is refused for landing on newer work never gets here, so a
      // good script is never pushed into the history by an attempt that produced nothing.
      try {
        db.transaction((tx) => {
          const at = locate(tx, chapter.uid);
          if (!at) throw notFound("The chapter was removed while it was being scripted");
          const previous = readScript(tx, at.bookId, at.id);
          const { revision } = replaceScript(tx, at.bookId, at.id, segs, {
            ifRevision: chapter.revision,
          });
          const version = capture(
            tx,
            at.bookId,
            at.id,
            {
              kind: "scripted",
              profile: queued?.profile.name ?? provider.name,
              ...(queued ? { model: provider.name } : {}),
              again: previous.length > 0,
            },
            previous,
            segs,
          );
          const added = ensureSpeakers(
            tx,
            at.bookId,
            segs.map((s) => s.speaker),
          );
          setChapterScripting(tx, at.bookId, at.id, "done", 100);
          ctx.note("Script written", "info", {
            lines: segs.length,
            speakers: new Set(segs.map((s) => s.speaker)).size,
            revision,
            ...(added.length ? { speakersAdded: added.join(", ") } : {}),
            ...(version != null ? { preserved: `v${version}` } : {}),
            ...(at.id !== job.chapterId ? { chapterNow: at.id } : {}),
          });
        });
      } catch (e) {
        if (e instanceof ScriptConflict) throw conflict(e.message);
        throw e;
      }
    },

    onSettled(ctx, status) {
      // `done` wrote the chapter's status inside its own transaction. Anything else puts the
      // chapter back to what its script says it is — read off the job's row, whose chapter number
      // has followed any renumbering by cascade, rather than the number the job started with.
      if (status === "done") return;
      const fresh = getJob(ctx.db, ctx.job.id);
      if (!fresh || fresh.chapterId == null) return;
      const exists = ctx.db
        .select({ id: chapters.id })
        .from(chapters)
        .where(and(eq(chapters.bookId, fresh.bookId), eq(chapters.id, fresh.chapterId)))
        .get();
      if (!exists) return;
      setChapterScripting(
        ctx.db,
        fresh.bookId,
        fresh.chapterId,
        settledScriptingStatus(ctx.db, fresh.bookId, fresh.chapterId, status),
        0,
      );
    },
  };
}

export interface ScriptingQueued {
  jobs: Job[];
  /** chapters left out of this run, and why */
  skipped: { id: number; why: "excluded" | "busy" | "missing" }[];
  runId: number;
}

/**
 * Queue a scripting job for each chapter, as one run.
 *
 * Chapters skipped for the audiobook and chapters already being scripted are left out and said so,
 * rather than refused: a bulk press over a selection that includes one is a person's intent for
 * the rest. A book still in its contents review has nothing to script yet, and that is refused.
 */
export function enqueueScripting(
  db: Db,
  runner: Runner,
  bookId: string,
  ids: readonly number[],
  { provider, profile }: { provider: string; profile?: string },
): ScriptingQueued {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  if (book.importing) throw conflict("Finish the contents review before scripting this book");
  const known = new Map(library.listChapters(db, bookId).map((c) => [c.id, c]));

  const targets: number[] = [];
  const skipped: ScriptingQueued["skipped"] = [];
  for (const id of ids) {
    const c = known.get(id);
    if (!c) skipped.push({ id, why: "missing" });
    else if (c.excluded) skipped.push({ id, why: "excluded" });
    else if (activeJob(db, "scripting", bookId, id)) skipped.push({ id, why: "busy" });
    else targets.push(id);
  }

  // The profile is read once, here, and kept on every job of the run. One the browser names but
  // this server was never sent is not a refusal — a fresh server has no endpoints until the page
  // saves them — so its chapters go whole, and each job says why.
  const chosen = profile ? readProfiles(db).find((p) => p.id === profile) : undefined;
  const run: Job["scriptRun"] = chosen && {
    profile: chosen,
    requests: 0,
    completed: 0,
    active: 0,
    reserved: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  const runId = nextRunId(db);
  const jobs: Job[] = [];
  targets.forEach((id, i) => {
    const c = known.get(id)!;
    const replacing = c.scripting === "done";
    const { job } = runner.enqueue({
      kind: "scripting",
      bookId,
      chapterId: id,
      label: `${replacing ? "Re-script" : "Script"} · ch ${id} · ${provider}`,
      bulk: {
        id: runId,
        op: replacing ? "Re-script" : "Script",
        index: i + 1,
        total: targets.length,
      },
      // in the same transaction as the row, so it cannot land after the worker has moved on
      ...(run ? { run: { scriptRun: run } } : {}),
      onCreated: (tx) => setChapterScripting(tx, bookId, id, "queued", 0),
    });
    if (profile && !chosen)
      appendEvent(
        db,
        job.id,
        `The scripting profile “${profile}” is not saved on this server; the chapter goes whole`,
        "warning",
      );
    jobs.push(job);
  });
  return { jobs, skipped, runId };
}
