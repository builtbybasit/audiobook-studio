// What a demo situation leaves running, made real on the demo library (`server/demo/live.ts`).
//
// The library here is put together the way `openLibrary` puts the demo together — its database
// seeded with the browser's world, its clips made on first read, the endpoints' own providers paced
// by the demo's speed, one speech gate for its queue and its routes — but by hand, so the test holds
// the gate `startLive` is given and the pace. Each test hands `startLive` a `DemoLive` of its own and
// reads the result back through the demo's API, as the Endpoints, Queue and Export pages read it.
// What an endpoint has been through is rows and a cooldown whatever the world holds, so those tests
// start from an empty library rather than paying for the seed. The providers' `fetch` fails the
// test, so everything here is shown to need no network; their `random` never draws a failure, so a
// simulated endpoint's fail rate does not make a run flaky.
import { describe, expect, test } from "bun:test";

import type {
  Book,
  Chapter,
  EndpointLive,
  ExportItem,
  Job,
  RequestRecord,
  ScriptEndpointTelemetry,
} from "@/types";
import type { EndpointConfig } from "~/db/endpoints";
import { demoClips } from "~/audio/demoClips";
import { audioFiles } from "~/audio/files";
import { createApp } from "~/app";
import { startLive, type DemoLive, type SpeechTelemetry } from "~/demo/live";
import { simulatedEncoders } from "~/demo/encoder";
import { newPace, pacedEncoders, pacedProviders } from "~/demo/pace";
import { seedDemo } from "~/demo/seed";
import { audiobookFiles } from "~/exports/files";
import { exportHandler } from "~/jobs/export";
import { narrationHandler } from "~/jobs/narration";
import { createRunner } from "~/jobs/runner";
import { scriptingHandler } from "~/jobs/scripting";
import { DEMO_BASE } from "~/libraries";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { createSpeechGate } from "~/providers/gate";
import { ffmpegEncoders } from "~/providers/ffmpegEncoder";
import { voiceFiles } from "~/voices/files";
import { epubFile, story } from "../support/epub";
import {
  collectingLogger,
  jsonBody,
  tempAudioDir,
  tempExportDir,
  tempVoiceDir,
  testDb,
} from "../support/server";

/** The demo library, seeded unless the test needs none of the world, running, with the parts `startLive` is handed. */
function demoLibrary({ chapterMs = 0, seeded = true } = {}) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(String(url));
    throw new Error(`the demo made a request: ${String(url)}`);
  }) as unknown as typeof globalThis.fetch;
  const { log } = collectingLogger();
  const db = testDb();
  const files = audioFiles(tempAudioDir(), DEMO_BASE, demoClips(db));
  const pace = newPace();
  const exports = {
    encoders: pacedEncoders(simulatedEncoders(ffmpegEncoders()), pace, chapterMs),
    files: audiobookFiles(tempExportDir()),
  };
  const providers = pacedProviders(
    {
      scripting: endpointScriptingProvider({ fetch, random: () => 1 }),
      speech: endpointSpeechProvider({ fetch, random: () => 1 }),
    },
    pace,
  );
  const gate = createSpeechGate();
  const runner = createRunner(
    db,
    {
      scripting: scriptingHandler(providers.scripting),
      narration: narrationHandler(providers.speech, files, gate),
      export: exportHandler(exports, files),
    },
    { log, pollMs: 60_000 },
  );
  const voices = voiceFiles(tempVoiceDir());
  if (seeded) seedDemo(db, voices, { base: DEMO_BASE, now: Date.now() });
  const app = createApp(db, {
    base: DEMO_BASE,
    log,
    runner,
    files,
    exports,
    providers,
    voiceFiles: voices,
    gate,
  });
  runner.start();

  const fetchDemo = (path: string, init?: RequestInit) =>
    Promise.resolve(app.request(`http://api.test${DEMO_BASE}${path}`, init));
  const request = async <T>(path: string, init?: RequestInit) => {
    const res = await fetchDemo(path, init);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return {
    asked,
    runner,
    pace,
    fetch: fetchDemo,
    request,
    parts: { db, runner, gate, files, exports },
  };
}

type Demo = ReturnType<typeof demoLibrary>;

/** A situation that leaves nothing but what the test names. */
const live = (over: Partial<DemoLive>): DemoLive => ({
  bookId: "cliche",
  runs: [],
  builds: [],
  speech: {},
  scripting: {},
  ...over,
});

const requestsOf = async (demo: Demo, kind: "tts" | "scripting", id: string) =>
  (await demo.request<{ requests: RequestRecord[] }>(`/endpoints/requests?kind=${kind}&id=${id}`))
    .body.requests;

const liveOf = async (demo: Demo) =>
  (await demo.request<{ endpoints: Record<string, EndpointLive> }>("/endpoints/live")).body
    .endpoints;

const jobsOf = async (demo: Demo, bookId: string) =>
  (await demo.request<{ jobs: Job[] }>(`/jobs?bookId=${bookId}`)).body.jobs;

const chaptersOf = async (demo: Demo, bookId: string) =>
  (await demo.request<{ book: Book; chapters: Chapter[] }>(`/books/${bookId}`)).body.chapters;

const exportsOf = async (demo: Demo, bookId: string) =>
  (await demo.request<{ exports: ExportItem[] }>(`/books/${bookId}/exports`)).body.exports;

/** Every speech endpoint answering in `ms`, read by each line as it goes out. */
async function latency(demo: Demo, ms: number): Promise<void> {
  const { body } = await demo.request<EndpointConfig>("/endpoints");
  const saved = await demo.request("/endpoints", {
    ...jsonBody({ ...body, endpoints: body.endpoints.map((e) => ({ ...e, latency: ms })) }),
    method: "PUT",
  });
  expect(saved.status).toBe(200);
}

const RATE_LIMIT_BODY =
  '{"error":{"message":"Rate limit reached. Please retry after 8 seconds.","type":"rate_limit_error"}}';

describe("what an endpoint has been through", () => {
  test("a speech endpoint's history, rate limits and last error are its requests on the ledger", async () => {
    const demo = demoLibrary({ seeded: false });
    const now = Date.now();
    const openai: SpeechTelemetry = {
      history: [
        { t: now - 180_000, ms: 1200, ok: true },
        { t: now - 120_000, ms: 900, ok: false },
        { t: now - 60_000, ms: 1000, ok: true },
      ],
      failures: 1,
      rateLimits: 2,
      backoffUntil: 0,
      lastError: {
        code: 429,
        message: "rate limited",
        body: RATE_LIMIT_BODY,
        retryAfter: 8,
        at: now - 30_000,
      },
    };
    await startLive(demo.parts, live({ speech: { openai } }));

    const rows = await requestsOf(demo, "tts", "openai");
    // three from the history, the 429 on a request of its own, and the rate limit it is not
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.simulated && r.cost === 0 && r.bookId === null)).toBe(true);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(3);
    expect(rows.filter((r) => r.rateLimited)).toHaveLength(2);
    const done = rows.filter((r) => r.status === "done");
    expect(done.map((r) => [r.finishedAt, r.responseMs])).toEqual([
      [now - 60_000, 1000],
      [now - 180_000, 1200],
    ]);
    // newest first, as the Activity list reads them: the 429 is the latest thing that happened
    expect(rows[0]).toMatchObject({
      status: "failed",
      rateLimited: true,
      finishedAt: now - 30_000,
      error: { code: 429, message: "rate limited", body: RATE_LIMIT_BODY, retryAfter: 8 },
    });
    expect(demo.asked).toEqual([]);
  });

  test("a scripting profile's 429 lands on the failure it was met on, with its chapter, and holds no cooldown", async () => {
    const demo = demoLibrary({ seeded: false });
    const form = new FormData();
    form.set(
      "file",
      await epubFile({
        chapters: ["One", "Two", "Three"].map((title) => ({ title, paragraphs: story(1) })),
      }),
    );
    const imported = await demo.request<{ book: Book }>("/books/import", {
      method: "POST",
      body: form,
    });
    expect(imported.status).toBe(201);
    const bookId = imported.body.book.id;
    const now = Date.now();
    const deepseek: ScriptEndpointTelemetry = {
      completed: 0,
      failures: 2,
      rateLimits: 1,
      backoffUntil: now + 20_000,
      lastSuccess: 0,
      history: [
        { at: now - 9000, ms: 0, ok: false },
        { at: now, ms: 0, ok: false },
      ],
      lastError: {
        code: 429,
        message: "Rate limited",
        body: RATE_LIMIT_BODY,
        at: now,
        bookId,
        chapterId: 3,
        model: "deepseek-chat",
        baseUrl: "simulated://api.deepseek.com/v1",
      },
    };
    await startLive(demo.parts, live({ scripting: { deepseek } }));

    const rows = await requestsOf(demo, "scripting", "deepseek");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "failed" && r.simulated)).toBe(true);
    expect(rows[0]).toMatchObject({
      rateLimited: true,
      bookId,
      chapterId: 3,
      label: "Script",
      error: { code: 429, body: RATE_LIMIT_BODY },
    });
    expect(rows[1].rateLimited).toBeUndefined();
    // a rate-limited scripting request waits inside itself; the gate is speech's alone
    expect(await liveOf(demo)).toEqual({});
  });

  test("a speech endpoint cooling down is a cooldown the live route shows, and the next seed forgets it", async () => {
    const demo = demoLibrary({ seeded: false });
    const now = Date.now();
    const fish: SpeechTelemetry = {
      history: [],
      failures: 0,
      rateLimits: 1,
      backoffUntil: now + 30_000,
      lastError: { code: 429, message: "rate limited", body: RATE_LIMIT_BODY, at: now },
    };
    await startLive(demo.parts, live({ speech: { fish } }));
    const cooling = (await liveOf(demo)).fish;
    expect(cooling.rateLimits).toBe(1);
    expect(cooling.backoffUntil).toBeGreaterThanOrEqual(now + 30_000);

    await startLive(demo.parts, live({ speech: { fish: { ...fish, backoffUntil: 0 } } }));
    expect((await liveOf(demo)).fish).toMatchObject({ rateLimits: 0, backoffUntil: 0 });
  });
});

describe("runs in flight", () => {
  test("are queued on the book as the page queues them, and finish on the simulated endpoints", async () => {
    const demo = demoLibrary();
    // the drawer's quickest, so a simulated profile's seconds a chunk do not hold the test up
    demo.pace.speed = 16;
    const asked = Date.now();
    await startLive(
      demo.parts,
      live({
        bookId: "drowned",
        runs: [
          { kind: "scripting", chapterIds: [3, 4, 5] },
          { kind: "narration", chapterIds: [5, 6], bookId: "cliche" },
        ],
      }),
    );

    // one run, to the profile the browser's Script button starts out on — a simulated profile
    // answers at once, so some of it may have finished already
    const run = (await jobsOf(demo, "drowned")).filter((j) => j.queuedAt >= asked);
    expect(run.map((j) => [j.kind, j.chapterId])).toEqual([
      ["scripting", 3],
      ["scripting", 4],
      ["scripting", 5],
    ]);
    expect(new Set(run.map((j) => j.bulk?.id)).size).toBe(1);
    expect(run.every((j) => j.label.endsWith("· OpenAI"))).toBe(true);
    // it waits behind the scripting, and a speech endpoint answers at its latency, so the narration
    // is still going
    const narration = (await jobsOf(demo, "cliche")).filter((j) => !j.finishedAt);
    expect(narration.map((j) => [j.kind, j.chapterId])).toEqual([
      ["narration", 5],
      ["narration", 6],
    ]);

    // the rest of it at once, so the test does not wait out a run of a few hundred lines
    await latency(demo, 0);
    await demo.runner.idle();
    for (const job of [...run, ...narration])
      expect((await demo.request<{ job: Job }>(`/jobs/${job.id}`)).body.job.status).toBe("done");
    const drowned = await chaptersOf(demo, "drowned");
    expect(drowned.filter((c) => [3, 4, 5].includes(c.id)).map((c) => c.scripting)).toEqual([
      "done",
      "done",
      "done",
    ]);
    const cliche = await chaptersOf(demo, "cliche");
    expect(cliche.filter((c) => [5, 6].includes(c.id)).map((c) => c.narration)).toEqual([
      "done",
      "done",
    ]);
    // every request they sent is on the ledger, and none of it was billed
    const sent = await requestsOf(demo, "scripting", "openai");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((r) => r.simulated)).toBe(true);
    expect(demo.asked).toEqual([]);
  });
});

describe("a book's builds", () => {
  test("one failed and waiting for a retry, one running, and the world's finished one", async () => {
    const demo = demoLibrary({ chapterMs: 5 });
    await startLive(demo.parts, live({ bookId: "starforge", builds: ["starforge"] }));

    const exports = await exportsOf(demo, "starforge");
    const failed = exports.find((e) => e.status === "failed")!;
    const running = exports.find((e) => e.status === "building")!;
    expect(failed.filename).toContain("(sample) - earlier attempt");
    expect(failed.error).toBe(`Encoding stopped while writing ${failed.files[0].name}.`);
    expect(running.filename).toContain("(sample) - in progress");
    expect(exports.some((e) => e.status === "done")).toBe(true);
    // the failed one is two chapters short of the running one, as the browser's is
    expect(failed.chapterIds).toEqual(running.chapterIds.slice(0, -2));

    const jobs = (await jobsOf(demo, "starforge")).filter((j) => j.kind === "export");
    const failedJob = jobs.find((j) => j.id === failed.jobId)!;
    expect(failedJob.status).toBe("failed");
    expect(failedJob.activity?.map((e) => e.message)).toContain(
      `Encoder failed while writing ${failed.files[0].name}`,
    );
    expect(jobs.find((j) => j.id === running.jobId)?.status).toBe("running");

    await demo.runner.idle();
    const built = (await exportsOf(demo, "starforge")).find((e) => e.id === running.id)!;
    expect(built.status).toBe("done");
    expect((await demo.fetch(`/books/starforge/exports/${built.id}/files/0`)).status).toBe(200);

    // Retry builds again from what the failed job was asked with, as the page's Retry does
    const run = failedJob.exportRun!;
    const retried = await demo.request<{ export: ExportItem }>(
      "/books/starforge/exports",
      jsonBody({ ids: run.chapterIds, settings: run.settings }),
    );
    expect(retried.status).toBe(202);
    await demo.runner.idle();
    const again = (await exportsOf(demo, "starforge")).find((e) => e.id === retried.body.export.id);
    expect(again?.status).toBe("done");
    expect(demo.asked).toEqual([]);
  });
});
