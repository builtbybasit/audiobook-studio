// The scripting job: a chapter's prose in, an attributed script out. Finds the chapter by uid at
// write time (volumes renumber) and writes against the revision it started from, so a result that
// would land on newer work is dropped with a note. Money rules: `~/usage/budget`. The prompt is
// resolved when queued (`resolvePrompt`); edits while it waits reach the next run.
import type { Book, Job, Profile, PromptTemplate, ScriptingQueued, Segment } from "@/types";
import { castNameFor } from "@/lib/cast";
import { expressionNames, scriptedAnnotation } from "@/lib/expressions";
import {
  BUILT_IN_PROMPT,
  lineEffectsOf,
  renderPrompt,
  resolvePrompt,
  type PromptVars,
} from "@/lib/prompt";
import { tokenEstimate } from "@/lib/scripting";
import { ensureSpeakers, learnCast, readChapterCast, readSpeakers } from "~/db/cast";
import type { Db, Tx } from "~/db/client";
import { listEffects } from "~/db/effects";
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

/** A chapter's scripting status when idle, derived from its script. */
function settledScriptingStatus(
  db: Db | Tx,
  bookId: string,
  chapterId: number,
  outcome: "done" | "failed" | "cancelled",
): "none" | "done" | "failed" {
  // a failed re-script keeps the old script; reading as failed would block narration and export
  if (lineCount(db, bookId, chapterId)) return "done";
  return outcome === "failed" ? "failed" : "none";
}

/**
 * Log how much of the script was marked site text or notes. Marked text is not read, so a lot of it
 * gets a warning: a model marking story as site text would silently drop it from the audiobook.
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
 * Each chunk's budget hold: worst case at the dearest rates (`ceilingRates`) with the full output
 * ceiling plus the prompt. Zero without a profile.
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
      // reading number, not the id (which counts cover and contents); skipped chapters use the id
      const number = library.readingNumber(db, job.bookId, job.chapterId) ?? job.chapterId;
      // the profile as queued, so the run keeps the chunking it was previewed with
      const queued = job.scriptRun;
      const chunks = chunksOf(chapter.text, queued?.profile);
      // the key is read now, so one saved after pressing Script is used
      const target = queued ? scriptTarget(db, queued.profile) : null;
      const speakers = readSpeakers(db, job.bookId);
      const cast = speakers.map((c) => c.name);
      // the speakers this chapter likely needs, not the whole book's
      const listed = readChapterCast(db, job.bookId, job.chapterId, chapter.text);
      const template = queued?.prompt ?? BUILT_IN_PROMPT;
      const book = library.getBook(db, job.bookId);
      const recap = library.previousRecap(db, job.bookId, job.chapterId);
      const expressions = expressionNames(readEndpoints(db));
      // matched case-insensitively; unknown names are dropped, like unknown expression tags
      const lineEffects = lineEffectsOf(listEffects(db));
      const effectIds = new Map(lineEffects.map((e) => [e.name.trim().toLowerCase(), e.id]));
      const effectsOf = (names: readonly string[] = []): string[] => [
        ...new Set(names.flatMap((n) => effectIds.get(n.toLowerCase()) ?? [])),
      ];
      const varsFor = (i: number): PromptVars => ({
        book: {
          title: book?.title ?? "",
          author: book?.author ?? "",
          notes: queued?.prompt?.notes ?? "",
        },
        chapter: { title: chapter.title, number },
        part: i + 1,
        parts: chunks.length,
        cast: listed,
        excerpt: chunks[i],
        before: beforeOf(chunks, i),
        recap,
        endpoint: {
          name: queued?.profile.name ?? "",
          model: queued?.profile.model ?? "",
          notes: queued?.profile.prompt?.notes ?? "",
        },
        expressions,
        lineEffects,
      });
      library.setChapterScripting(db, job.bookId, job.chapterId, "running", 0);
      ctx.note("Scripting started", "info", {
        provider: provider.name,
        characters: chapter.text.length,
        ...(queued
          ? { profile: queued.profile.name, model: queued.profile.model, requests: chunks.length }
          : {}),
      });

      // per-chunk shares, so the bar never runs backwards when the next chunk starts counting
      const share = chunks.map(() => 0);
      let lastPct = -1;
      const report = (): void => {
        // a late report must not mark the chapter running again after settling
        if (signal.aborted) return;
        const pct = Math.round((share.reduce((a, b) => a + b, 0) / chunks.length) * 100);
        if (pct === lastPct) return;
        lastPct = pct;
        ctx.progress(pct);
        const at = library.locateChapter(db, chapter.uid);
        if (at) library.setChapterScripting(db, at.bookId, at.id, "running", pct);
      };
      // One object every write goes through, so the provider settling a request and the worker
      // counting it can't overwrite each other. Starts holding the chapter's whole worst case.
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
       * Chunk `i`'s money (`~/usage/dispatch`), priced against the stored profile or the run's copy
       * if it was removed. No profile (the fake) holds nothing.
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
       * Why the next request may not go out, or null. The book check includes this job's holds, so
       * it only trips when things changed under a run that fit; the daily limit checks this request.
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

      // Up to the profile's concurrency, answers kept in order. The first failure fails the
      // chapter: half a script is never written.
      const answers: ScriptAnswer[] = chunks.map(() => ({ lines: [] }));
      const stop = new AbortController();
      const onAbort = (): void => stop.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < chunks.length && !stop.signal.aborted && refused == null) {
          // budget stop: in-flight requests land and are paid for, then the job fails
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

      // Map aliases to the cast member (`castNameFor`), except names this answer calls a disguise:
      // those stay separate speakers for `learnCast` to make personas.
      const notes = answers.flatMap((a) => a.cast ?? []);
      const disguises = new Set(
        notes.filter((n) => n.personaOf || n.masked).map((n) => n.name.toLowerCase()),
      );
      const known = speakers.map((c) => ({
        name: c.name,
        aliases: c.aliases?.filter((a) => !disguises.has(a.toLowerCase())),
      }));
      const meant = (name: string) => castNameFor(name, known);

      // line and tag ids are renumbered 1..n across chunks
      let annotation = 0;
      const lines: Segment[] = answers
        .flatMap((a) => a.lines)
        .map((l, i) => {
          const effects = effectsOf(l.effects);
          return {
            id: i + 1,
            type: l.type,
            speaker: meant(l.speaker),
            text: l.text,
            direction: l.direction ?? "",
            ...(l.tags?.length
              ? { expressions: l.tags.map((t) => scriptedAnnotation(t, ++annotation)) }
              : {}),
            ...(effects.length ? { effects } : {}),
            audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
          };
        });
      const leftOff =
        answers
          .map((a) => a.recap)
          .filter(Boolean)
          .at(-1) ?? null;

      // One transaction: script, history version, new speakers. A failed or refused run never
      // gets here, so a good script is never pushed into history by an empty attempt.
      try {
        db.transaction((tx) => {
          const at = library.locateChapter(tx, chapter.uid);
          if (!at) throw notFound("The chapter was removed while it was being scripted");
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
          // after ensureSpeakers, so notes on new speakers have a row to land on
          const learnt = learnCast(
            tx,
            at.bookId,
            notes.map((n) => ({
              ...n,
              name: meant(n.name),
              ...(n.personaOf ? { personaOf: meant(n.personaOf) } : {}),
            })),
            new Set(added),
          );
          // a script without a recap clears the old one
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
      // `done` already wrote the status. Otherwise re-derive it, using the job row's chapter
      // number (it follows renumbering by cascade).
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
 * Queue one scripting job per chapter as one run. Excluded and busy chapters are skipped, not
 * refused. The whole run's worst case must fit the budget or nothing is queued (409); a paused book
 * refuses even free runs. The daily limit only refuses if it can't cover the first request.
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
  // Read once and kept on every job. An unknown profile is a 404 now; none at all is queued and
  // left to the provider (the real one refuses, the test fake scripts).
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

  const via = chosen?.name ?? "no profile";
  // resolved once, so the template it was priced with is the one it sends
  const prompt = chosen && {
    ...resolvePrompt({ library: readLibraryPrompt(db), profile: chosen.prompt, book: book.prompt }),
    notes: book.prompt?.notes ?? "",
  };
  // recent reasoning spend, added to the estimate only (the hold already uses the full ceiling)
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

  // Per chapter: worst case (chunked as the job will), expected cost, and the first request's hold.
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
      // same transaction as the row, so it can't land after the worker moved on
      ...(held ? { run: { scriptRun: held } } : {}),
      onCreated: (tx) => library.setChapterScripting(tx, bookId, id, "queued", 0),
    });
    jobs.push(job);
  });
  return { jobs, skipped, runId, chapters: library.listChapters(db, bookId) };
}
