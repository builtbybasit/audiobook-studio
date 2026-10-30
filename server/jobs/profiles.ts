// Cast profiles: `facts` jobs read the original prose for character facts and evidence; the
// book's `profiles` job rewrites every stale profile once its scripting and fact reading are done.
import * as v from "valibot";

import type { Job } from "@/types";
import { chapterCast, castNameFor, FACT_KINDS, NARRATOR } from "@/lib/cast";
import { chapterNumbers } from "@/lib/chapterNumber";
import { tokenEstimate } from "@/lib/scripting";
import { noUsage, rewriteProfiles, staleProfiles, tally } from "~/cast/profiles";
import { groundedFacts } from "~/cast/facts";
import { numberedParagraphs, paragraphsIn, sourceParagraphs } from "@/lib/sourceParagraphs";
import { plainText } from "~/epub/markdown";
import { chunksOf, beforeOf } from "~/script/chunks";
import { readCast } from "~/db/cast";
import type { Db } from "~/db/client";
import { readProfiles } from "~/db/endpoints";
import { replaceChapterFacts, type NewFact } from "~/db/facts";
import * as queue from "~/db/jobs";
import * as library from "~/db/library";
import { readScript } from "~/db/script";
import type { JobContext, JobHandler, Runner } from "~/jobs/runner";
import { notFound } from "~/lib/errors";
import { FACT_MAX, factsOf } from "~/providers/chatScripting";
import { ProviderError } from "~/providers/http";
import type { SpeechGate } from "~/providers/gate";
import type { ScriptingProvider } from "~/providers/scripting";
import { scriptTarget } from "~/providers/target";
import { assertWithinBudget } from "~/usage/budget";
import { dispatch } from "~/usage/dispatch";

/** Queued once per book: a second call while one waits returns it (the scripting endpoint stays the first's). */
export function enqueueProfiles(db: Db, bookId: string, profile: string): void {
  queue.enqueueJob(db, {
    kind: "profiles",
    bookId,
    chapterId: null,
    label: "Cast profiles",
    run: { profilesRun: { profile } },
  });
}

export function profilesHandler(provider: ScriptingProvider, gate: SpeechGate): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      const profile = job.profilesRun?.profile ?? "";
      const names = staleProfiles(db, job.bookId);
      if (!names.length) {
        ctx.note("No profile needs rewriting", "info");
        return;
      }
      ctx.note("Rewriting profiles", "info", { speakers: names.length });
      const run: NonNullable<Job["profilesRun"]> = {
        profile,
        speakers: names.length,
        usage: noUsage(),
      };
      queue.setCastRun(db, job.id, { profilesRun: run });
      const { rewritten, failed } = await rewriteProfiles(
        db,
        provider,
        job.bookId,
        profile,
        names,
        signal,
        (done, total) => {
          ctx.progress((done / total) * 100);
          queue.setCastRun(db, job.id, { profilesRun: run });
        },
        run.usage,
        gate,
      );
      queue.setCastRun(db, job.id, {
        profilesRun: {
          ...run,
          rewritten: rewritten.length,
          ...(failed.length ? { failed } : {}),
        },
      });
      ctx.note("Profiles rewritten", failed.length ? "warning" : "info", {
        rewritten: rewritten.length,
        ...(failed.length ? { failed: failed.join(", ") } : {}),
      });
      if (failed.length)
        throw new Error(
          `${failed.length} profile${failed.length === 1 ? "" : "s"} could not be rewritten`,
        );
    },

    // facts that landed while this ran found it live, so their enqueue came back to it
    onSettled(ctx, status) {
      const { db, job } = ctx;
      if (status === "done" && job.profilesRun && staleProfiles(db, job.bookId).length)
        enqueueProfiles(db, job.bookId, job.profilesRun.profile);
    },
  };
}

// the rules the scripting prompt gives its cast notes' facts, in the same words
const SYSTEM = [
  "You read one chapter of a novel, its paragraphs labelled [P#], and note what it tells about some of its characters, speaking or not.",
  'For each character named, "facts": lasting things the chapter states or clearly shows about them, one trait each: {"kind": "role", "background", "relationship", "personality" or "voice", "text": one short sentence, "sourceIds": the [P#] numbers of the 1–5 paragraphs that show it}.',
  "How they act in one scene, such as whispering while hiding, is a direction, not a fact. A fact someone tells about another belongs to that other. Never guess. [] when there are none.",
  "Previous prose is context only: cite the chapter's paragraphs.",
  "Answer only with the JSON object, one entry per character, named as given.",
].join("\n");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["speakers"],
  properties: {
    speakers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "facts"],
        properties: {
          speaker: { type: "string" },
          facts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "text", "sourceIds"],
              properties: {
                kind: { type: "string", enum: [...FACT_KINDS] },
                text: { type: "string" },
                sourceIds: {
                  type: "array",
                  items: { type: "integer", minimum: 1 },
                  minItems: 1,
                  maxItems: 5,
                },
              },
            },
          },
        },
      },
    },
  },
};

const Said = v.looseObject({ speaker: v.string(), facts: v.array(v.unknown()) });

class InvalidFacts extends Error {}

/**
 * The asked-about speakers' facts that cite paragraphs of this part, and how many were dropped for
 * not doing so. A reply without the list, a speaker or any cited fact throws: the facts stay.
 */
function factsIn(
  said: unknown,
  speakers: ReadonlySet<string>,
  source: string,
  allowedIds: ReadonlySet<number>,
): { facts: NewFact[]; dropped: number } {
  const list = (said as { speakers?: unknown } | null)?.speakers;
  if (!Array.isArray(list)) throw new InvalidFacts("The model did not return character facts");
  const answered = new Set<string>();
  const facts: NewFact[] = [];
  let dropped = 0;
  for (const item of list) {
    const read = v.safeParse(Said, item);
    if (!read.success) continue;
    const speaker = castNameFor(
      read.output.speaker.trim(),
      [...speakers].map((name) => ({ name })),
    );
    if (!speakers.has(speaker)) continue;
    answered.add(speaker);
    const all = factsOf(read.output.facts);
    const grounded = groundedFacts(
      all.filter((f) => f.sourceIds?.length),
      source,
      allowedIds,
    );
    dropped += all.length - grounded.length;
    facts.push(...grounded.map((f) => ({ speaker, ...f })));
  }
  if ([...speakers].some((s) => !answered.has(s)))
    throw new InvalidFacts("The model left out a requested character; existing facts were kept");
  if (dropped && !facts.length)
    throw new InvalidFacts(
      "No fact cited a paragraph of this chapter. Cite only the [P#] numbers under Original prose",
    );
  return { facts, dropped };
}

/** Deterministic, source-backed sample for offline runs. */
function simulatedFacts(
  source: string,
  speakers: readonly string[],
  allowedIds: ReadonlySet<number>,
) {
  return {
    speakers: speakers.map((speaker) => {
      const paragraph = sourceParagraphs(source).find(
        (p) => allowedIds.has(p.id) && p.text.includes(speaker),
      );
      return {
        speaker,
        facts: paragraph
          ? [{ kind: "role", text: paragraph.text.slice(0, FACT_MAX), sourceIds: [paragraph.id] }]
          : [],
      };
    }),
  };
}

function sourceOf(db: Db, bookId: string, chapterId: number): string {
  const body = library.getChapterBody(db, bookId, chapterId);
  if (body == null) throw notFound("The chapter has no original prose");
  return plainText(body);
}

/** Names/aliases mentioned in prose plus existing speakers for implicit references. */
function speakersOf(db: Db, bookId: string, chapterId: number, source: string, major: boolean) {
  const recent = new Set(readScript(db, bookId, chapterId).map((s) => s.speaker));
  return chapterCast(readCast(db, bookId), source, recent).filter(
    (c) => c.name !== NARRATOR && c.name !== "Unknown" && (!major || c.major),
  );
}

/** The same bounded source context is used for execution and the budget estimate. */
function factRequests(
  db: Db,
  bookId: string,
  chapterId: number,
  source: string,
  p: Parameters<typeof chunksOf>[1],
  major: boolean,
) {
  const previous = plainText(library.previousChapterBody(db, bookId, chapterId)).slice(-6000);
  const cast = speakersOf(db, bookId, chapterId, `${previous}\n${source}`, major);
  const speakers = cast.map((c) => c.name);
  const names = cast
    .map((c) => c.name + (c.aliases.length ? ` (also called ${c.aliases.join(", ")})` : ""))
    .join(", ");
  const chunks = chunksOf(source, p);
  return {
    speakers,
    requests: (speakers.length ? chunks : []).map((chunk, index) => {
      const before = [previous, beforeOf(chunks, index)].filter(Boolean).join("\n\n");
      const offset = chunks.slice(0, index).join("").length;
      return {
        chunk,
        allowedIds: new Set(paragraphsIn(source, offset, chunk.length).map((p) => p.id)),
        user: `Characters: ${names}\n\n${before ? `Previous prose (context only):\n${before}\n\n` : ""}Original prose:\n${numberedParagraphs(source, offset, chunk.length)}`,
      };
    }),
  };
}

export function factsHandler(provider: ScriptingProvider): JobHandler {
  return {
    async run(ctx: JobContext): Promise<void> {
      const { job, db, signal } = ctx;
      if (job.chapterId == null) throw new Error("Reading facts is for one chapter");
      const uid = library.chapterUid(db, job.bookId, job.chapterId);
      if (uid == null) throw notFound("The chapter no longer exists");
      const queued = job.factsRun;
      const p = readProfiles(db).find((x) => x.id === queued?.profile);
      if (!queued || !p)
        throw new Error(`There is no scripting endpoint “${queued?.profile ?? ""}”`);
      if (!provider.ask) throw new Error(`${provider.name} cannot read cast facts`);

      const source = sourceOf(db, job.bookId, job.chapterId);
      const { speakers, requests } = factRequests(
        db,
        job.bookId,
        job.chapterId,
        source,
        p,
        queued.major,
      );
      let facts: NewFact[] = [];
      const usage = noUsage();
      for (const { allowedIds, user } of requests) {
        let correction = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          const prompt = user + correction;
          const reserve = tokenEstimate(SYSTEM + prompt, p).reserve;
          assertWithinBudget(db, job.bookId, {
            kind: "scripting",
            cost: reserve,
            jobId: job.id,
            what: "reading this chapter's facts",
            requests: [{ endpoint: p.id, cost: reserve }],
          });
          const money = dispatch(db, {
            kind: "scripting",
            endpoint: p,
            work: {
              bookId: job.bookId,
              chapterUid: uid,
              label: "Cast facts",
              queuedAt: job.queuedAt,
            },
            hold: reserve,
          });
          try {
            const said = await provider.ask({
              system: SYSTEM,
              user: prompt,
              schema: SCHEMA,
              target: scriptTarget(db, p),
              signal,
              sent: (report) => tally(usage, report, money.sent(report)),
              simulated: simulatedFacts(source, speakers, allowedIds),
            });
            const read = factsIn(said, new Set(speakers), source, allowedIds);
            facts.push(...read.facts);
            if (read.dropped)
              ctx.note("Facts without a paragraph of this chapter dropped", "warning", {
                dropped: read.dropped,
              });
            break;
          } catch (e) {
            if (signal.aborted) throw signal.reason;
            if (e instanceof InvalidFacts && attempt === 0) {
              correction = `\n\nYour last reply failed validation: ${e.message}. Return every speaker; facts: [] when none.`;
              ctx.note("Retrying invalid character facts", "warning", { reason: e.message });
              continue;
            }
            if (e instanceof ProviderError) throw new Error(e.message, { cause: e });
            throw e;
          } finally {
            money.release();
            // kept when the request failed, too
            queue.setCastRun(db, job.id, {
              factsRun: { ...queued, speakers: speakers.length, usage },
            });
          }
        }
      }
      // the chapter's lane keeps a re-script out while this runs; major only keeps the others'
      const saved = db.transaction((tx) => {
        const at = library.locateChapter(tx, uid);
        if (at && plainText(library.getChapterBody(tx, at.bookId, at.id) ?? "") !== source)
          throw new Error("The chapter source changed while facts were read; refresh again");
        return at
          ? replaceChapterFacts(tx, at.bookId, at.id, facts, queued.major ? speakers : undefined)
          : 0;
      });
      queue.setCastRun(db, job.id, {
        factsRun: { ...queued, speakers: speakers.length, facts: saved, usage },
      });
      ctx.note("Facts read", "info", { speakers: speakers.length, facts: saved });
      if (staleProfiles(db, job.bookId).length) enqueueProfiles(db, job.bookId, p.id);
    },
  };
}

/**
 * One facts job per scripted kept chapter whose reading number is in `from`..`to` (all when not
 * given), as one run; a chapter already being read is skipped. The initial requests must fit
 * the budget or nothing is queued; any correction is checked again before sending. Returns how many were queued.
 */
export function enqueueFacts(
  db: Db,
  runner: Pick<Runner, "enqueue">,
  bookId: string,
  request: { profile: string; from?: number; to?: number; chapters?: number[]; major?: boolean },
): number {
  if (!library.getBook(db, bookId)) throw notFound("No such book");
  const p = readProfiles(db).find((x) => x.id === request.profile);
  if (!p) throw notFound(`There is no scripting endpoint “${request.profile}”`);
  const chapters = library.listChapters(db, bookId);
  const numbers = chapterNumbers(chapters);
  const { from = 1, to = Infinity, major = false } = request;
  const only = request.chapters && new Set(request.chapters);
  const targets = chapters.filter((c) => {
    const n = numbers.get(c.id);
    return (
      n != null &&
      n >= from &&
      n <= to &&
      (!only || only.has(c.id)) &&
      c.scripting === "done" &&
      !queue.activeJob(db, "facts", bookId, c.id)
    );
  });
  const holds = targets.map((c) => {
    const source = sourceOf(db, bookId, c.id);
    const { requests } = factRequests(db, bookId, c.id, source, p, major);
    return requests.reduce((sum, { user }) => sum + tokenEstimate(SYSTEM + user, p).reserve, 0);
  });
  if (targets.length)
    assertWithinBudget(db, bookId, {
      kind: "scripting",
      cost: holds.reduce((a, b) => a + b, 0),
      requests: [{ endpoint: p.id, cost: holds[0] }],
    });
  const runId = queue.nextRunId(db);
  for (const [i, c] of targets.entries())
    runner.enqueue({
      kind: "facts",
      bookId,
      chapterId: c.id,
      label: "Cast facts",
      bulk: { id: runId, op: "Refresh facts", index: i + 1, total: targets.length },
      run: { factsRun: { profile: request.profile, major } },
    });
  return targets.length;
}
