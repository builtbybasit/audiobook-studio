// The queue: the same work is never queued twice, a cancel stops it, a restart finds it again, and
// a result never lands on top of newer work.
//
// Every test drives the real runner against the real routes with a provider that reads the prose
// and never the network. Where a run has to be genuinely in flight — to be cancelled, edited under
// or renumbered — the provider is `gatedProvider`, which holds the door until the test says so, so
// nothing here waits on a timer.
import { describe, expect, test } from "bun:test";

import type { Book, Chapter, Job, Segment } from "@/types";
import * as queue from "~/db/jobs";
import { readScript, writeScript } from "~/db/script";
import { jobs } from "~/db/schema";
import { epubFile, story } from "../support/epub";
import {
  collectingLogger,
  gatedProvider,
  jsonBody,
  testApi,
  testDb,
  testRunner,
} from "../support/server";

interface ImportResult {
  book: Book;
  chapters: Chapter[];
}
interface Queued {
  jobs: Job[];
  skipped: { id: number; why: string }[];
  runId: number;
  chapters: Chapter[];
}
interface ScriptResult {
  segments: Segment[];
  revision: number;
}
interface Failure {
  error: { code: string; message: string; detail?: string };
}

const dialogue = () => [
  "The ledger lay open on the table. “We are short again,” said Mara.",
  "Rain ran down the shutters while she counted. Nobody answered her.",
  ...story(),
];

/** A book on the shelf, its review done, ready for work. */
async function shelved(api = testApi(), titles = ["One", "Two", "Three"]) {
  const { body } = await api.import<ImportResult>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: titles.map((title) => ({ title, paragraphs: dialogue() })),
    }),
  );
  await api.request(`/api/books/${body.book.id}/confirm`, { method: "POST" });
  return { api, id: body.book.id };
}

const script = (api: ReturnType<typeof testApi>, id: string, ids: number[]) =>
  api.request<Queued>(`/api/books/${id}/chapters/script`, jsonBody({ ids }));

const chaptersOf = async (api: ReturnType<typeof testApi>, id: string) =>
  (await api.request<ImportResult>(`/api/books/${id}`)).body.chapters;

const jobById = async (api: ReturnType<typeof testApi>, id: number) =>
  (await api.request<{ job: Job }>(`/api/jobs/${id}`)).body.job;

describe("scripting a chapter through the queue", () => {
  test("queues one job per chapter as one run, and the chapters say so", async () => {
    const { api, id } = await shelved();
    const { status, body } = await script(api, id, [1, 2]);
    expect(status).toBe(202);
    expect(body.jobs.map((j) => j.chapterId)).toEqual([1, 2]);
    expect(body.jobs.map((j) => j.bulk)).toEqual([
      { id: body.runId, op: "Script", index: 1, total: 2 },
      { id: body.runId, op: "Script", index: 2, total: 2 },
    ]);
    expect(body.skipped).toEqual([]);
    // the first is already running — the worker starts as soon as it is asked — and the second waits
    expect(body.chapters.map((c) => c.scripting)).toEqual(["running", "queued", "none"]);
  });

  test("writes a script the reader can open, attributed from the prose", async () => {
    const { api, id } = await shelved();
    await script(api, id, [1]);
    await api.runner.idle();

    const [c1] = await chaptersOf(api, id);
    expect(c1.scripting).toBe("done");
    expect(c1.scriptingProgress).toBe(100);
    const { body } = await api.request<ScriptResult>(`/api/books/${id}/chapters/1/script`);
    expect(body.revision).toBe(1);
    expect(body.segments[0].type).toBe("narration");
    expect(body.segments[0].speaker).toBe("Narrator");
    const said = body.segments.find((s) => s.type === "dialogue");
    expect(said?.speaker).toBe("Mara");
    expect(said?.text).toBe("We are short again,");
    // a line always carries an audio object, even before anything has been rendered
    expect(body.segments.every((s) => s.audio.status === "none")).toBe(true);

    const job = await jobById(
      api,
      (await api.request<{ jobs: Job[] }>("/api/jobs")).body.jobs[0].id,
    );
    expect(job.status).toBe("done");
    expect(job.activity?.map((e) => e.message)).toEqual([
      "Job queued",
      "Job started",
      "Scripting started",
      "Script written",
      "Job done",
    ]);
  });

  test("a chapter that is skipped for the audiobook is left out and said so", async () => {
    const { api, id } = await shelved();
    await api.request(`/api/books/${id}/chapters/skip`, jsonBody({ ids: [2] }));
    const { body } = await script(api, id, [1, 2, 9]);
    expect(body.jobs.map((j) => j.chapterId)).toEqual([1]);
    expect(body.skipped).toEqual([
      { id: 2, why: "excluded" },
      { id: 9, why: "missing" },
    ]);
  });

  test("a book still in its contents review has nothing to script", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "One", paragraphs: story() }] }),
    );
    const refused = await api.request<Failure>(
      `/api/books/${body.book.id}/chapters/script`,
      jsonBody({ ids: [1] }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("conflict");
  });

  test("a re-script replaces the script and moves the revision on", async () => {
    const { api, id } = await shelved();
    await script(api, id, [1]);
    await api.runner.idle();
    const { body: again } = await script(api, id, [1]);
    expect(again.jobs[0].label).toStartWith("Re-script");
    await api.runner.idle();
    const { body } = await api.request<ScriptResult>(`/api/books/${id}/chapters/1/script`);
    expect(body.revision).toBe(2);
  });
});

describe("the same work is never queued twice", () => {
  test("asking again while a chapter is being scripted hands back the job already doing it", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const first = await script(api, id, [1]);
    await gate.started;
    const second = await script(api, id, [1, 2]);
    // chapter 1 is busy: not queued twice, and the caller is told why
    expect(second.body.skipped).toEqual([{ id: 1, why: "busy" }]);
    expect(second.body.jobs.map((j) => j.chapterId)).toEqual([2]);
    gate.release();
    await api.runner.idle();
    expect((await api.request<{ jobs: Job[] }>("/api/jobs")).body.jobs).toHaveLength(2);
    expect((await jobById(api, first.body.jobs[0].id)).status).toBe("done");
  });

  test("the queue itself is idempotent on the work, not on the request", () => {
    const db = testDb();
    const input = { kind: "scripting" as const, bookId: "b", chapterId: 1, label: "Script" };
    // a job row for a book that does not exist is refused by the schema, so give it one
    db.run(
      "insert into books (id, title, author, cover_from, cover_to, added_at) values ('b','B','A','#000','#111',0)",
    );
    db.run(
      "insert into chapters (book_id, id, uid, volume_id, volume_index, title, words) values ('b',1,'u1',1,1,'One',3)",
    );
    const a = queue.enqueueJob(db, input);
    const b = queue.enqueueJob(db, input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    // and the database holds the rule, not only this function: a second live row cannot exist
    expect(() =>
      db
        .insert(jobs)
        .values({
          ...input,
          status: "queued",
          queuedAt: 0,
          activeKey: queue.activeKey("scripting", "b", 1),
        })
        .run(),
    ).toThrow(/UNIQUE/);
    // once finished, the key is released and the same work can be asked for again
    queue.finishJob(db, a.job.id, "done");
    expect(queue.enqueueJob(db, input).created).toBe(true);
  });
});

describe("cancelling", () => {
  test("a queued job never starts, and its chapter goes back to having no script", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const { body } = await script(api, id, [1, 2]);
    await gate.started;
    const waiting = body.jobs[1];
    const cancelled = await api.request<{ job: Job; was: string }>(
      `/api/jobs/${waiting.id}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.body.was).toBe("queued");
    expect(cancelled.body.job.status).toBe("cancelled");
    expect(cancelled.body.job.finishedAt).not.toBeNull();
    gate.release();
    await api.runner.idle();
    const chapters = await chaptersOf(api, id);
    expect(chapters[0].scripting).toBe("done");
    expect(chapters[1].scripting).toBe("none");
    expect(readScript(api.db, id, 2)).toEqual([]);
  });

  test("a running job is stopped, writes nothing, and settles as cancelled", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const { body } = await script(api, id, [1]);
    await gate.started;
    expect(api.runner.running?.id).toBe(body.jobs[0].id);

    const cancelled = await api.request<{ was: string }>(`/api/jobs/${body.jobs[0].id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.body.was).toBe("running");
    await api.runner.idle();
    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("cancelled");
    expect(job.cancelled).toBe(true);
    expect((await chaptersOf(api, id))[0].scripting).toBe("none");
    expect(readScript(api.db, id, 1)).toEqual([]);
    // the queue moved on: nothing is running and the runner is idle
    expect(api.runner.running).toBeNull();
  });

  test("a cancelled re-script leaves the script it was replacing, reading as done", async () => {
    const { api, id } = await shelved();
    await script(api, id, [1]);
    await api.runner.idle();
    const gate = gatedProvider();
    const slow = testRunner(api.db, collectingLogger().log, { scripting: gate.provider });
    const { job } = slow.enqueue({
      kind: "scripting",
      bookId: id,
      chapterId: 1,
      label: "Re-script",
    });
    await gate.started;
    slow.cancel(job.id);
    await slow.idle();
    expect(queue.getJob(api.db, job.id)?.status).toBe("cancelled");
    expect((await chaptersOf(api, id))[0].scripting).toBe("done");
    expect(readScript(api.db, id, 1).length).toBeGreaterThan(0);
  });

  test("a finished job cannot be cancelled, and a live one cannot be removed", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const { body } = await script(api, id, [1]);
    await gate.started;
    const live = await api.request<Failure>(`/api/jobs/${body.jobs[0].id}`, { method: "DELETE" });
    expect(live.status).toBe(409);
    gate.release();
    await api.runner.idle();
    const done = await api.request<{ was: string }>(`/api/jobs/${body.jobs[0].id}/cancel`, {
      method: "POST",
    });
    expect(done.body.was).toBe("finished");
    const removed = await api.request<{ removed: number }>(`/api/jobs/${body.jobs[0].id}`, {
      method: "DELETE",
    });
    expect(removed.body.removed).toBe(body.jobs[0].id);
    expect((await api.request<Failure>(`/api/jobs/${body.jobs[0].id}`)).status).toBe(404);
  });
});

describe("a result never lands on newer work", () => {
  test("a script written while the job ran is kept, and the job says why it wrote nothing", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const { body } = await script(api, id, [1]);
    await gate.started;

    // somebody else writes chapter 1's script underneath the run
    const edited: Segment[] = [
      {
        id: 1,
        type: "narration",
        speaker: "Narrator",
        text: "Edited by hand.",
        direction: "",
        audio: { status: "none", endpoint: null, ms: 0, duration: 0 },
      },
    ];
    writeScript(api.db, id, 1, edited);

    gate.release();
    await api.runner.idle();
    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("failed");
    expect(job.activity?.at(-1)?.detail?.error).toContain("changed while this ran");
    const { body: kept } = await api.request<ScriptResult>(`/api/books/${id}/chapters/1/script`);
    expect(kept.segments.map((s) => s.text)).toEqual(["Edited by hand."]);
    expect(kept.revision).toBe(1);
    // the chapter has a script, so it reads as scripted rather than as failed
    expect((await chaptersOf(api, id))[0].scripting).toBe("done");
  });

  test("a chapter renumbered while its job ran gets its script all the same", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }), ["One"]);
    await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "Two", paragraphs: dialogue() }] }),
      { bookId: id },
    );
    await api.request(`/api/books/${id}/confirm`, { method: "POST" });

    const { body } = await script(api, id, [2]);
    await gate.started;
    // volume 1 goes, and chapter 2 becomes chapter 1 while the run is in flight
    await api.request(`/api/books/${id}/volumes/1`, { method: "DELETE" });
    gate.release();
    await api.runner.idle();

    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("done");
    // the job row followed the renumbering by cascade
    expect(job.chapterId).toBe(1);
    expect(job.activity?.find((e) => e.message === "Script written")?.detail?.chapterNow).toBe(1);
    const chapters = await chaptersOf(api, id);
    expect(chapters.map((c) => [c.title, c.scripting])).toEqual([["Two", "done"]]);
    expect(readScript(api.db, id, 1).length).toBeGreaterThan(0);
  });

  test("a chapter removed while its job ran fails the job rather than writing anywhere", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const { body } = await script(api, id, [1]);
    await gate.started;
    await api.request(`/api/books/${id}`, { method: "DELETE" });
    gate.release();
    await api.runner.idle();
    // the job went with the book; nothing is left to be wrong about
    expect((await api.request<Failure>(`/api/jobs/${body.jobs[0].id}`)).status).toBe(404);
    expect(api.runner.running).toBeNull();
  });
});

describe("failure", () => {
  test("a provider that fails leaves a chapter with no script reading as failed, and says why", async () => {
    const { api, id } = await shelved(
      testApi({
        scripting: {
          name: "Broken",
          script: () => Promise.reject(new Error("The model answered with nothing")),
        },
      }),
    );
    const { body } = await script(api, id, [1]);
    await api.runner.idle();
    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("failed");
    expect(job.activity?.at(-1)?.detail?.error).toBe("The model answered with nothing");
    expect((await chaptersOf(api, id))[0].scripting).toBe("failed");
    // and the queue is free to be asked again
    expect((await script(api, id, [1])).body.jobs).toHaveLength(1);
  });

  test("a kind this server cannot run fails at once and says so", async () => {
    const api = testApi();
    const { id } = await shelved(api);
    // Every kind this server ships has a handler, so the rule is shown by taking one away: it
    // belongs to the runner, and a build is what a server built without an encoder would be.
    const bare = testRunner(api.db, collectingLogger().log, { handlers: { export: undefined } });
    const { job } = bare.enqueue({ kind: "export", bookId: id, chapterId: null, label: "Build" });
    await bare.idle();
    const settled = await jobById(api, job.id);
    expect(settled.status).toBe("failed");
    expect(settled.activity?.at(-1)?.detail?.error).toContain("no handler for export");
  });
});

describe("a restart", () => {
  test("puts back a job the last process was holding, and it finishes", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const { body } = await script(api, id, [1]);
    await gate.started;
    // the process stops with the job in flight: the row is left `running`, as a crash would leave it
    await api.runner.stop();
    expect(queue.getJob(api.db, body.jobs[0].id)?.status).toBe("running");
    expect(api.runner.running).toBeNull();

    // the next process finds it
    const next = testRunner(api.db, collectingLogger().log);
    next.start();
    await next.idle();
    await next.stop();
    const job = queue.getJob(api.db, body.jobs[0].id)!;
    expect(job.status).toBe("done");
    expect(job.activity?.map((e) => e.message)).toContain(
      "The server restarted while this ran; queued again",
    );
    expect(job.activity?.map((e) => e.message)).toContain("Job started again (attempt 2)");
    expect(readScript(api.db, id, 1).length).toBeGreaterThan(0);
  });

  test("gives up on a job that has already been tried twice", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const { body } = await script(api, id, [1]);
    await gate.started;
    await api.runner.stop();
    // the next process puts it back and starts it — and dies holding it too
    expect(queue.recoverInterrupted(api.db).requeued).toEqual([body.jobs[0].id]);
    queue.claimNext(api.db);
    const { requeued, settled } = queue.recoverInterrupted(api.db);
    expect(requeued).toEqual([]);
    expect(settled).toEqual([{ id: body.jobs[0].id, status: "failed" }]);
    expect(queue.getJob(api.db, body.jobs[0].id)?.status).toBe("failed");
  });
});

describe("the worker keeps going", () => {
  test("a book removed while its job ran, then a stop, leaves the worker able to start again", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const { body } = await script(api, id, [1]);
    await gate.started;
    // the job's row went with the book; recording how the job ended has nowhere to write to
    await api.request(`/api/books/${id}`, { method: "DELETE" });
    await api.runner.stop();
    expect(api.runner.running).toBeNull();
    expect((await api.request<Failure>(`/api/jobs/${body.jobs[0].id}`)).status).toBe(404);
    // the same runner starts again and takes new work
    api.runner.start();
    const next = await shelved(api, ["Again"]);
    const again = await script(api, next.id, [1]);
    gate.release();
    await api.runner.idle();
    expect((await jobById(api, again.body.jobs[0].id)).status).toBe("done");
    await api.runner.stop();
  });

  test("a handler that finished is done, however late a cancel or a stop arrived", async () => {
    // The handler takes a cancel back by throwing; one that returned is past the point where it
    // could. Calling it cancelled would have its `onSettled` undo work it had committed.
    const db = testDb();
    db.run(
      `insert into books (id, title, author, cover_from, cover_to, added_at) values ('b0','B','A','#000','#111',0)`,
    );
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let finish!: () => void;
    const released = new Promise<void>((r) => (finish = r));
    const settledAs: string[] = [];
    const runner = testRunner(db, collectingLogger().log, {
      handlers: {
        export: {
          async run() {
            entered();
            // past its last check of the signal: committing, closing a file
            await released;
          },
          onSettled: (_ctx, status) => void settledAs.push(status),
        },
      },
    });
    const { job } = runner.enqueue({
      kind: "export",
      bookId: "b0",
      chapterId: null,
      label: "Build",
    });
    // `enqueue` wakes the worker; there is nothing to start
    await inside;
    expect(runner.cancel(job.id)).toBe("running");
    finish();
    await runner.idle();
    expect(queue.getJob(db, job.id)?.status).toBe("done");
    expect(settledAs).toEqual(["done"]);
  });

  test("a handler that queues more work does not start a second worker beside itself", async () => {
    const db = testDb();
    // three books, because a whole-book job dedupes on its book
    for (const b of ["b0", "b1", "b2"])
      db.run(
        `insert into books (id, title, author, cover_from, cover_to, added_at) values ('${b}','B','A','#000','#111',0)`,
      );
    let running = 0;
    let most = 0;
    let follow = 0;
    const runner = testRunner(db, collectingLogger().log, {
      handlers: {
        export: {
          async run() {
            running++;
            most = Math.max(most, running);
            // the enqueue arrives inside the worker's own synchronous window
            if (follow++ < 2)
              runner.enqueue({
                kind: "export",
                bookId: `b${follow}`,
                chapterId: null,
                label: `Build ${follow}`,
              });
            await new Promise((r) => setTimeout(r, 1));
            running--;
          },
        },
      },
    });
    runner.enqueue({ kind: "export", bookId: "b0", chapterId: null, label: "Build 0" });
    await runner.idle();
    expect(queue.listJobs(db).map((j) => j.status)).toEqual(["done", "done", "done"]);
    expect(most).toBe(1);
  });
});

describe("the job log", () => {
  test("keeps the newest thousand events and counts what it dropped", () => {
    const db = testDb();
    db.run(
      "insert into books (id, title, author, cover_from, cover_to, added_at) values ('b','B','A','#000','#111',0)",
    );
    const { job } = queue.enqueueJob(db, {
      kind: "export",
      bookId: "b",
      chapterId: null,
      label: "Build",
    });
    for (let i = 0; i < queue.MAX_JOB_EVENTS + 4; i++) queue.appendEvent(db, job.id, `event ${i}`);
    const full = queue.getJob(db, job.id)!;
    expect(full.activity).toHaveLength(queue.MAX_JOB_EVENTS);
    // "Job queued" and the first four events are the ones that went
    expect(full.droppedEvents).toBe(5);
    expect(full.activity?.[0].message).toBe("event 4");
  });
});

describe("the queue over HTTP", () => {
  test("lists every job, oldest first, and can be narrowed to one book", async () => {
    const { api, id } = await shelved();
    const other = await shelved(api, ["Solo"]);
    await script(api, id, [1, 2]);
    await script(api, other.id, [1]);
    await api.runner.idle();
    const all = (await api.request<{ jobs: Job[] }>("/api/jobs")).body.jobs;
    expect(all.map((j) => j.bookId)).toEqual([id, id, other.id]);
    const mine = (await api.request<{ jobs: Job[] }>(`/api/jobs?bookId=${other.id}`)).body.jobs;
    expect(mine.map((j) => j.chapterId)).toEqual([1]);
  });

  test("clears the history and keeps what is live", async () => {
    const gate = gatedProvider();
    const { api, id } = await shelved(testApi({ scripting: gate.provider }));
    const first = await script(api, id, [1]);
    await gate.started;
    // a second run that has finished: cancel a queued one, which settles it at once
    const second = await script(api, id, [2]);
    await api.request(`/api/jobs/${second.body.jobs[0].id}/cancel`, { method: "POST" });
    const cleared = await api.request<{ removed: number }>("/api/jobs/clear", { method: "POST" });
    expect(cleared.body.removed).toBe(1);
    const left = (await api.request<{ jobs: Job[] }>("/api/jobs")).body.jobs;
    expect(left.map((j) => j.id)).toEqual([first.body.jobs[0].id]);
    gate.release();
    await api.runner.idle();
  });

  test("a job that does not exist is a 404 with a code the client can switch on", async () => {
    const api = testApi();
    const { status, body } = await api.request<Failure>("/api/jobs/999");
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: "not_found", message: "No such job" });
  });

  test("a path that is not a number is refused before anything is looked up", async () => {
    const api = testApi();
    const { status, body } = await api.request<Failure>("/api/jobs/latest");
    expect(status).toBe(400);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.detail).toContain("id");
    const text = await api.request<Failure>("/api/books/b/chapters/one/text");
    expect(text.status).toBe(400);
    expect(text.body.error.detail).toContain("chapterId");
  });
});
