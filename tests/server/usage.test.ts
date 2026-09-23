// The ledger and the budget gate, below the jobs that use them.
//
// A request a provider reported is priced at the card it completed under and appended; a book's
// spending is a sum over those rows and what its unfinished jobs hold; and the one budget question
// is asked of that sum. The jobs' own tests prove each entry point asks it — these prove the answer.
import { describe, expect, test } from "bun:test";

import type { Book, BookSpend, Endpoint, Profile, RequestRecord } from "@/types";
import { makeEndpoints } from "@/mock/fixtures/endpoints";
import { makeProfiles } from "@/mock/fixtures/profiles";
import * as queue from "~/db/jobs";
import type { SentScript, SentSpeech } from "~/providers/sent";
import { budgetProblem } from "~/usage/budget";
import { bookSpend, chapterUidOf, settleScript, settleSpeech } from "~/usage/ledger";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

/** A profile at $2 in / $8 out per million tokens, with no schedule or promotion to move it. */
const profile: Profile = {
  ...makeProfiles().find((p) => p.id === "openai")!,
  inPrice: 2,
  outPrice: 8,
  pricing: undefined,
};

/** A speech endpoint billed per character at $15 per million, or per minute at $0.30. */
const speech = (unit: "chars" | "minute" = "chars"): Endpoint => ({
  ...makeEndpoints()[0]!,
  billing: { unit, rate: unit === "chars" ? 15 : 0.3 },
  pricing: undefined,
});

const at = Date.UTC(2026, 8, 23, 12);

const script = (over: Partial<SentScript> = {}): SentScript => ({
  startedAt: at - 1000,
  finishedAt: at,
  attempts: 1,
  rateLimited: false,
  status: "done",
  simulated: false,
  usage: {
    inputTokens: 1000,
    outputTokens: 500,
    cachedInput: 0,
    cacheWrite: null,
    format: "openai",
    problems: [],
  },
  ...over,
});

const spoken = (over: Partial<SentSpeech> = {}): SentSpeech => ({
  startedAt: at - 500,
  finishedAt: at,
  attempts: 1,
  rateLimited: false,
  status: "done",
  simulated: false,
  text: "Hello there",
  instructions: "",
  audioSeconds: 60,
  reported: null,
  ...over,
});

async function book(api: TestApi = testApi()) {
  const { body } = await api.import<{ book: Book }>(
    await epubFile({ chapters: [{ title: "One", paragraphs: story(2) }] }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  const work = {
    bookId: id,
    chapterUid: chapterUidOf(api.db, id, 1),
    label: "Script chunk 1 · ch 1",
  };
  return { api, id, work };
}

const setBudget = (api: TestApi, id: string, body: unknown) =>
  api.request(`/api/books/${id}`, { ...jsonBody(body), method: "PATCH" });

/** A job holding `reserved` against the book, as a running scripting or narration job does. */
function holding(api: TestApi, bookId: string, kind: "scripting" | "narration", reserved: number) {
  const { job } = queue.enqueueJob(api.db, { kind, bookId, chapterId: 1, label: "held" });
  queue.setReserved(api.db, job.id, reserved);
  return job.id;
}

describe("a request settled into the ledger", () => {
  test("is priced at the card it completed under, and keeps the receipt it was priced from", async () => {
    const { api, work } = await book();
    const row = settleScript(api.db, profile, work, script());
    expect(row.cost).toBeCloseTo((1000 * 2 + 500 * 8) / 1e6, 10);
    expect([row.priced?.at, row.priced?.total]).toEqual([at, row.cost]);
  });

  test("lists an endpoint's requests newest first, with the chapter's number joined on", async () => {
    const { api, work } = await book();
    const now = Date.now();
    const older = settleScript(
      api.db,
      profile,
      work,
      script({ startedAt: now - 2000, finishedAt: now - 1000 }),
    );
    const newer = settleScript(
      api.db,
      profile,
      work,
      script({ startedAt: now - 500, finishedAt: now }),
    );
    const { body } = await api.request<{ requests: RequestRecord[] }>(
      `/api/endpoints/requests?kind=scripting&id=${profile.id}&range=1h`,
    );
    expect(body.requests.map((r) => [r.id, r.chapterId])).toEqual([
      [newer.id, 1],
      [older.id, 1],
    ]);
  });

  test("a scripting request that failed before the provider counted anything costs nothing", async () => {
    const { api, work } = await book();
    const row = settleScript(
      api.db,
      profile,
      work,
      script({ status: "failed", usage: null, error: { code: 500, message: "down" }, attempts: 3 }),
    );
    expect([row.cost, row.status, row.attempts, row.error?.code]).toEqual([0, "failed", 3, 500]);
  });

  test("a failed speech request is charged for what it sent per character, and nothing per minute", async () => {
    const { api, work } = await book();
    const failed = spoken({
      status: "failed",
      audioSeconds: 0,
      error: { code: 500, message: "down" },
    });
    expect(settleSpeech(api.db, speech("chars"), work, failed).cost).toBeCloseTo(
      (11 * 15) / 1e6,
      10,
    );
    expect(settleSpeech(api.db, speech("minute"), work, failed).cost).toBe(0);
  });
});

describe("a book's spending", () => {
  test("sums both kinds of request, and holds only what unfinished jobs reserve", async () => {
    const { api, id, work } = await book();
    const now = Date.now();
    settleScript(api.db, profile, work, script({ finishedAt: now }));
    settleSpeech(api.db, speech("minute"), work, spoken({ finishedAt: now }));
    const done = holding(api, id, "narration", 9);
    queue.finishJob(api.db, done, "done");
    const running = holding(api, id, "scripting", 0.5);
    holding(api, id, "narration", 0.25);

    const { body } = await api.request<{ spend: BookSpend }>(`/api/books/${id}/spend`);
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    expect({
      ...body.spend,
      spent: round(body.spend.spent),
      scriptSpent: round(body.spend.scriptSpent),
      speechSpent: round(body.spend.speechSpent),
    }).toEqual({
      spent: 0.306,
      scriptSpent: 0.006,
      speechSpent: 0.3,
      opening: 0,
      reserved: 0.75,
      scriptReserved: 0.5,
      unpriced: 0,
    });
    // a job asking about itself is not held against itself
    expect(bookSpend(api.db, id, running).reserved).toBe(0.25);
  });

  test("of a book that does not exist is a 404", async () => {
    const api = testApi();
    expect((await api.request("/api/books/nope/spend")).status).toBe(404);
  });
});

describe("the budget gate", () => {
  test("lets anything through a book with no cap, and nothing through a paused one", async () => {
    const { api, id } = await book();
    expect(budgetProblem(api.db, id, { kind: "narration", cost: 1e6 })).toBeNull();
    await setBudget(api, id, { budget: { cap: null, paused: true } });
    expect(budgetProblem(api.db, id, { kind: "narration", cost: 0 })).toContain("is paused");
  });

  test("counts what is spent and what unfinished work holds, so two runs cannot overshoot together", async () => {
    const { api, id, work } = await book();
    await setBudget(api, id, { budget: { cap: 1, paused: false } });
    settleSpeech(api.db, speech("minute"), work, spoken()); // $0.30 spent
    holding(api, id, "narration", 0.5);
    expect(budgetProblem(api.db, id, { kind: "narration", cost: 0.2 })).toBeNull();
    expect(budgetProblem(api.db, id, { kind: "narration", cost: 0.21 })).toMatch(
      /^Over the book's \$1\.00 cap: \$0\.30 spent, \$0\.50 held/,
    );
  });

  test("holds scripting to the script budget as well as the cap, and narration only to the cap", async () => {
    const { api, id, work } = await book();
    await setBudget(api, id, { budget: { cap: 10, paused: false }, scriptBudget: 0.01 });
    settleScript(api.db, profile, work, script()); // $0.006
    expect(budgetProblem(api.db, id, { kind: "scripting", cost: 0.005 })).toMatch(/script budget/);
    expect(budgetProblem(api.db, id, { kind: "narration", cost: 0.005 })).toBeNull();
  });

  test("answers a running job about its own reservation without counting it twice", async () => {
    const { api, id } = await book();
    await setBudget(api, id, { budget: { cap: 1, paused: false } });
    const job = holding(api, id, "narration", 0.8);
    expect(budgetProblem(api.db, id, { kind: "narration", cost: 0.8, jobId: job })).toBeNull();
    await setBudget(api, id, { budget: { cap: 0.5, paused: false } });
    expect(budgetProblem(api.db, id, { kind: "narration", cost: 0.8, jobId: job })).toContain(
      "cap",
    );
  });
});
