// Narration against a priced endpoint: every request it sends is priced into the ledger, and every
// way of queuing it is held to the book's budget — before anything is queued, and again before each
// line goes out.
//
// The speech model is the fake, which reports each line it renders as a simulated request, so a
// run is metered and capped exactly as a paid one would be without a request leaving the machine.
// The endpoint bills $15 per million characters, so a line costs a fraction of a cent and a cap of
// a millionth of a dollar is one no line fits.
import { describe, expect, test } from "bun:test";

import type { Book, Character, Endpoint, Job, Segment } from "@/types";
import { expressionParts, expressionPlan } from "@/lib/expressions";
import { narrationCost } from "~/narration/cost";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import { bookSpend, endpointRequests } from "~/usage/ledger";
import { epubFile, story } from "../support/epub";
import { gatedSpeechProvider, jsonBody, testApi, type TestApi } from "../support/server";

const TELEMETRY = { history: [], failures: 0, rateLimits: 0, backoffUntil: 0 };
const speech = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: "studio",
  name: "Studio speech",
  baseUrl: "http://localhost:8880/v1",
  model: "studio-tts",
  concurrency: 2,
  enabled: true,
  latency: 0,
  failRate: 0,
  price: 15,
  billing: { unit: "chars", rate: 15 },
  needsKey: false,
  maxChars: 0,
  splitAt: "sentence",
  voices: [{ id: "ash", gender: "m", label: "Ash" }],
  ...TELEMETRY,
  ...over,
});

interface Queued {
  jobs: Job[];
}
interface Failure {
  error: { code: string; message: string };
}

/** A one-chapter book, scripted, every speaker voiced by `studio/ash` on a priced endpoint. */
async function voiced(api: TestApi, endpoint = speech()): Promise<string> {
  await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [endpoint], profiles: [], credentials: [] }),
    method: "PUT",
  });
  const { body } = await api.import<{ book: Book }>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: [{ title: "One", paragraphs: ["“We are short again,” said Mara.", ...story(2)] }],
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1] }));
  await api.runner.idle();
  const cast = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
  for (const c of cast.body.characters)
    await api.request(`/api/books/${id}/characters/${encodeURIComponent(c.name)}`, {
      ...jsonBody({ ...c, voice: "studio/ash" }),
      method: "PUT",
    });
  return id;
}

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
    // a failed request is still charged for what it sent on a per-character endpoint
    expect(rows.every((r) => (r.cost ?? 0) > 0)).toBe(true);
    expect((await linesOf(api, id)).find((s) => s.id === split.id)?.audio.status).toBe("failed");
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
    const id = await voiced(api);
    const { body } = await narrate(api, id);
    await gate.started;
    await budget(api, id, { cap: 0.000001, paused: false });
    gate.release();
    await api.runner.idle();

    const job = await jobById(api, (body as Queued).jobs[0].id);
    expect(job.status).toBe("failed");
    expect(job.activity?.at(-1)?.detail?.error).toMatch(/^Over the book's .* for the next line/);
    const [first, ...rest] = await linesOf(api, id);
    expect(first.audio.status).toBe("done");
    // the rest were never sent, so they are neither rendered nor failed
    expect(rest.map((s) => s.audio.status)).toEqual(rest.map(() => "none"));
    expect(ledger(api)).toHaveLength(1);
  });
});
