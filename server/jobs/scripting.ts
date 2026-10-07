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
//
// Money follows the rule in `~/usage/budget`. A run is priced at its worst case before anything is
// queued and refused whole if the book cannot afford it; each job holds its chapter's share while
// it runs and asks again before every request it sends; and every request the provider reports is
// priced into the ledger as it lands, releasing what that request held.
//
// The prompt is fixed when the run is queued, like the profile: the library's, the endpoint's and
// the book's layers are resolved then (`resolvePrompt`) and kept on the run with the book's notes,
// so an edit made while it waits reaches the next run and not this one. Its tags are filled in per
// request, from the book, the chapter, its cast as it stands, the request's place in the chapter,
// the prose before it and where the chapter before left off. What the model says beside its lines
// — the speakers' gender, other names and description, and a recap — is kept with the script.
import type { Book, Job, Profile, PromptTemplate, ScriptingQueued, Segment } from "@/types";
import { expressionNames, scriptedAnnotation } from "@/lib/expressions";
import { BUILT_IN_PROMPT, renderPrompt, resolvePrompt, type PromptVars } from "@/lib/prompt";
import { tokenEstimate } from "@/lib/scripting";
import { ensureSpeakers, learnCast, readSpeakers } from "~/db/cast";
import type { Db, Tx } from "~/db/client";
import { capture } from "~/db/history";
import { readEndpoints, readProfiles } from "~/db/endpoints";
import { activeJob, getJob, nextRunId, setScriptRun } from "~/db/jobs";
import * as library from "~/db/library";
import { readLibraryPrompt } from "~/db/settings";
import { ScriptConflict, lineCount, readScript, replaceScript, scriptRevision } from "~/db/script";
import { plainText } from "~/epub/markdown";
import type { JobContext, JobHandler, Runner } from "~/jobs/runner";
import { conflict, notFound } from "~/lib/errors";
import type { ScriptAnswer, ScriptingProvider } from "~/providers/scripting";
import type { SentScript } from "~/providers/sent";
import { scriptTarget } from "~/providers/target";
import { beforeOf, chunksOf } from "~/script/chunks";
import { checkSiteText, siteTextTally } from "~/script/siteCheck";
import { UNREAD_SHARE_WARNING } from "@/lib/siteText";
import { assertWithinBudget, budgetProblem } from "~/usage/budget";
import { dispatch, type Dispatch } from "~/usage/dispatch";
import { scriptReasoning } from "~/usage/ledger";

/** The status a chapter reads as when no job is running on it: asked of its script, not remembered. */
function settledScriptingStatus(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  outcome: "done" | "failed" | "cancelled",
): "none" | "done" | "failed" {
  // a re-script that failed leaves the old script intact, and a chapter with a usable script must
  // not read as failed — that is what would stop it being narrated or exported
  if (lineCount(db, bookId, chapterId)) return "done";
  return outcome === "failed" ? "failed" : "none";
}

/**
 * What the chapter's script marked as not the story, said in the job's log: how many lines of site
 * text and notes, and how many the detector wants a person to look at. Marked text is not read, so
 * a chapter with much of it gets a warning — a model marking story as site text is how a
 * paragraph would vanish from the audiobook with nothing saying so.
 */
function noteSiteText(
  ctx: JobContext,
  segs: readonly Segment[],
  book: Pick<Book, "readNotes"> | undefined,
): void {
  const { watermarks, notes, toCheck, share } = siteTextTally(segs, book);
  if (!watermarks && !notes && !toCheck) return;
  const n = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`;
  const percent = Math.round(share * 100);
  ctx.note(
    `${n(watermarks, "line")} marked as site text, ${n(notes, "note")}, ${toCheck} to check`,
    "info",
    { watermarks, notes, toCheck, percent },
  );
  if (share > UNREAD_SHARE_WARNING)
    ctx.note(
      `${percent}% of this chapter's words are marked as site text or notes that will not be read; check the model did not mark story`,
      "warning",
      { percent },
    );
}

/** The chapter as the job needs it: where it is, what it says, and which script it is replacing. */
function readChapter(db: Db, bookId: string, chapterId: number) {
  const chapter = library.getChapter(db, bookId, chapterId);
  const uid = library.chapterUid(db, bookId, chapterId);
  const revision = scriptRevision(db, bookId, chapterId);
  if (!chapter || uid == null || revision == null) throw notFound("The chapter no longer exists");
  const body = library.getChapterBody(db, bookId, chapterId);
  if (body == null) throw notFound("The chapter has no text");
  return { uid, title: chapter.title, revision, text: plainText(body) };
}

/**
 * What each chunk holds against the budget while it is unsettled: its worst case, at the dearest
 * rates any window or promotion on the card can reach (`ceilingRates`) with the whole output
 * ceiling, and the prompt sent with it (`tokenEstimate`). Nothing for a run with no profile, which
 * has no rates to price it by.
 */
function holdsOf(
  chunks: readonly string[],
  profile: Profile | undefined,
  prompt: PromptTemplate | undefined,
): number[] {
  return chunks.map((c) =>
    profile ? tokenEstimate(c, profile, Date.now(), { prompt }).reserve : 0,
  );
}

export function scriptingHandler(provider: ScriptingProvider): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      if (job.chapterId == null) throw new Error("A scripting job is for one chapter");
      const chapter = readChapter(db, job.bookId, job.chapterId);
      // The model is told the number a reader knows the chapter by, not the id, which counts the
      // cover and contents pages; a skipped chapter has none, and is told its id rather than nothing.
      const number = library.readingNumber(db, job.bookId, job.chapterId) ?? job.chapterId;
      // The profile as it was when the run was queued, not as it has been edited since: a run
      // keeps the chunking it was previewed and started with.
      const queued = job.scriptRun;
      const chunks = chunksOf(chapter.text, queued?.profile);
      // Where the requests go, with the profile's key read now rather than when it was queued, so a
      // key saved after pressing Script is the one used. Null for a run that named no profile,
      // which the provider refuses with a message saying so.
      const target = queued ? scriptTarget(db, queued.profile) : null;
      const speakers = readSpeakers(db, job.bookId);
      const cast = speakers.map((c) => c.name);
      // The prompt the run was queued with; a run queued before prompts could be edited is sent
      // the built-in one, which is what it would have been sent then.
      const template = queued?.prompt ?? BUILT_IN_PROMPT;
      const book = library.getBook(db, job.bookId);
      const recap = library.previousRecap(db, job.bookId, job.chapterId);
      const expressions = expressionNames(readEndpoints(db));
      const varsFor = (i: number): PromptVars => ({
        book: {
          title: book?.title ?? "",
          author: book?.author ?? "",
          notes: queued?.prompt?.notes ?? "",
        },
        chapter: { title: chapter.title, number },
        part: i + 1,
        parts: chunks.length,
        cast: speakers,
        excerpt: chunks[i],
        before: beforeOf(chunks, i),
        recap,
        endpoint: {
          name: queued?.profile.name ?? "",
          model: queued?.profile.model ?? "",
          notes: queued?.profile.prompt?.notes ?? "",
        },
        expressions,
      });
      library.setChapterScripting(db, job.bookId, job.chapterId, "running", 0);
      ctx.note("Scripting started", "info", {
        provider: provider.name,
        characters: chapter.text.length,
        ...(queued
          ? { profile: queued.profile.name, model: queued.profile.model, requests: chunks.length }
          : {}),
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
        const at = library.locateChapter(db, chapter.uid);
        if (at) library.setChapterScripting(db, at.bookId, at.id, "running", pct);
      };
      // The run's live detail, one object that every write goes through, so a request settling
      // from inside the provider and the worker counting it can never write over each other. It
      // starts holding the whole chapter's worst case — again, on a restart that picks the job
      // back up — and keeps what earlier attempts cost, which the ledger holds too.
      const holds = holdsOf(chunks, queued?.profile, queued?.prompt);
      const run: NonNullable<Job["scriptRun"]> | undefined = queued && {
        ...queued,
        requests: chunks.length,
        completed: 0,
        active: 0,
        reserved: holds.reduce((a, b) => a + b, 0),
      };
      const counted = (): void => {
        if (run && !signal.aborted) setScriptRun(db, job.id, run);
      };
      counted();
      /**
       * Chunk `i`'s money (`~/usage/dispatch`): its worst case held while its request is out, what
       * it reports priced into the ledger against the profile as it is stored then — or the run's
       * own copy if the profile has since been removed — and what it held given back, from the
       * run's reservation too, once the request has ended however it ended. A run with no profile
       * is the fake's, which has no rates and no endpoint to put the row against, and holds nothing.
       */
      const dispatched = (i: number) =>
        run &&
        dispatch(db, {
          kind: "scripting",
          endpoint: run.profile,
          work: {
            bookId: job.bookId,
            chapterUid: chapter.uid,
            label: `Script chunk ${i + 1}`,
            queuedAt: job.queuedAt,
            reasoning: run.profile.reasoning ?? null,
          },
          hold: holds[i],
          gaveBack: (back) => void (run.reserved = Math.max(0, run.reserved - back)),
        });
      /** One request the provider reported, settled and counted on the run. */
      const settle = (money: Dispatch<"scripting">, sent: SentScript): void => {
        if (!run) return;
        run.cost += money.sent(sent)?.cost ?? 0;
        if (sent.usage) {
          run.inputTokens += sent.usage.inputTokens;
          run.outputTokens += sent.usage.outputTokens;
          run.cachedInput = (run.cachedInput ?? 0) + (sent.usage.cachedInput ?? 0);
          if (sent.usage.cachedInput == null) run.cacheUnreported = (run.cacheUnreported ?? 0) + 1;
        }
        setScriptRun(db, job.id, run);
      };
      /**
       * Why the next request may not go out, or null. It asks the book with everything this job
       * still holds — what is in flight and what is still to send — against what the rest of the
       * book has spent and holds, so that only answers when the world moved under a run that
       * fitted; and it asks the profile's daily limit with the next request's own hold, since a
       * long run is let spend across days.
       */
      const refusal = (): string | null =>
        budgetProblem(db, job.bookId, {
          kind: "scripting",
          cost: run?.reserved ?? 0,
          jobId: job.id,
          what: "the next request",
          requests: run ? [{ endpoint: run.profile.id, cost: holds[next] }] : [],
        });
      let refused: string | null = null;

      // Up to the profile's concurrency at once, the answers kept in the chapter's order. The
      // first chunk that fails stops the others and fails the chapter: half a script is never
      // written, and the attempt says which request it was.
      const answers: ScriptAnswer[] = chunks.map(() => ({ lines: [] }));
      const stop = new AbortController();
      const onAbort = (): void => stop.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < chunks.length && !stop.signal.aborted && refused == null) {
          // A budget that no longer allows the next request stops the run here: nothing more goes
          // out, the requests already out are let land and are paid for, and the job fails after.
          refused = refusal();
          if (refused != null) return;
          const i = next++;
          if (run) run.active++;
          counted();
          const money = dispatched(i);
          try {
            answers[i] = await provider.script({
              title: chapter.title,
              text: chunks[i],
              signal: stop.signal,
              target,
              cast,
              prompt: renderPrompt(template, varsFor(i)),
              ...(money ? { sent: (request: SentScript) => settle(money, request) } : {}),
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
            if (run) run.active--;
            money?.release();
          }
          share[i] = 1;
          if (run) run.completed++;
          counted();
          report();
          if (chunks.length > 1)
            ctx.note(`Request ${i + 1} of ${chunks.length} answered`, "info", {
              characters: chunks[i].length,
              lines: answers[i].lines.length,
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
      if (refused != null) throw new Error(refused);

      // Stitched in reading order and numbered afresh: a line belongs to the chunk it came back
      // in, and the ids are the chapter's, 1 to n, as are the ids of the tags the model wrote.
      let annotation = 0;
      const lines: Segment[] = answers
        .flatMap((a) => a.lines)
        .map((l, i) => ({
          id: i + 1,
          type: l.type,
          speaker: l.speaker,
          text: l.text,
          direction: l.direction ?? "",
          ...(l.tags?.length
            ? { expressions: l.tags.map((t) => scriptedAnnotation(t, ++annotation)) }
            : {}),
          audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
        }));
      // where the chapter leaves off is where its last chunk that said so left off
      const leftOff =
        answers
          .map((a) => a.recap)
          .filter(Boolean)
          .at(-1) ?? null;

      // The write: by uid, against the revision the job started from, all in one transaction —
      // the script, the version it replaces, and the speakers it brought into the cast. A run
      // that fails, is cancelled or is refused for landing on newer work never gets here, so a
      // good script is never pushed into the history by an attempt that produced nothing.
      try {
        db.transaction((tx) => {
          const at = library.locateChapter(tx, chapter.uid);
          if (!at) throw notFound("The chapter was removed while it was being scripted");
          // the detector's second opinion on what is site text, against the book as it stands
          const segs = checkSiteText(tx, at.bookId, at.id, lines);
          noteSiteText(ctx, segs, book);
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
              ...(queued
                ? { model: provider.callsProfile ? queued.profile.model : provider.name }
                : {}),
              again: previous.length > 0,
              ...(queued?.prompt ? { prompt: queued.prompt.origin } : {}),
            },
            previous,
            segs,
          );
          const added = ensureSpeakers(
            tx,
            at.bookId,
            segs.map((s) => s.speaker),
          );
          // after the new speakers are in, so what the model said of them has somewhere to go
          const learnt = learnCast(
            tx,
            at.bookId,
            answers.flatMap((a) => a.cast ?? []),
          );
          // a recap belongs to the script it came with: one written without leaves none
          library.setChapterRecap(tx, at.bookId, at.id, leftOff);
          library.setChapterScripting(tx, at.bookId, at.id, "done", 100);
          ctx.note("Script written", "info", {
            lines: segs.length,
            speakers: new Set(segs.map((s) => s.speaker)).size,
            revision,
            ...(added.length ? { speakersAdded: added.join(", ") } : {}),
            ...(learnt.length ? { speakersFilledIn: learnt.join(", ") } : {}),
            ...(leftOff ? { recap: leftOff } : {}),
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
      if (!library.chapterExists(ctx.db, fresh.bookId, fresh.chapterId)) return;
      library.setChapterScripting(
        ctx.db,
        fresh.bookId,
        fresh.chapterId,
        settledScriptingStatus(ctx.db, fresh.bookId, fresh.chapterId, status),
        0,
      );
    },
  };
}

/**
 * Queue a scripting job for each chapter, as one run.
 *
 * Chapters skipped for the audiobook and chapters already being scripted are left out and said so,
 * rather than refused: a bulk press over a selection that includes one is a person's intent for
 * the rest. A book still in its contents review has nothing to script yet, and that is refused, as
 * is a profile this server does not have (404).
 *
 * So is a run the book cannot afford, whole: its worst case is checked against the budget before
 * any chapter is queued, and a run that does not fit queues nothing (409). A paused book refuses
 * every run, a free one included. The profile's daily limit refuses a run only when it cannot
 * cover even the first request; past that, the job stops at the request that would pass it.
 */
export function enqueueScripting(
  db: Db,
  runner: Runner,
  bookId: string,
  ids: readonly number[],
  profile?: string,
): ScriptingQueued {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  if (book.importing) throw conflict("Finish the contents review before scripting this book");
  // The profile is read once, here, and kept on every job of the run. The endpoints live on this
  // server, so one the request names that it does not have is a mistake to say now, not a run of
  // jobs that each fail for want of it. A request that names none is queued: what it is sent to
  // decides — the server's own provider refuses it, saying to choose one, and a test's fake
  // scripts it.
  const chosen = profile ? readProfiles(db).find((p) => p.id === profile) : undefined;
  if (profile && !chosen)
    throw notFound(
      `No such scripting endpoint “${profile}”`,
      "Save it on the Endpoints page, or choose another.",
    );
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

  // a run is named by the profile it goes to
  const via = chosen?.name ?? "no profile";
  // The prompt is resolved once too, and kept with the notes it will fill in — the template the
  // run was priced with is the one it sends, whatever is edited while it waits.
  const prompt = chosen && {
    ...resolvePrompt({ library: readLibraryPrompt(db), profile: chosen.prompt, book: book.prompt }),
    notes: book.prompt?.notes ?? "",
  };
  // What the endpoint's recent requests at its reasoning level spent thinking, which the estimate
  // adds to the output it expects; the hold needs none of it, being the whole output ceiling.
  const reasoningPerInputToken = chosen ? scriptReasoning(db, chosen)?.perInputToken : undefined;
  const run: Job["scriptRun"] = chosen && {
    profile: chosen,
    prompt,
    requests: 0,
    completed: 0,
    active: 0,
    reserved: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  // Each chapter's worst case, cut exactly as its job will cut it, and what it is expected to cost
  // at today's rates for the reconciliation afterwards; and its first request's, which is what the
  // profile's daily limit must cover for the run to start.
  const priced = new Map(
    targets.map((id) => {
      if (!chosen) return [id, { reserve: 0, estimated: 0, first: 0 }] as const;
      const text = plainText(library.getChapterBody(db, bookId, id) ?? "");
      const chunks = chunksOf(text, chosen);
      const holds = holdsOf(chunks, chosen, prompt);
      return [
        id,
        {
          reserve: holds.reduce((a, b) => a + b, 0),
          first: holds[0] ?? 0,
          estimated: chunks.reduce(
            (n, c) =>
              n + tokenEstimate(c, chosen, Date.now(), { prompt, reasoningPerInputToken }).cost,
            0,
          ),
        },
      ] as const;
    }),
  );
  if (targets.length)
    assertWithinBudget(db, bookId, {
      kind: "scripting",
      cost: [...priced.values()].reduce((n, p) => n + p.reserve, 0),
      requests: chosen ? [{ endpoint: chosen.id, cost: priced.get(targets[0])!.first }] : [],
    });

  const runId = nextRunId(db);
  const jobs: Job[] = [];
  targets.forEach((id, i) => {
    const c = known.get(id)!;
    const replacing = c.scripting === "done";
    const { reserve, estimated } = priced.get(id)!;
    const held = run && { ...run, reserved: reserve, estimated };
    const { job } = runner.enqueue({
      kind: "scripting",
      bookId,
      chapterId: id,
      label: `${replacing ? "Re-script" : "Script"} · ${via}`,
      bulk: {
        id: runId,
        op: replacing ? "Re-script" : "Script",
        index: i + 1,
        total: targets.length,
      },
      // in the same transaction as the row, so it cannot land after the worker has moved on
      ...(held ? { run: { scriptRun: held } } : {}),
      onCreated: (tx) => library.setChapterScripting(tx, bookId, id, "queued", 0),
    });
    jobs.push(job);
  });
  // the chapters as they now stand, with the queued ones marked
  return { jobs, skipped, runId, chapters: library.listChapters(db, bookId) };
}
