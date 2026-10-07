// Narration against a priced endpoint: every request it sends is priced into the ledger, and every
// way of queuing it is held to the book's budget — before anything is queued, and again before each
// line goes out.
//
// The speech model is the fake, which reports each line it renders as a simulated request, so a
// run is metered and capped exactly as a paid one would be without a request leaving the machine.
// The endpoint bills $15 per million characters, so a line costs a fraction of a cent and a cap of
// a millionth of a dollar is one no line fits.
import { describe, expect, test } from "bun:test";

import type { Endpoint, Job, Segment } from "@/types";
import { expressionParts, expressionPlan } from "@/lib/expressions";
import { narrationCost } from "~/narration/cost";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import { heldToday } from "~/usage/budget";
import { bookSpend, CANCELLED, endpointRequests } from "~/usage/ledger";
import { story } from "../support/epub";
import {
  gatedSpeechProvider,
  jsonBody,
  speechEndpoint,
  testApi,
  voicedBook,
  type TestApi,
} from "../support/server";

// $15 per million characters, billed by the character: see the top of the file.
const speech = (over: Partial<Endpoint> = {}): Endpoint =>
  speechEndpoint({ price: 15, billing: { unit: "chars", rate: 15 }, ...over });

interface Queued {
  jobs: Job[];
}
interface Failure {
  error: { code: string; message: string };
}

/** A one-chapter book, scripted, every speaker voiced by `studio/ash` on a priced endpoint. */
const voiced = (api: TestApi, endpoint = speech()) =>
  voicedBook(api, {
    endpoints: [endpoint],
    paragraphs: ["“We are short again,” said Mara.", ...story(2)],
    voiceOf: "studio/ash",
  });

const narrate = (api: TestApi, id: string) =>
  api.request<Queued | Failure>(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [1] }));

const budget = (api: TestApi, id: string, b: { cap: number | null; paused: boolean }) =>
  api.request(`/api/books/${id}`, { ...jsonBody({ budget: b }), method: "PATCH" });

const linesOf = async (api: TestApi, id: string) =>
  (await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`)).body.segments;

const jobById = async (api: TestApi, id: number) =>
  (await api.request<{ job: Job }>(`/api/jobs/${id}`)).body.job;

const ledger = (api: TestApi) => endpointRequests(api.db, "tts", "studio", 0);

describe("what a narration run spends", () => {
  test("is a simulated, priced ledger row for every request — a split line one per part — and the job ends holding nothing", async () => {
    const api = testApi();
    const endpoint = speech({ maxChars: 60 });
    const id = await voiced(api, endpoint);
    const lines = await linesOf(api, id);
    const parts = lines.map((s) => expressionParts(expressionPlan(s, endpoint), endpoint).length);
    expect(parts.some((n) => n > 1)).toBe(true);
    // a cap the run exactly fits: it only runs to the end if each line gives back what it held
    // as it settles, rather than being counted once as spent and again as held
    const { reserved } = narrationCost(api.db, id, lines);
    await budget(api, id, { cap: reserved, paused: false });

    const { status, body } = await narrate(api, id);
    expect(status).toBe(202);
    const [queued] = (body as Queued).jobs;
    expect(queued.narrationRun?.reserved).toBe(reserved);
    await api.runner.idle();
    expect((await jobById(api, queued.id)).status).toBe("done");

    const rows = ledger(api);
    expect(rows).toHaveLength(parts.reduce((a, n) => a + n, 0));
    for (const r of rows) {
      expect(r).toMatchObject({ kind: "tts", bookId: id, chapterId: 1, status: "done" });
      expect(r.simulated).toBe(true);
      expect(r.cost).toBeGreaterThan(0);
    }
    // every part of a line is filed under the line
    for (const [i, s] of lines.entries())
      expect(rows.filter((r) => r.label === `Line ${s.id} · ${s.speaker}`)).toHaveLength(parts[i]);
    expect((await jobById(api, queued.id)).narrationRun?.reserved).toBe(0);
    const spend = bookSpend(api.db, id);
    expect(spend.reserved).toBe(0);
    expect(spend.speechSpent).toBeCloseTo(
      rows.reduce((a, r) => a + (r.cost ?? 0), 0),
      12,
    );
  });

  test("a cancelled run ends holding nothing, with the lines it never sent still unpaid", async () => {
    const gate = gatedSpeechProvider();
    const api = testApi({ speech: gate.provider });
    const id = await voiced(api);
    const { body } = await narrate(api, id);
    const [queued] = (body as Queued).jobs;
    expect(queued.narrationRun?.reserved).toBeGreaterThan(0);
    await gate.started;
    await api.request(`/api/jobs/${queued.id}/cancel`, { method: "POST" });
    await api.runner.idle();

    const job = await jobById(api, queued.id);
    expect(job.status).toBe("cancelled");
    expect(job.narrationRun?.reserved).toBe(0);
    expect(bookSpend(api.db, id).reserved).toBe(0);
  });

  test("a part that fails leaves the parts before it charged", async () => {
    const endpoint = speech({ maxChars: 60 });
    let second = "";
    const api = testApi({ speech: fakeSpeechProvider({ failLines: (t) => t === second }) });
    const id = await voiced(api, endpoint);
    const lines = await linesOf(api, id);
    const split = lines.find(
      (s) => expressionParts(expressionPlan(s, endpoint), endpoint).length > 1,
    )!;
    second = expressionParts(expressionPlan(split, endpoint), endpoint)[1].text.trim();

    await narrate(api, id);
    await api.runner.idle();
    const rows = ledger(api).filter((r) => r.label === `Line ${split.id} · ${split.speaker}`);
    expect(rows.map((r) => r.status).sort()).toEqual(["done", "failed"]);
    // the part that went through is charged; the one refused is a row that costs nothing
    expect(Object.fromEntries(rows.map((r) => [r.status, (r.cost ?? 0) > 0]))).toEqual({
      done: true,
      failed: false,
    });
    expect((await linesOf(api, id)).find((s) => s.id === split.id)?.audio.status).toBe("failed");
  });
});

describe("a line sent to a real provider", () => {
  /**
   * A speech server that answers nothing until the request is closed, as one mid-way through a
   * line is; `started` once the first request has gone out.
   */
  function silentServer() {
    let onStart!: () => void;
    const started = new Promise<void>((r) => (onStart = r));
    let requests = 0;
    const fetch = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        requests++;
        onStart();
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      })) as unknown as typeof globalThis.fetch;
    return { fetch, started, requests: () => requests };
  }

  test("cancelled once it was out is one row at a cost nobody knows, counted at what it held; the line still queued leaves none", async () => {
    const server = silentServer();
    const api = testApi({
      speech: endpointSpeechProvider({ fetch: server.fetch, backoffMs: () => 0 }),
    });
    // one at a time, so the next line is still waiting for its slot when the run is cancelled
    const id = await voiced(api, speech({ concurrency: 1, batch: false }));
    expect((await linesOf(api, id)).length).toBeGreaterThan(1);
    const { body } = await narrate(api, id);
    const [queued] = (body as Queued).jobs;
    await server.started;
    await api.request(`/api/jobs/${queued.id}/cancel`, { method: "POST" });
    await api.runner.idle();

    expect(server.requests()).toBe(1);
    const rows = ledger(api);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "cancelled", cost: null, costBasis: "unknown" });
    expect(rows[0].simulated).toBe(false);
    expect(rows[0].speech?.unknowns).toEqual([CANCELLED]);
    // never $0: the budgets count the line's worst case in its place, which the job gave back
    const spend = bookSpend(api.db, id);
    expect(spend.unpriced).toBe(1);
    expect(spend.spent).toBeGreaterThan(0);
    expect(spend.reserved).toBe(0);
    expect((await jobById(api, queued.id)).narrationRun?.reserved).toBe(0);
    expect(heldToday(api.db, "tts", "studio")).toBe(0);
  });

  test("refused, and not billed by its provider, is a row that costs nothing", async () => {
    const fetch = (async () =>
      new Response("no such voice", { status: 400 })) as unknown as typeof globalThis.fetch;
    const api = testApi({ speech: endpointSpeechProvider({ fetch, backoffMs: () => 0 }) });
    const id = await voiced(api, speech({ batch: false }));
    await narrate(api, id);
    await api.runner.idle();

    const rows = ledger(api);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows)
      expect(r).toMatchObject({ status: "failed", cost: 0, costBasis: "calculated" });
    expect(bookSpend(api.db, id)).toMatchObject({ spent: 0, reserved: 0, unpriced: 0 });
    expect(heldToday(api.db, "tts", "studio")).toBe(0);
  });
});

describe("the budget", () => {
  test.each([
    ["a cap the run does not fit", { cap: 0.000001, paused: false }, /^Over the book's \$0\.00/],
    ["a paused book", { cap: null, paused: true }, /is paused/],
  ])("refuses a run with %s, and queues nothing", async (_, b, why) => {
    const api = testApi();
    const id = await voiced(api);
    await budget(api, id, b);
    const before = await linesOf(api, id);
    const { status, body } = await narrate(api, id);
    expect(status).toBe(409);
    expect((body as Failure).error.message).toMatch(why);
    expect(api.runner.running).toBeNull();
    const { jobs } = (await api.request<{ jobs: Job[] }>("/api/jobs")).body;
    expect(jobs.filter((j) => j.kind === "narration")).toEqual([]);
    expect(await linesOf(api, id)).toEqual(before);
  });

  test("refuses a retake that does not fit, and leaves the line without one", async () => {
    const api = testApi();
    const id = await voiced(api);
    await narrate(api, id);
    await api.runner.idle();
    await budget(api, id, { cap: bookSpend(api.db, id).spent, paused: false });
    const [line] = await linesOf(api, id);
    const { status, body } = await api.request<Failure>(`/api/books/${id}/chapters/1/retakes`, {
      ...jsonBody({ ids: [line.id] }),
    });
    expect(status).toBe(409);
    expect(body.error.message).toMatch(/^Over the book's .* for this retake/);
    expect((await linesOf(api, id))[0]).toEqual(line);
  });

  test("lowered mid-run stops the job before its next line, and keeps the clip that landed", async () => {
    const gate = gatedSpeechProvider();
    const api = testApi({ speech: gate.provider });
    // one line out at a time, so "the next line" is every line after the first
    const id = await voiced(api, speech({ concurrency: 1 }));
    const { body } = await narrate(api, id);
    await gate.started;
    await budget(api, id, { cap: 0.000001, paused: false });
    gate.release();
    await api.runner.idle();

    const job = await jobById(api, (body as Queued).jobs[0].id);
    expect(job.status).toBe("failed");
    expect(job.activity?.at(-1)?.detail?.error).toMatch(/^Over the book's .* for the next line/);
    // the lines it never sent are not held once it has stopped
    expect(job.narrationRun?.reserved).toBe(0);
    const [first, ...rest] = await linesOf(api, id);
    expect(first.audio.status).toBe("done");
    // the rest were never sent, so they are neither rendered nor failed
    expect(rest.map((s) => s.audio.status)).toEqual(rest.map(() => "none"));
    expect(ledger(api)).toHaveLength(1);
  });

  test("lowered mid-run lets the lines already out land and be charged, and sends no more", async () => {
    const gate = gatedSpeechProvider();
    const api = testApi({ speech: gate.provider });
    const id = await voiced(api, speech({ concurrency: 2 }));
    const { body } = await narrate(api, id);
    await gate.started;
    // both slots taken before the cap drops: the second line is out as surely as the first
    for (let i = 0; i < 50; i++) {
      const out = (await linesOf(api, id)).filter((s) => s.audio.status === "generating");
      if (out.length === 2) break;
      await Bun.sleep(5);
    }
    await budget(api, id, { cap: 0.000001, paused: false });
    gate.release();
    await api.runner.idle();

    const job = await jobById(api, (body as Queued).jobs[0].id);
    expect(job.status).toBe("failed");
    expect(job.activity?.at(-1)?.detail?.error).toMatch(/^Over the book's .* for the next line/);
    const statuses = (await linesOf(api, id)).map((s) => s.audio.status);
    expect(statuses.slice(0, 2)).toEqual(["done", "done"]);
    expect(statuses.slice(2)).toEqual(statuses.slice(2).map(() => "none"));
    expect(ledger(api)).toHaveLength(2);
    expect(bookSpend(api.db, id).reserved).toBe(0);
  });
});
