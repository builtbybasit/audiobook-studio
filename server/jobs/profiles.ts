// Cast profiles: `facts` jobs read a scripted chapter again for its speakers' facts, and the
// book's `profiles` job rewrites every stale profile once its scripting and fact reading are done.
import * as v from "valibot";

import type { Job, Segment } from "@/types";
import { FACT_KINDS, NARRATOR } from "@/lib/cast";
import { chapterNumbers } from "@/lib/chapterNumber";
import { tokenEstimate } from "@/lib/scripting";
import { noUsage, rewriteProfiles, staleProfiles, tally } from "~/cast/profiles";
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

export function profilesHandler(provider: ScriptingProvider): JobHandler {
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
  "You read one chapter of a novel, already split into lines by speaker, and note what it tells about some of its speakers.",
  'For each speaker named, "facts": lasting things the chapter states or clearly shows about them, each {"kind": "role", "background", "relationship", "personality" or "voice", "text": one short sentence}.',
  "How they act in one scene, such as whispering while hiding, is a direction, not a fact. Never guess. [] when there are none.",
  "Answer only with the JSON object, one entry per speaker, named as given.",
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
              required: ["kind", "text"],
              properties: {
                kind: { type: "string", enum: [...FACT_KINDS] },
                text: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

const Said = v.looseObject({ speaker: v.string(), facts: v.unknown() });

/** The asked-about speakers' readable facts, by the scripting notes' rules (`factsOf`). */
function factsIn(said: unknown, speakers: ReadonlySet<string>): NewFact[] {
  const list = (said as { speakers?: unknown } | null)?.speakers;
  return (Array.isArray(list) ? list : []).flatMap((item) => {
    const read = v.safeParse(Said, item);
    const speaker = read.success ? read.output.speaker.trim() : "";
    return read.success && speakers.has(speaker)
      ? factsOf(read.output.facts).map((f) => ({ speaker, ...f }))
      : [];
  });
}

/** What a simulated profile answers: each speaker's first narration naming them, as their role. */
function simulatedFacts(segs: readonly Segment[], speakers: readonly string[]) {
  return {
    speakers: speakers.map((speaker) => {
      const said = segs.find((s) => s.type === "narration" && s.text.includes(speaker));
      return { speaker, facts: said ? [{ kind: "role", text: said.text.slice(0, FACT_MAX) }] : [] };
    }),
  };
}

/** The chapter's script as the model reads it; site text and notes are not the story. */
const scriptText = (segs: readonly Segment[]): string =>
  segs
    .filter((s) => s.type !== "watermark" && s.type !== "note")
    .map((s) => `${s.speaker}${s.type === "thought" ? " (thinks)" : ""}: ${s.text}`)
    .join("\n");

/** Who a facts job asks about: the chapter's speakers but the Narrator, majors only if asked. */
function speakersOf(db: Db, bookId: string, segs: readonly Segment[], major: boolean): string[] {
  const here = new Set(segs.map((s) => s.speaker));
  return readCast(db, bookId)
    .filter((c) => c.name !== NARRATOR && here.has(c.name) && (!major || c.major))
    .map((c) => c.name);
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

      const segs = readScript(db, job.bookId, job.chapterId);
      const speakers = speakersOf(db, job.bookId, segs, queued.major);
      let facts: NewFact[] = [];
      const usage = noUsage();
      if (speakers.length) {
        const user = `Speakers: ${speakers.join(", ")}\n\nThe chapter:\n${scriptText(segs)}`;
        // ponytail: one request per chapter; split with `chunksOf` if chapters outgrow a model
        const reserve = tokenEstimate(SYSTEM + user, p).reserve;
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
            user,
            schema: SCHEMA,
            target: scriptTarget(db, p),
            signal,
            sent: (report) => tally(usage, report, money.sent(report)),
            simulated: simulatedFacts(segs, speakers),
          });
          facts = factsIn(said, new Set(speakers));
        } catch (e) {
          if (signal.aborted) throw signal.reason;
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
      // the chapter's lane keeps a re-script out while this runs; major only keeps the others'
      const saved = db.transaction((tx) => {
        const at = library.locateChapter(tx, uid);
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
 * given), as one run; a chapter already being read is skipped. The whole run's worst case must fit
 * the budget or nothing is queued. Returns how many were queued.
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
  const holds = targets.map(
    (c) => tokenEstimate(SYSTEM + scriptText(readScript(db, bookId, c.id)), p).reserve,
  );
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
