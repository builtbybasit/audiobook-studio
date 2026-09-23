// Narration through the queue: a clip on disk for every line, written one line at a time, in the
// slot the store's rule says — in place for a line with no clip, beside the old clip for a line
// that has one — with the chapter's status asked of its clips and the revision moved with every
// clip that lands.
//
// Every test drives the real runner against the real routes with a speech model that renders a
// tone and never the network. Where a run has to be genuinely in flight — to be cancelled, edited
// under or stopped — the provider is `gatedSpeechProvider`, which holds the door until the test
// says so, so nothing here waits on a timer except the one fire-and-forget the removal makes.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Book, Chapter, Job, Segment } from "@/types";
import * as queue from "~/db/jobs";
import { readScript } from "~/db/script";
import { enqueueNarration } from "~/jobs/narration";
import { retakeLines, type Judged, type RetakesQueued } from "~/narration/ops";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import type { SpeechProvider } from "~/providers/speech";
import { epubFile, story } from "../support/epub";
import {
  collectingLogger,
  gatedSpeechProvider,
  jsonBody,
  testApi,
  testRunner,
  type TestApi,
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
  "“We are short again,” said Mara.",
  "“Then we count it twice,” said Tobin.",
  ...story(),
];

/** A two-speaker book on the shelf, chapters 1 and 2 scripted, the runner idle. */
async function scripted(api = testApi()) {
  const { body } = await api.import<ImportResult>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: ["One", "Two", "Three"].map((title) => ({ title, paragraphs: dialogue() })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1, 2] }));
  await api.runner.idle();
  return { api, id };
}

const narrate = (api: TestApi, id: string, ids: number[], scope?: string) =>
  api.request<Queued>(`/api/books/${id}/chapters/narrate`, jsonBody({ ids, scope }));

const scriptOf = async (api: TestApi, id: string, ch = 1) =>
  (await api.request<ScriptResult>(`/api/books/${id}/chapters/${ch}/script`)).body;

const chaptersOf = async (api: TestApi, id: string) =>
  (await api.request<ImportResult>(`/api/books/${id}`)).body.chapters;

const jobById = async (api: TestApi, id: number) =>
  (await api.request<{ job: Job }>(`/api/jobs/${id}`)).body.job;

const edit = (api: TestApi, id: string, body: unknown, ch = 1) =>
  api.request<ScriptResult>(`/api/books/${id}/chapters/${ch}/script`, {
    ...jsonBody(body),
    method: "PUT",
  });

/** A provider that fails the lines `match` picks out, once each, and renders everything else. */
function failingOnce(match: (text: string) => boolean): SpeechProvider {
  const inner = fakeSpeechProvider();
  const failed = new Set<string>();
  return {
    name: inner.name,
    speak(input) {
      if (match(input.text) && !failed.has(input.text)) {
        failed.add(input.text);
        return Promise.reject(new Error("The voice service dropped the connection"));
      }
      return inner.speak(input);
    },
  };
}

/**
 * A provider whose second render of any line is ten seconds longer than its first, so a retake
 * that is kept can be heard in the chapter's length and one that is dropped cannot; and which,
 * when told to, fails that second render instead, so a retake can go wrong where the first take
 * did not.
 */
function retaking({ failing }: { failing?: (text: string) => boolean } = {}): SpeechProvider {
  const inner = fakeSpeechProvider();
  const seen = new Set<string>();
  return {
    name: inner.name,
    async speak(input) {
      if (!seen.has(input.text)) {
        seen.add(input.text);
        return inner.speak(input);
      }
      if (failing?.(input.text)) throw new Error("The voice service dropped the connection");
      const clip = await inner.speak(input);
      return { ...clip, duration: clip.duration + 10 };
    },
  };
}

const retake = (api: TestApi, id: string, ids: number[], ch = 1) =>
  api.request<RetakesQueued & { chapters: Chapter[] }>(
    `/api/books/${id}/chapters/${ch}/retakes`,
    jsonBody({ ids }),
  );

const judge = (api: TestApi, id: string, segId: number, verdict: string, ch = 1) =>
  api.request<Judged>(
    `/api/books/${id}/chapters/${ch}/lines/${segId}/verdict`,
    jsonBody({ verdict }),
  );

/** Chapter 1 narrated, with the retaking provider unless another is given. */
async function narrated(api = testApi({ speech: retaking() })) {
  const { id } = await scripted(api);
  await narrate(api, id, [1]);
  await api.runner.idle();
  return { api, id };
}

/** The removal of a book's files is not waited for by the route, so the test waits a little. */
async function untilGone(path: string): Promise<boolean> {
  for (let i = 0; i < 50 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 2));
  return !existsSync(path);
}

describe("narrating a chapter through the queue", () => {
  test("writes a clip with a file behind it for every line, and the chapter reads as narrated", async () => {
    const { api, id } = await scripted();
    const before = await scriptOf(api, id);
    const { status, body } = await narrate(api, id, [1]);
    expect(status).toBe(202);
    expect(body.jobs[0].label).toBe("Narrate · ch 1");
    expect(body.jobs[0].bulk).toEqual({
      id: body.runId,
      op: "Narrate",
      index: 1,
      total: 1,
      scope: "Everything",
    });
    expect(body.jobs[0].narrationRun?.clips).toBe(before.segments.length);
    expect(["queued", "running"]).toContain(body.chapters[0].narration);
    await api.runner.idle();

    const { segments, revision } = await scriptOf(api, id);
    expect(segments.length).toBeGreaterThan(2);
    for (const s of segments) {
      expect(s.audio.status).toBe("done");
      expect(s.audio.duration).toBeGreaterThan(0);
      expect(s.audio.url).toStartWith(`/api/audio/${id}/`);
      expect(s.audio.text).toBe(s.text);
      expect(s.audio.type).toBe(s.type);
      expect(s.audio.direction).toBe(s.direction);
      expect(s.audio.style).toBe("");
      expect(s.audio.model).toBe("fake-tts-1");
      expect(s.audio.at).toBeGreaterThan(0);
      expect(s.audio.voiceRef).toBeUndefined();
      expect(s.candidate).toBeUndefined();
      expect(existsSync(join(api.audioDir, id, s.audio.url!.split("/").at(-1)!))).toBe(true);
    }
    // the revision moved with the clips, so a client holding the old copy is refused
    expect(revision).toBeGreaterThan(before.revision);

    const res = await api.fetch(segments[0].audio.url!, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");

    const [c1] = await chaptersOf(api, id);
    expect(c1.narration).toBe("done");
    expect(c1.narrationProgress).toBe(100);
    expect(c1.duration).toBeGreaterThan(segments.reduce((n, s) => n + s.audio.duration, 0));
    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("done");
    expect(job.activity?.map((e) => e.message).slice(0, 3)).toEqual([
      "Job queued",
      "Job started",
      "Narration started",
    ]);
    expect(job.activity?.at(-2)?.message).toBe("Narration finished");
    expect(job.activity?.at(-1)?.message).toBe("Job done");
  });

  test("two chapters are one run, and the second waits its turn", async () => {
    const { api, id } = await scripted();
    const { body } = await narrate(api, id, [1, 2]);
    expect(body.jobs.map((j) => j.chapterId)).toEqual([1, 2]);
    expect(body.jobs.map((j) => j.bulk?.index)).toEqual([1, 2]);
    expect(body.chapters.map((c) => c.narration)).toEqual(["running", "queued", "none"]);
    await api.runner.idle();
    expect((await chaptersOf(api, id)).map((c) => c.narration)).toEqual(["done", "done", "none"]);
  });
});

describe("what a scope renders", () => {
  test("`fill` after a full narration has nothing to do, and says so instead of queueing", async () => {
    const { api, id } = await scripted();
    await narrate(api, id, [1]);
    await api.runner.idle();
    const { body } = await narrate(api, id, [1], "fill");
    expect(body.jobs).toEqual([]);
    expect(body.skipped).toEqual([{ id: 1, why: "nothing" }]);
  });

  test("`fill` re-renders only the lines whose clip went stale, keeping the rest", async () => {
    const { api, id } = await scripted();
    await narrate(api, id, [1]);
    await api.runner.idle();
    const before = await scriptOf(api, id);
    // a rename marks the clips of the lines it moves stale, as the cast store does
    await api.request(`/api/books/${id}/characters/Mara/rename`, jsonBody({ to: "Marla" }));
    const stale = (await scriptOf(api, id)).segments.filter((s) => s.audio.status === "stale");
    expect(stale.length).toBe(1);
    expect((await chaptersOf(api, id))[0].narration).toBe("done");

    const { body } = await narrate(api, id, [1], "fill");
    expect(body.jobs[0].label).toBe("Re-narrate · ch 1");
    expect(body.jobs[0].bulk?.scope).toBe("Missing & changed");
    expect(body.jobs[0].narrationRun?.clips).toBe(1);
    await api.runner.idle();
    const { segments } = await scriptOf(api, id);
    for (const s of segments) {
      const was = before.segments.find((b) => b.id === s.id)!;
      expect(s.audio.status).toBe("done");
      if (s.id === stale[0].id) {
        expect(s.audio.url).not.toBe(was.audio.url);
        expect(s.audio.n).toBe(2);
        expect(s.audio.voice).toBeUndefined();
        // the stale clip stayed playable while its replacement rendered, and is a take now
        expect(s.audio.takes?.map((t) => [t.n, t.url])).toEqual([[1, was.audio.url]]);
      } else {
        expect(s.audio.url).toBe(was.audio.url);
        expect(s.audio.takes).toBeUndefined();
      }
    }
    expect((await chaptersOf(api, id))[0].narration).toBe("done");
  });

  test("`failed` re-renders only the lines whose request failed", async () => {
    const { api, id } = await scripted(
      testApi({ speech: failingOnce((t) => t.includes("count it twice")) }),
    );
    await narrate(api, id, [1]);
    await api.runner.idle();
    const before = await scriptOf(api, id);
    const broken = before.segments.filter((s) => s.audio.status === "failed");
    expect(broken).toHaveLength(1);
    const { body } = await narrate(api, id, [1], "failed");
    expect(body.jobs[0].bulk?.scope).toBe("Failed only");
    expect(body.jobs[0].narrationRun?.clips).toBe(1);
    await api.runner.idle();
    const { segments } = await scriptOf(api, id);
    expect(segments.every((s) => s.audio.status === "done")).toBe(true);
    for (const s of segments)
      if (s.id !== broken[0].id)
        expect(s.audio.url).toBe(before.segments.find((b) => b.id === s.id)!.audio.url);
    // rendered in place: a failed clip is not a clip to keep a take of
    expect(segments.find((s) => s.id === broken[0].id)?.audio.takes).toBeUndefined();
  });

  test("`all` re-renders every line, and a line that had a clip keeps it as a take", async () => {
    const { api, id } = await scripted();
    await narrate(api, id, [1]);
    await api.runner.idle();
    const before = await scriptOf(api, id);
    const { body } = await narrate(api, id, [1], "all");
    expect(body.jobs[0].label).toBe("Re-narrate · ch 1");
    expect(body.jobs[0].bulk?.op).toBe("Re-narrate");
    await api.runner.idle();
    const { segments } = await scriptOf(api, id);
    for (const s of segments) {
      const was = before.segments.find((b) => b.id === s.id)!;
      expect(s.audio.status).toBe("done");
      expect(s.audio.n).toBe(2);
      expect(s.audio.auto).toBeUndefined();
      expect(s.audio.url).not.toBe(was.audio.url);
      expect(s.audio.takes).toHaveLength(1);
      expect(s.audio.takes?.[0]).toMatchObject({ n: 1, url: was.audio.url, text: was.text });
      expect(s.candidate).toBeUndefined();
    }
    // and a third pass numbers the take after the ones the line has seen
    await narrate(api, id, [1], "all");
    await api.runner.idle();
    const third = (await scriptOf(api, id)).segments[0];
    expect(third.audio.n).toBe(3);
    expect(third.audio.takes?.map((t) => t.n)).toEqual([1, 2]);
  });

  test("a scope the request does not name is `all`, and one it misspells is refused", async () => {
    const { api, id } = await scripted();
    const { body } = await narrate(api, id, [1]);
    expect(body.jobs[0].bulk?.scope).toBe("Everything");
    await api.runner.idle();
    const bad = await api.request<Failure>(
      `/api/books/${id}/chapters/narrate`,
      jsonBody({ ids: [1], scope: "some" }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.detail).toContain("scope");
  });
});

describe("a line that cannot be rendered", () => {
  test("fails the job and the chapter, leaves the other lines done, and is retried at the failed scope", async () => {
    const { api, id } = await scripted(
      testApi({ speech: failingOnce((t) => t.includes("count it twice")) }),
    );
    const { body } = await narrate(api, id, [1]);
    await api.runner.idle();
    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("failed");
    expect(job.activity?.at(-1)?.detail?.error).toBe("1 line could not be rendered");
    const { segments } = await scriptOf(api, id);
    const broken = segments.find((s) => s.text.includes("count it twice"))!;
    expect(broken.audio.status).toBe("failed");
    expect(broken.audio.error?.message).toBe("The voice service dropped the connection");
    expect(broken.audio.url).toBeUndefined();
    expect(segments.filter((s) => s.audio.status === "done")).toHaveLength(segments.length - 1);
    const [c1] = await chaptersOf(api, id);
    expect(c1.narration).toBe("failed");
    expect(c1.narrationProgress).toBe(100);

    await narrate(api, id, [1], "failed");
    await api.runner.idle();
    expect((await scriptOf(api, id)).segments.every((s) => s.audio.status === "done")).toBe(true);
    expect((await chaptersOf(api, id))[0].narration).toBe("done");
  });

  test("a replacement that fails leaves the clip in the book untouched, and the chapter reading as narrated", async () => {
    const { api, id } = await scripted(
      testApi({ speech: failingOnce((t) => t.includes("count it twice")) }),
    );
    // the first run renders the line: `failingOnce` fails it, so run again to get a clean chapter
    await narrate(api, id, [1]);
    await api.runner.idle();
    await narrate(api, id, [1], "failed");
    await api.runner.idle();
    const before = (await scriptOf(api, id)).segments.find((s) =>
      s.text.includes("count it twice"),
    )!;
    expect(before.audio.status).toBe("done");
    // now a replacement of everything, with the fake wired to fail that line once more
    const again = failingOnce((t) => t.includes("count it twice"));
    const slow = testRunner(api.db, collectingLogger().log, {
      speech: again,
      audioDir: api.audioDir,
    });
    const { jobs } = enqueueNarration(api.db, slow, id, [1], { scope: "all" });
    await slow.idle();
    expect(queue.getJob(api.db, jobs[0].id)?.status).toBe("failed");
    const after = (await scriptOf(api, id)).segments.find((s) => s.id === before.id)!;
    expect(after.audio).toEqual(before.audio);
    expect(after.candidate?.status).toBe("failed");
    expect(after.candidate?.auto).toBe(true);
    expect(after.candidate?.error?.message).toContain("dropped");
    // the chapter's own clips are all there, so it reads as narrated
    expect((await chaptersOf(api, id))[0].narration).toBe("done");
  });
});

describe("cancelling", () => {
  test("a running job puts back the lines it had not finished, and keeps the ones it had", async () => {
    const gate = gatedSpeechProvider();
    const { api, id } = await scripted(testApi({ speech: gate.provider }));
    const { body } = await narrate(api, id, [1]);
    await gate.started;
    const during = await scriptOf(api, id);
    expect(during.segments[0].audio.status).toBe("generating");
    expect(during.segments[0].audio.startedAt).toBeGreaterThan(0);
    expect(during.segments.slice(1).every((s) => s.audio.status === "queued")).toBe(true);
    expect((await chaptersOf(api, id))[0].narration).toBe("running");

    const cancelled = await api.request<{ was: string }>(`/api/jobs/${body.jobs[0].id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.body.was).toBe("running");
    await api.runner.idle();
    expect((await jobById(api, body.jobs[0].id)).status).toBe("cancelled");
    const { segments } = await scriptOf(api, id);
    expect(segments.every((s) => s.audio.status === "none")).toBe(true);
    expect(segments.every((s) => s.audio.url == null)).toBe(true);
    const [c1] = await chaptersOf(api, id);
    expect(c1.narration).toBe("none");
    expect(c1.narrationProgress).toBe(0);
    expect(api.runner.running).toBeNull();
  });

  test("a cancelled replacement run leaves no retake behind, and the old clips still play", async () => {
    const { api, id } = await scripted();
    await narrate(api, id, [1]);
    await api.runner.idle();
    const before = await scriptOf(api, id);
    const gate = gatedSpeechProvider();
    const slow = testRunner(api.db, collectingLogger().log, {
      speech: gate.provider,
      audioDir: api.audioDir,
    });
    const { jobs } = enqueueNarration(api.db, slow, id, [1], { scope: "all" });
    await gate.started;
    const during = await scriptOf(api, id);
    expect(during.segments[0].candidate?.status).toBe("generating");
    expect(during.segments[0].audio.status).toBe("done");
    expect(during.segments.slice(1).every((s) => s.candidate?.status === "queued")).toBe(true);
    slow.cancel(jobs[0].id);
    await slow.idle();
    expect(queue.getJob(api.db, jobs[0].id)?.status).toBe("cancelled");
    const { segments } = await scriptOf(api, id);
    expect(segments.map((s) => s.audio)).toEqual(before.segments.map((s) => s.audio));
    expect(segments.every((s) => s.candidate === undefined)).toBe(true);
    expect((await chaptersOf(api, id))[0].narration).toBe("done");
    expect((await api.fetch(segments[0].audio.url!, {})).status).toBe(200);
  });

  test("a queued job never starts, and its chapter goes back to having nothing", async () => {
    const gate = gatedSpeechProvider();
    const { api, id } = await scripted(testApi({ speech: gate.provider }));
    const { body } = await narrate(api, id, [1, 2]);
    await gate.started;
    const revision = (await scriptOf(api, id, 2)).revision;
    const cancelled = await api.request<{ was: string }>(`/api/jobs/${body.jobs[1].id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.body.was).toBe("queued");
    expect((await chaptersOf(api, id))[1].narration).toBe("none");
    const second = await scriptOf(api, id, 2);
    expect(second.segments.every((s) => s.audio.status === "none")).toBe(true);
    // nothing was written, so nothing moved
    expect(second.revision).toBe(revision);
    gate.release();
    await api.runner.idle();
    expect((await chaptersOf(api, id)).map((c) => c.narration)).toEqual(["done", "none", "none"]);
  });
});

describe("the revision moves with every clip", () => {
  test("an edit from a copy read before a clip landed is refused, and the clip lands all the same", async () => {
    const gate = gatedSpeechProvider();
    const { api, id } = await scripted(testApi({ speech: gate.provider }));
    const old = await scriptOf(api, id);
    const { body } = await narrate(api, id, [1]);
    await gate.started;
    const stale = await edit(api, id, {
      segments: old.segments.map((s, i) => (i === 0 ? { ...s, text: "Edited late." } : s)),
      ifRevision: old.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: { code: "conflict" } });
    gate.release();
    await api.runner.idle();
    expect((await jobById(api, body.jobs[0].id)).status).toBe("done");
    const fresh = await scriptOf(api, id);
    expect(fresh.segments[0].text).toBe(old.segments[0].text);
    expect(fresh.segments.every((s) => s.audio.status === "done")).toBe(true);
    // an edit from a fresh read lands, and keeps the clips it read
    const ok = await edit(api, id, {
      segments: fresh.segments.map((s, i) => (i === 0 ? { ...s, text: "Edited after." } : s)),
      ifRevision: fresh.revision,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.segments[0].text).toBe("Edited after.");
    expect(ok.body.segments[0].audio.url).toBe(fresh.segments[0].audio.url);
  });

  test("a line removed while its clip rendered is dropped with a note, not written against nothing", async () => {
    const gate = gatedSpeechProvider();
    const { api, id } = await scripted(testApi({ speech: gate.provider }));
    const { body } = await narrate(api, id, [1]);
    const first = await gate.started;
    const during = await scriptOf(api, id);
    // the line being rendered goes, from a fresh read
    await edit(api, id, {
      segments: during.segments.filter((s) => s.text !== first.text),
      ifRevision: during.revision,
    });
    gate.release();
    await api.runner.idle();
    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("done");
    expect(job.activity?.some((e) => e.message.includes("was removed while it rendered"))).toBe(
      true,
    );
    const { segments } = await scriptOf(api, id);
    expect(segments.every((s) => s.audio.status === "done")).toBe(true);
    expect((await chaptersOf(api, id))[0].narration).toBe("done");
  });
});

describe("a restart", () => {
  test("puts back a job the last process was holding, and it finishes the chapter", async () => {
    const gate = gatedSpeechProvider();
    const { api, id } = await scripted(testApi({ speech: gate.provider }));
    const { body } = await narrate(api, id, [1]);
    await gate.started;
    await api.runner.stop();
    expect(queue.getJob(api.db, body.jobs[0].id)?.status).toBe("running");
    // the row is left as a crash would leave it: a line generating, the rest queued
    expect(readScript(api.db, id, 1)[0].audio.status).toBe("generating");

    const next = testRunner(api.db, collectingLogger().log, { audioDir: api.audioDir });
    next.start();
    await next.idle();
    await next.stop();
    const job = queue.getJob(api.db, body.jobs[0].id)!;
    expect(job.status).toBe("done");
    // a clean stop gave back the start it cut short, so this is not counted as a second attempt
    expect(job.activity?.map((e) => e.message)).toContain("Job started again");
    const { segments } = await scriptOf(api, id);
    expect(segments.every((s) => s.audio.status === "done" && s.audio.url)).toBe(true);
    expect((await chaptersOf(api, id))[0].narration).toBe("done");
  });
});

describe("what is left out of a run", () => {
  test("a skipped, an unscripted, a busy and a missing chapter are each said so", async () => {
    const gate = gatedSpeechProvider();
    const { api, id } = await scripted(testApi({ speech: gate.provider }));
    await api.request(`/api/books/${id}/chapters/skip`, jsonBody({ ids: [2] }));
    const first = await narrate(api, id, [1]);
    await gate.started;
    const { body } = await narrate(api, id, [1, 2, 3, 9]);
    expect(body.jobs).toEqual([]);
    expect(body.skipped).toEqual([
      { id: 1, why: "busy" },
      { id: 2, why: "excluded" },
      { id: 3, why: "unscripted" },
      { id: 9, why: "missing" },
    ]);
    gate.release();
    await api.runner.idle();
    expect((await jobById(api, first.body.jobs[0].id)).status).toBe("done");
  });

  test("a book still in its contents review has nothing to narrate", async () => {
    const api = testApi();
    const { body } = await api.import<ImportResult>(
      await epubFile({ chapters: [{ title: "One", paragraphs: story() }] }),
    );
    const refused = await api.request<Failure>(
      `/api/books/${body.book.id}/chapters/narrate`,
      jsonBody({ ids: [1] }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("conflict");
    expect((await narrate(api, "nobody", [1])).status).toBe(404);
  });
});

describe("a retake", () => {
  test("of a narrated line renders beside the clip in the book, and waits there for a verdict", async () => {
    const { api, id } = await narrated();
    const before = await scriptOf(api, id);
    const line = before.segments[1];
    const { status, body } = await retake(api, id, [line.id]);
    expect(status).toBe(202);
    expect(body.queued).toEqual([line.id]);
    expect(body.skipped).toEqual([]);
    expect(body.job?.label).toBe("Retake · ch 1");
    expect(body.job?.bulk).toMatchObject({ op: "Retake", index: 1, total: 1, scope: "Retake" });
    expect(body.job?.narrationRun?.clips).toBe(1);
    expect(["queued", "running"]).toContain(body.chapters[0].narration);
    await api.runner.idle();

    const job = await jobById(api, body.job!.id);
    expect(job.status).toBe("done");
    expect(job.activity?.map((e) => e.message)).toContain(
      `Line ${line.id} take 2 rendered, waiting for a verdict`,
    );
    expect(job.activity?.find((e) => e.message === "Narration finished")?.detail).toMatchObject({
      rendered: 0,
      failed: 0,
      waiting: 1,
    });
    const { segments, revision } = await scriptOf(api, id);
    const after = segments.find((s) => s.id === line.id)!;
    expect(after.audio).toEqual(line.audio);
    expect(after.candidate?.status).toBe("done");
    expect(after.candidate?.n).toBe(2);
    expect(after.candidate?.auto).toBeUndefined();
    expect(after.candidate?.url).toStartWith(`/api/audio/${id}/`);
    expect(after.candidate?.url).not.toBe(line.audio.url);
    expect(revision).toBeGreaterThan(before.revision);
    for (const s of segments) if (s.id !== line.id) expect(s.candidate).toBeUndefined();
    const [c1] = await chaptersOf(api, id);
    expect(c1.narration).toBe("done");
    expect(c1.narrationProgress).toBe(100);
  });

  test("of a line whose clip failed renders in place, and the chapter reads as narrated", async () => {
    const { api, id } = await scripted(
      testApi({ speech: failingOnce((t) => t.includes("count it twice")) }),
    );
    await narrate(api, id, [1]);
    await api.runner.idle();
    const broken = (await scriptOf(api, id)).segments.find((s) => s.audio.status === "failed")!;
    const { body } = await retake(api, id, [broken.id]);
    expect(body.queued).toEqual([broken.id]);
    await api.runner.idle();
    expect((await jobById(api, body.job!.id)).status).toBe("done");
    const after = (await scriptOf(api, id)).segments.find((s) => s.id === broken.id)!;
    expect(after.audio.status).toBe("done");
    expect(after.audio.url).toStartWith(`/api/audio/${id}/`);
    expect(after.candidate).toBeUndefined();
    expect(after.audio.takes).toBeUndefined();
    expect((await chaptersOf(api, id))[0].narration).toBe("done");
  });

  test("leaves out a line already waiting for a verdict and a line that is not there, and queues nothing when nothing is left", async () => {
    const { api, id } = await narrated();
    const line = (await scriptOf(api, id)).segments[0];
    await retake(api, id, [line.id]);
    await api.runner.idle();
    const before = await scriptOf(api, id);
    const { status, body } = await retake(api, id, [line.id, 999]);
    expect(status).toBe(202);
    expect(body.job).toBeNull();
    expect(body.queued).toEqual([]);
    expect(body.skipped).toEqual([
      { id: line.id, why: "pending" },
      { id: 999, why: "missing" },
    ]);
    // nothing was written, so nothing moved
    expect((await scriptOf(api, id)).revision).toBe(before.revision);
    expect((await chaptersOf(api, id))[0].narration).toBe("done");
  });

  test("is refused while the chapter is being narrated", async () => {
    const gate = gatedSpeechProvider();
    const { api, id } = await scripted(testApi({ speech: gate.provider }));
    const first = await narrate(api, id, [1]);
    await gate.started;
    const refused = await api.request<Failure>(
      `/api/books/${id}/chapters/1/retakes`,
      jsonBody({ ids: [1] }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe("Chapter 1 is being narrated");
    gate.release();
    await api.runner.idle();
    expect((await jobById(api, first.body.jobs[0].id)).status).toBe("done");
  });

  test("of a chapter with no script, or none at all, is refused", async () => {
    const { api, id } = await scripted();
    const unscripted = await api.request<Failure>(
      `/api/books/${id}/chapters/3/retakes`,
      jsonBody({ ids: [1] }),
    );
    expect(unscripted.status).toBe(404);
    expect(unscripted.body.error.message).toBe("This chapter has no script to retake");
    expect(
      (await api.request(`/api/books/${id}/chapters/9/retakes`, jsonBody({ ids: [1] }))).status,
    ).toBe(404);
    expect(
      (await api.request(`/api/books/nobody/chapters/1/retakes`, jsonBody({ ids: [1] }))).status,
    ).toBe(404);
    const empty = await api.request<Failure>(
      `/api/books/${id}/chapters/1/retakes`,
      jsonBody({ ids: [] }),
    );
    expect(empty.status).toBe(400);
  });
});

describe("the verdict on a retake", () => {
  test("keeping it makes it the clip in the book, keeps the old one as a take, clears the flag and retimes the chapter", async () => {
    const { api, id } = await narrated();
    const read = await scriptOf(api, id);
    const line = read.segments[0];
    // the listener complained about the line; the retake is the answer to the complaint
    const flagged = await edit(api, id, {
      segments: read.segments.map((s) =>
        s.id === line.id ? { ...s, flag: { kind: "delivery", note: "too flat", at: 1 } } : s,
      ),
      ifRevision: read.revision,
    });
    expect(flagged.status).toBe(200);
    await retake(api, id, [line.id]);
    await api.runner.idle();
    const before = await scriptOf(api, id);
    const [chapterBefore] = await chaptersOf(api, id);
    const candidate = before.segments.find((s) => s.id === line.id)!.candidate!;
    expect(before.segments.find((s) => s.id === line.id)!.flag).toMatchObject({ note: "too flat" });

    const { status, body } = await judge(api, id, line.id, "accept");
    expect(status).toBe(200);
    expect(body.segment.audio.status).toBe("done");
    expect(body.segment.audio.url).toBe(candidate.url);
    expect(body.segment.audio.n).toBe(2);
    expect(body.segment.audio.auto).toBeUndefined();
    expect(body.segment.audio.takes?.map((t) => [t.n, t.url, t.rejected])).toEqual([
      [1, line.audio.url, undefined],
    ]);
    expect(body.segment.candidate).toBeUndefined();
    expect(body.segment.flag).toBeUndefined();
    expect(body.revision).toBeGreaterThan(before.revision);
    // the retake is ten seconds longer than the clip it replaced, and the chapter says so
    expect(body.chapter.narration).toBe("done");
    expect(body.chapter.duration).toBeCloseTo(chapterBefore.duration + 10, 5);
    expect((await scriptOf(api, id)).revision).toBe(body.revision);
    expect((await chaptersOf(api, id))[0].duration).toBe(body.chapter.duration);

    const again = await api.request<Failure>(
      `/api/books/${id}/chapters/1/lines/${line.id}/verdict`,
      jsonBody({ verdict: "accept" }),
    );
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("Nothing to judge: this line has no retake");
  });

  test("dropping it keeps it as a rejected take and leaves the clip in the book alone", async () => {
    const { api, id } = await narrated();
    const line = (await scriptOf(api, id)).segments[0];
    await retake(api, id, [line.id]);
    await api.runner.idle();
    const before = await scriptOf(api, id);
    const [chapterBefore] = await chaptersOf(api, id);
    const candidate = before.segments.find((s) => s.id === line.id)!.candidate!;

    const { status, body } = await judge(api, id, line.id, "reject");
    expect(status).toBe(200);
    const { takes, ...kept } = body.segment.audio;
    expect(kept).toEqual(line.audio);
    expect(takes).toHaveLength(1);
    expect(takes?.[0]).toMatchObject({ n: 2, url: candidate.url, rejected: true });
    expect(body.segment.candidate).toBeUndefined();
    expect(body.revision).toBeGreaterThan(before.revision);
    expect(body.chapter.narration).toBe("done");
    expect(body.chapter.duration).toBe(chapterBefore.duration);
    // the rejected take's number is never handed out again
    await retake(api, id, [line.id]);
    await api.runner.idle();
    expect((await scriptOf(api, id)).segments.find((s) => s.id === line.id)!.candidate?.n).toBe(3);
  });

  test("a retake that failed leaves the job done, cannot be kept, and is dropped without a take", async () => {
    const { api, id } = await narrated(
      testApi({ speech: retaking({ failing: (t) => t.includes("count it twice") }) }),
    );
    const line = (await scriptOf(api, id)).segments.find((s) => s.text.includes("count it twice"))!;
    const { body } = await retake(api, id, [line.id]);
    await api.runner.idle();
    const job = await jobById(api, body.job!.id);
    expect(job.status).toBe("done");
    expect(job.activity?.map((e) => e.message)).toContain(
      `Line ${line.id} take 2 failed; the clip in the book is unchanged`,
    );
    expect(job.activity?.find((e) => e.message === "Narration finished")?.detail).toMatchObject({
      failed: 0,
    });
    const during = (await scriptOf(api, id)).segments.find((s) => s.id === line.id)!;
    expect(during.candidate?.status).toBe("failed");
    expect(during.candidate?.error?.message).toContain("dropped");
    expect(during.audio).toEqual(line.audio);
    expect((await chaptersOf(api, id))[0].narration).toBe("done");

    const kept = await api.request<Failure>(
      `/api/books/${id}/chapters/1/lines/${line.id}/verdict`,
      jsonBody({ verdict: "accept" }),
    );
    expect(kept.status).toBe(409);
    expect(kept.body.error.message).toBe("The retake did not produce a clip; discard it instead");
    const { body: dropped } = await judge(api, id, line.id, "reject");
    expect(dropped.segment.candidate).toBeUndefined();
    expect(dropped.segment.audio).toEqual(line.audio);
    expect(dropped.segment.audio.takes).toBeUndefined();
  });

  test("is refused while the retake renders, on a line with no retake, and for a line that is not there", async () => {
    const { api, id } = await narrated();
    const line = (await scriptOf(api, id)).segments[0];
    const gate = gatedSpeechProvider();
    const slow = testRunner(api.db, collectingLogger().log, {
      speech: gate.provider,
      audioDir: api.audioDir,
    });
    const { job } = retakeLines(api.db, slow, id, 1, [line.id]);
    await gate.started;
    expect((await scriptOf(api, id)).segments[0].candidate?.status).toBe("generating");
    const rendering = await api.request<Failure>(
      `/api/books/${id}/chapters/1/lines/${line.id}/verdict`,
      jsonBody({ verdict: "accept" }),
    );
    expect(rendering.status).toBe(409);
    expect(rendering.body.error.message).toBe("The retake is still rendering");
    gate.release();
    await slow.idle();
    expect(queue.getJob(api.db, job!.id)?.status).toBe("done");

    const none = await api.request<Failure>(
      `/api/books/${id}/chapters/1/lines/${line.id + 1}/verdict`,
      jsonBody({ verdict: "reject" }),
    );
    expect(none.status).toBe(409);
    expect(none.body.error.message).toBe("Nothing to judge: this line has no retake");
    const missing = await api.request<Failure>(
      `/api/books/${id}/chapters/1/lines/999/verdict`,
      jsonBody({ verdict: "reject" }),
    );
    expect(missing.status).toBe(404);
    const bad = await api.request<Failure>(
      `/api/books/${id}/chapters/1/lines/${line.id}/verdict`,
      jsonBody({ verdict: "maybe" }),
    );
    expect(bad.status).toBe(400);
    // the retake that finished meanwhile is still there to judge
    expect((await judge(api, id, line.id, "accept")).status).toBe(200);
  });
});

interface LexiconSaved {
  entries: { id: number; term: string; say: string; enabled: boolean }[];
  stale: { chapterId: number; ids: number[]; revision: number }[];
  restored: { chapterId: number; ids: number[]; revision: number }[];
}

const lexicon = (
  api: TestApi,
  id: string,
  entries: { id: number; term: string; say: string }[],
  restore?: { chapterId: number; ids: number[] }[],
) =>
  api.request<LexiconSaved>(`/api/books/${id}/lexicon`, {
    ...jsonBody({ entries: entries.map((e) => ({ ...e, enabled: true })), restore }),
    method: "PUT",
  });

/** A provider that remembers every text it was sent, and renders it with the fake. */
function recording(): SpeechProvider & { sent: string[] } {
  const inner = fakeSpeechProvider();
  const sent: string[] = [];
  return { name: inner.name, sent, speak: (input) => (sent.push(input.text), inner.speak(input)) };
}

describe("what a line is spoken as", () => {
  test("a line the dictionary matches is sent the respelling, and its clip says so", async () => {
    const speech = recording();
    const { api, id } = await scripted(testApi({ speech }));
    await lexicon(api, id, [{ id: 1, term: "twice", say: "two times" }]);
    await narrate(api, id, [1]);
    await api.runner.idle();

    const { segments } = await scriptOf(api, id);
    const matched = segments.find((s) => s.text.includes("twice"))!;
    const said = matched.text.replace("twice", "two times");
    expect(speech.sent).toContain(said);
    expect(speech.sent).not.toContain(matched.text);
    expect(matched.audio).toMatchObject({ status: "done", text: matched.text, said, lex: 1 });
    expect(matched.audio.pronounced).toBe(said);
    // a line the dictionary leaves alone records that it did, and nothing it was not rewritten to
    const plain = segments.find((s) => !s.text.includes("twice"))!;
    expect(plain.audio.pronounced).toBe(plain.text);
    expect(plain.audio.said).toBeUndefined();
    expect(plain.audio.lex).toBeUndefined();
  });

  test("an entry that is switched off, or matches only inside a word, is not applied", async () => {
    const speech = recording();
    const { api, id } = await scripted(testApi({ speech }));
    await api.request(`/api/books/${id}/lexicon`, {
      ...jsonBody({
        entries: [
          { id: 1, term: "twice", say: "two times", enabled: false },
          { id: 2, term: "wic", say: "wick" },
        ].map((e) => ({ enabled: true, ...e })),
      }),
      method: "PUT",
    });
    await narrate(api, id, [1]);
    await api.runner.idle();
    const { segments } = await scriptOf(api, id);
    expect(speech.sent).toEqual(segments.map((s) => s.text));
  });

  test("replacing the dictionary marks stale exactly the clips it changes the words of", async () => {
    const { api, id } = await scripted(testApi({ speech: fakeSpeechProvider() }));
    await narrate(api, id, [1, 2]);
    await api.runner.idle();
    const before = await scriptOf(api, id);
    const matched = before.segments.filter((s) => s.text.includes("twice")).map((s) => s.id);
    expect(matched.length).toBeGreaterThan(0);

    const { status, body } = await lexicon(api, id, [{ id: 1, term: "twice", say: "two times" }]);
    expect(status).toBe(200);
    expect(body.restored).toEqual([]);
    expect(body.stale.map((m) => [m.chapterId, m.ids])).toEqual([
      [1, matched],
      [2, matched],
    ]);

    const after = await scriptOf(api, id);
    expect(after.revision).toBe(body.stale[0].revision);
    expect(after.revision).toBeGreaterThan(before.revision);
    for (const s of after.segments)
      expect(s.audio.status).toBe(matched.includes(s.id) ? "stale" : "done");
    expect((await chaptersOf(api, id)).slice(0, 2).map((c) => c.narration)).toEqual([
      "stale",
      "stale",
    ]);

    // the same list again changes nothing, and moves no revision
    const again = await lexicon(api, id, [{ id: 1, term: "twice", say: "two times" }]);
    expect(again.body.stale).toEqual([]);
    expect((await scriptOf(api, id)).revision).toBe(after.revision);
  });

  test("an Undo puts back the clips its change staled, and only those that still match", async () => {
    const { api, id } = await scripted(testApi({ speech: fakeSpeechProvider() }));
    await narrate(api, id, [1, 2]);
    await api.runner.idle();
    const { body: changed } = await lexicon(api, id, [{ id: 1, term: "twice", say: "two times" }]);

    // chapter 2's line is edited after the change, so its clip is stale for a reason of its own
    const two = await scriptOf(api, id, 2);
    const line = two.segments.find((s) => s.text.includes("twice"))!;
    const edited = two.segments.map((s) =>
      s.id === line.id ? { ...s, text: `${s.text} Again.` } : s,
    );
    expect((await edit(api, id, { segments: edited, ifRevision: two.revision }, 2)).status).toBe(
      200,
    );

    const { body } = await lexicon(api, id, [], changed.stale);
    expect(body.stale).toEqual([]);
    expect(body.restored.map((m) => [m.chapterId, m.ids])).toEqual([[1, changed.stale[0].ids]]);
    expect((await scriptOf(api, id)).segments.every((s) => s.audio.status === "done")).toBe(true);
    expect((await chaptersOf(api, id))[0].narration).toBe("done");
    const kept = (await scriptOf(api, id, 2)).segments.find((s) => s.id === line.id)!;
    expect(kept.audio.status).toBe("stale");
  });

  test("an Undo looks only at the lines it names, not at every clip that could go back", async () => {
    const { api, id } = await scripted(testApi({ speech: fakeSpeechProvider() }));
    await narrate(api, id, [1]);
    await api.runner.idle();
    // Tobin's lines go stale by the rename, and nothing about the dictionary changed them
    await api.request(`/api/books/${id}/characters/Tobin/rename`, jsonBody({ to: "Toby" }));
    const { segments } = await scriptOf(api, id);
    const renamed = segments.filter((s) => s.audio.status === "stale").map((s) => s.id);
    expect(renamed.length).toBeGreaterThan(0);
    const other = segments.find((s) => !renamed.includes(s.id))!;

    const { body } = await lexicon(api, id, [], [{ chapterId: 1, ids: [other.id] }]);
    expect(body.restored).toEqual([]);
    const after = await scriptOf(api, id);
    expect(after.segments.filter((s) => s.audio.status === "stale").map((s) => s.id)).toEqual(
      renamed,
    );
  });

  test("a line sent before the dictionary changed lands stale, and the lines after it are sent the new words", async () => {
    const gate = gatedSpeechProvider();
    const { api, id } = await scripted(testApi({ speech: gate.provider }));
    await narrate(api, id, [1]);
    const idle = api.runner.idle();
    const first = await gate.started;
    // the chapter's heading, which is the first line out
    const term = first.text;
    const { body } = await lexicon(api, id, [{ id: 1, term, say: "SAID" }]);
    // the clip in flight is not done yet, so the change has nothing of this chapter's to mark
    expect(body.stale).toEqual([]);
    gate.release();
    await idle;

    const { segments } = await scriptOf(api, id);
    const [line, ...rest] = segments;
    expect(line.audio.pronounced).toBe(first.text);
    expect(line.audio.status).toBe("stale");
    for (const s of rest) {
      expect(s.audio.status).toBe("done");
      expect(s.audio.pronounced).toBe(s.text.replace(new RegExp(`\\b${term}\\b`, "gi"), "SAID"));
    }
    expect((await chaptersOf(api, id))[0].narration).toBe("stale");
  });
});

describe("the files", () => {
  test("go with the book, and the route answers 404 afterwards", async () => {
    const { api, id } = await scripted();
    await narrate(api, id, [1]);
    await api.runner.idle();
    const { segments } = await scriptOf(api, id);
    const url = segments[0].audio.url!;
    expect(existsSync(join(api.audioDir, id))).toBe(true);
    await api.request(`/api/books/${id}`, { method: "DELETE" });
    expect(await untilGone(join(api.audioDir, id))).toBe(true);
    const res = await api.request<Failure>(url);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  test("go with a book removed mid-narration, and the job does not bring them back", async () => {
    const gate = gatedSpeechProvider();
    const { api, id } = await scripted(testApi({ speech: gate.provider }));
    const { body } = await narrate(api, id, [1]);
    await gate.started;

    const removed = await api.request(`/api/books/${id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    // the line it was reading comes back after the removal, as a slow model's would
    gate.release();
    await api.runner.idle();
    expect(await untilGone(join(api.audioDir, id))).toBe(true);
    expect(existsSync(join(api.audioDir, id))).toBe(false);
    expect(queue.getJob(api.db, body.jobs[0].id)).toBeUndefined();
  });

  test("a path that is not a book and a token is never read", async () => {
    const { api, id } = await scripted();
    expect(api.files.path("../etc", "passwd.wav")).toBeNull();
    expect(api.files.path(id, "../passwd.wav")).toBeNull();
    expect(api.files.path(id, "evil.wav")).toBeNull();
    expect(api.files.path(id, "0123abcd.wav.txt")).toBeNull();
    expect(api.files.path(id, "0123abcd-ef.wav")).toEndWith(join(id, "0123abcd-ef.wav"));
    for (const path of [
      `/api/audio/${id}/evil.wav`,
      `/api/audio/${id}/..%2F..%2Fpasswd.wav`,
      `/api/audio/..%2F${id}/0123abcd.wav`,
      `/api/audio/${id}/0123abcd.wav`,
    ]) {
      const res = await api.request<Failure>(path);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
  });
});
