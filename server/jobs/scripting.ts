// The scripting job: a chapter's prose in, an attributed script out. Finds the chapter by uid at
// write time (volumes renumber) and writes against the revision it started from; a result that
// would land on newer work goes into the chapter's history instead. Money rules: `~/usage/budget`.
// The prompt is resolved when queued (`resolvePrompt`); edits while it waits reach the next run.
import type {
  Book,
  Job,
  Profile,
  PromptTemplate,
  ReasoningEffort,
  ScriptingQueued,
  Segment,
  VersionOrigin,
} from "@/types";
import { castNameFor } from "@/lib/cast";
import { expressionNames, scriptedAnnotation } from "@/lib/expressions";
import {
  BUILT_IN_PROMPT,
  lineEffectsOf,
  renderPrompt,
  resolvePrompt,
  type PromptCastMember,
  type PromptVars,
} from "@/lib/prompt";
import { compareReading } from "@/lib/reading";
import { planRestore } from "@/lib/scriptHistory";
import { tokenEstimate } from "@/lib/scripting";
import { lexMatcher } from "@/lib/speech";
import {
  ensureSpeakers,
  learnCast,
  readChapterCast,
  readLexicon,
  readSpeakers,
  suggestTerms,
} from "~/db/cast";
import type { Db, Tx } from "~/db/client";
import { listEffects } from "~/db/effects";
import { capture, keepVersion } from "~/db/history";
import { readEndpoints, readProfiles } from "~/db/endpoints";
import { activeJob, getJob, nextRunId, setScriptRun } from "~/db/jobs";
import * as library from "~/db/library";
import { readLibraryPrompt } from "~/db/settings";
import { ScriptConflict, lineCount, readScript, replaceScript, scriptRevision } from "~/db/script";
import { plainText } from "~/epub/markdown";
import type { JobContext, JobHandler, Runner } from "~/jobs/runner";
import { conflict, notFound } from "~/lib/errors";
import { narrationInProgress, settleChapter } from "~/narration/chapter";
import { bookDelivery, lineReading } from "~/narration/cost";
import { BadAnswer, ChunkMisfit, repairPrompt } from "~/providers/chatScripting";
import type { GateLimits, SpeechGate } from "~/providers/gate";
import type { ScriptAnswer, ScriptRepair, ScriptingProvider } from "~/providers/scripting";
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
 * Who the model meant by a name (`castNameFor`): the cast plus the aliases this answer's notes
 * give. Names the answer calls a disguise stay their own speakers, for `learnCast` to make personas.
 */
function speakerOf(
  cast: readonly PromptCastMember[],
  notes: readonly PromptCastMember[],
): (name: string) => string {
  const disguises = new Set(
    notes.filter((n) => n.personaOf || n.masked).map((n) => n.name.toLowerCase()),
  );
  const known = cast.map((c) => ({ name: c.name, aliases: [...(c.aliases ?? [])] }));
  for (const n of notes) {
    if (!n.aliases?.length) continue;
    const name = castNameFor(n.name, known);
    let entry = known.find((c) => c.name === name);
    if (!entry) known.push((entry = { name: n.name, aliases: [] }));
    entry.aliases.push(...n.aliases);
  }
  for (const c of known) c.aliases = c.aliases.filter((a) => !disguises.has(a.toLowerCase()));
  return (name) => castNameFor(name, known);
}

/**
 * Clips follow lines whose words came back unchanged (`planRestore`, as a restore does); one whose
 * speaker, direction or reading moved goes stale. Everything else about the new lines is kept.
 */
function keepClips(tx: Tx, bookId: string, previous: Segment[], next: Segment[]): Segment[] {
  const deliveryOf = bookDelivery(tx, bookId);
  // the clip's own file says whose line it was
  const spoken = new Map(previous.flatMap((s) => (s.audio.url ? [[s.audio.url, s.speaker]] : [])));
  const plan = planRestore(previous, next, {
    drift: (s, a) => [
      ...(a.url && spoken.get(a.url) !== s.speaker ? ["speaker"] : []),
      ...compareReading(a, s, lineReading(tx, bookId, s, deliveryOf(s.speaker))),
    ],
    cast: new Set(),
    book: library.getBook(tx, bookId),
  });
  return next.map((s, i) => {
    const { audio, candidate, flag } = plan.segments[i];
    return { ...s, audio, ...(candidate ? { candidate } : {}), ...(flag ? { flag } : {}) };
  });
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

/** A repair copies words back, so it needs little thinking. */
const lighter = (r: ReasoningEffort | null | undefined): ReasoningEffort | null | undefined =>
  r === "medium" || r === "high" ? "low" : r;

const lineCountOf = (repair: ScriptRepair): string => {
  const n = repair.ranges.reduce((a, r) => a + r.to - r.from + 1, 0);
  return `${n} line${n === 1 ? "" : "s"}`;
};

export function scriptingHandler(provider: ScriptingProvider, gate: SpeechGate): JobHandler {
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
      const cast = readSpeakers(db, job.bookId).map((c) => c.name);
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
      // switched-off terms too: they are suggestions waiting to be checked
      const dictionary = lexMatcher(
        readLexicon(db, job.bookId).map((e) => ({ ...e, enabled: true })),
      );
      /** The dictionary's terms in a chunk, once each, as the chunk writes them. */
      const knownIn = (text: string): string[] => [
        ...new Map(dictionary.hits(text).map((h) => [h.term.toLowerCase(), h.term])).values(),
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
        ...(book?.pronounceOff ? {} : { pronounce: { known: knownIn(chunks[i]) } }),
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
      const dispatched = (i: number, repairing: boolean) =>
        run &&
        dispatch(db, {
          kind: "scripting",
          endpoint: run.profile,
          work: {
            bookId: job.bookId,
            chapterUid: chapter.uid,
            label: `Script chunk ${i + 1}${repairing ? " (repair)" : ""}`,
            queuedAt: job.queuedAt,
            reasoning: (repairing ? lighter(run.profile.reasoning) : run.profile.reasoning) ?? null,
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
       * Why chunk `i`'s request may not go out, or null. The book check includes this job's holds,
       * so it only trips when things changed under a run that fit; the daily limit checks this one.
       */
      const refusal = (i: number): string | null =>
        budgetProblem(db, job.bookId, {
          kind: "scripting",
          cost: run?.reserved ?? 0,
          jobId: job.id,
          what: "the next request",
          requests: run ? [{ endpoint: run.profile.id, cost: holds[i] }] : [],
        });
      let refused: string | null = null;

      // Every chunk waits its turn at the endpoint's slots, shared with other jobs; answers kept in
      // order. The first failure fails the chapter: half a script is never written.
      const answers: ScriptAnswer[] = chunks.map(() => ({ lines: [] }));
      const stop = new AbortController();
      const onAbort = (): void => stop.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      /** One request for chunk `i`, holding its own money; with `repair`, for a few lines back. */
      const ask = async (i: number, repair?: ScriptRepair): Promise<ScriptAnswer> => {
        const money = dispatched(i, !!repair);
        const prompt = renderPrompt(template, varsFor(i));
        try {
          return await provider.script({
            title: chapter.title,
            text: chunks[i],
            signal: stop.signal,
            target: repair && target ? { ...target, reasoning: lighter(target.reasoning) } : target,
            cast,
            prompt: repair ? repairPrompt(prompt, repair) : prompt,
            ...(repair ? { repair } : {}),
            ...(money ? { sent: (request: SentScript) => settle(money, request) } : {}),
            progress: (done, total) => {
              share[i] = total ? done / total : 1;
              report();
            },
          });
        } finally {
          money?.release();
        }
      };
      // a refusal takes the chunks still waiting out of the gate
      const waits = new AbortController();
      const waiting = AbortSignal.any([stop.signal, waits.signal]);
      /** Limits read on every acquire, so a change applies live; an unsaved profile uses its copy. */
      const slot = (): Promise<() => void> => {
        if (!queued) return Promise.resolve(() => {});
        const { id } = queued.profile;
        const limits = (): GateLimits => ({
          concurrency: (readProfiles(db).find((p) => p.id === id) ?? queued.profile).concurrency,
          enabled: true,
        });
        return gate.acquire(id, limits, { signal: waiting });
      };
      /** Chunk `i`, holding its slot through retries and repairs. */
      const scriptChunk = async (i: number): Promise<void> => {
        let leave: () => void;
        try {
          leave = await slot();
        } catch (e) {
          if (refused != null) return;
          throw e;
        }
        try {
          if (stop.signal.aborted || refused != null) return;
          // checked as the request goes out: in-flight ones land and are paid for, then the job fails
          refused = refusal(i);
          if (refused != null) {
            waits.abort();
            return;
          }
          if (run) run.active++;
          counted();
          try {
            // A bad answer is asked once more whole, as answers vary run to run; one with only a
            // few lines wrong first gets just those lines asked back. Each within the budget.
            let repair: ScriptRepair | undefined;
            let repaired = false;
            let again = true;
            for (;;) {
              try {
                answers[i] = await ask(i, repair);
                break;
              } catch (e) {
                if (!(e instanceof BadAnswer) || stop.signal.aborted || refusal(i) != null) throw e;
                repair = !repaired && e instanceof ChunkMisfit ? e.repair : undefined;
                if (repair) repaired = true;
                else if (again) again = false;
                else throw e;
                const which =
                  chunks.length > 1 ? `Answer ${i + 1} of ${chunks.length}` : "The answer";
                ctx.note(
                  repair
                    ? `${which} was refused; asking for ${lineCountOf(repair)} back, fixed`
                    : `${which} was refused; asking once more`,
                  "warning",
                  { error: e.message },
                );
                share[i] = 0;
                if (run) run.reserved += holds[i];
                counted();
              }
            }
          } catch (e) {
            if (signal.aborted) throw e;
            // the failed-chapter page offers "Smaller chunks" on this detail
            if (e instanceof ChunkMisfit)
              ctx.note("A smaller chunk may script where this one failed", "info", {
                smallerChunks: 1,
              });
            if (chunks.length === 1) throw e;
            throw new Error(
              `Request ${i + 1} of ${chunks.length} failed: ${e instanceof Error ? e.message : String(e)}`,
              { cause: e },
            );
          } finally {
            if (run) run.active--;
          }
          share[i] = 1;
          if (run) run.completed++;
          counted();
          report();
          if (answers[i].patched)
            ctx.note(
              `${answers[i].patched} words put back from the book where the model left out or changed them`,
              "info",
            );
          if (chunks.length > 1)
            ctx.note(`Request ${i + 1} of ${chunks.length} answered`, "info", {
              characters: chunks[i].length,
              lines: answers[i].lines.length,
            });
        } finally {
          leave();
        }
      };
      try {
        // FIFO slots, so chunks go out in order
        await Promise.all(chunks.map((_, i) => scriptChunk(i)));
      } catch (e) {
        stop.abort(e);
        throw e;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) throw signal.reason;
      if (refused != null) throw new Error(refused);

      const notes = answers.flatMap((a) => a.cast ?? []);
      // line and tag ids are renumbered 1..n across chunks; speakers as the model wrote them
      let annotation = 0;
      const scripted: Segment[] = answers
        .flatMap((a) => a.lines)
        .map((l, i) => {
          const effects = effectsOf(l.effects);
          return {
            id: i + 1,
            type: l.type,
            speaker: l.speaker,
            text: l.text,
            direction: l.direction ?? "",
            ...(l.tags?.length
              ? { expressions: l.tags.map((t) => scriptedAnnotation(t, ++annotation)) }
              : {}),
            ...(effects.length ? { effects } : {}),
            ...(l.mended ? { mended: l.mended } : {}),
            audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
          };
        });
      // the model's own order where lines were put back in the book's, kept for History
      let base = 0;
      const modelOrder = answers.flatMap((a) => {
        const at = base;
        base += a.lines.length;
        return (a.reordered?.modelOrder ?? a.lines.map((_, k) => k)).map((k) => k + at);
      });
      const moved = answers.reduce((n, a) => n + (a.reordered?.moved ?? 0), 0);
      const leftOff =
        answers
          .map((a) => a.recap)
          .filter(Boolean)
          .at(-1) ?? null;
      const origin = (again: boolean, moved = 0): VersionOrigin => ({
        kind: "scripted",
        profile: queued?.profile.name ?? provider.name,
        ...(queued ? { model: provider.callsProfile ? queued.profile.model : provider.name } : {}),
        again,
        ...(moved ? { moved } : {}),
        ...(queued?.prompt ? { prompt: queued.prompt.origin } : {}),
      });
      /** Speakers matched against the cast as it stands now, so a merge during the run holds. */
      const matched = (tx: Tx, bookId: string) => {
        const meant = speakerOf(readSpeakers(tx, bookId), notes);
        return { meant, lines: scripted.map((l) => ({ ...l, speaker: meant(l.speaker) })) };
      };

      // One transaction: script, history version, new speakers. A failed or refused run never
      // gets here, so a good script is never pushed into history by an empty attempt.
      try {
        db.transaction((tx) => {
          const at = library.locateChapter(tx, chapter.uid);
          if (!at) throw notFound("The chapter was removed while it was being scripted");
          const { meant, lines } = matched(tx, at.bookId);
          const previous = readScript(tx, at.bookId, at.id);
          const segs = keepClips(
            tx,
            at.bookId,
            previous,
            checkSiteText(tx, at.bookId, at.id, lines),
          );
          noteSiteText(ctx, segs, book);
          const { revision } = replaceScript(tx, at.bookId, at.id, segs, {
            ifRevision: chapter.revision,
          });
          const version = capture(
            tx,
            at.bookId,
            at.id,
            origin(previous.length > 0),
            previous,
            segs,
          );
          const asModel =
            moved && segs.length === modelOrder.length
              ? keepVersion(
                  tx,
                  at.bookId,
                  at.id,
                  origin(previous.length > 0, moved),
                  modelOrder.map((k) => segs[k]),
                )
              : null;
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
          const suggested = book?.pronounceOff
            ? []
            : suggestTerms(
                tx,
                at.bookId,
                answers.flatMap((a) => a.pronounce ?? []),
              );
          // a script without a recap clears the old one
          library.setChapterRecap(tx, at.bookId, at.id, leftOff);
          library.setChapterScripting(tx, at.bookId, at.id, "done", 100);
          const narrated = library.getChapter(tx, at.bookId, at.id)?.narration !== "none";
          if (narrated && !narrationInProgress(tx, at.bookId, at.id))
            settleChapter(tx, at.bookId, at.id);
          ctx.note("Script written", "info", {
            lines: segs.length,
            speakers: new Set(segs.map((s) => s.speaker)).size,
            revision,
            ...(added.length ? { speakersAdded: added.join(", ") } : {}),
            ...(learnt.length ? { speakersFilledIn: learnt.join(", ") } : {}),
            ...(suggested.length ? { termsSuggested: suggested.join(", ") } : {}),
            ...(leftOff ? { recap: leftOff } : {}),
            ...(version != null ? { preserved: `v${version}` } : {}),
            ...(asModel != null ? { putBack: moved, modelOrder: `v${asModel}` } : {}),
            ...(at.id !== job.chapterId ? { chapterNow: at.id } : {}),
          });
        });
      } catch (e) {
        if (!(e instanceof ScriptConflict)) throw e;
        // newer work stands, but the run was paid for: keep it where a restore can reach it
        const kept = db.transaction((tx) => {
          const at = library.locateChapter(tx, chapter.uid);
          return (
            at && keepVersion(tx, at.bookId, at.id, origin(true), matched(tx, at.bookId).lines)
          );
        });
        throw conflict(
          kept == null
            ? e.message
            : `The chapter's script changed while this ran, so the result was kept in its history as v${kept}`,
        );
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
  runner: Pick<Runner, "enqueue">,
  bookId: string,
  ids: readonly number[],
  profile?: string,
): ScriptingQueued {
  const book = library.getBook(db, bookId);
  if (!book) throw notFound("No such book");
  if (library.inReview(book, ids))
    throw conflict("Finish the contents review before scripting this book");
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
  // reading order, however the chapters were ticked: each run reads the recap of the one before
  for (const id of [...ids].sort((a, b) => a - b)) {
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
