// The ledger and the budget gate, below the jobs that use them.
//
// A request a provider reported is priced at the card it completed under and appended; a book's
// spending is a sum over those rows and what its unfinished jobs hold; and the one budget question
// is asked of that sum. The jobs' own tests prove each entry point asks it — these prove the answer.
import { describe, expect, test } from "bun:test";

import type { Book, BookSpend, Endpoint, Profile, RangeKey, RequestRecord } from "@/types";
import type { EndpointSummary, RequestPage } from "@/services/endpoints";
import * as queue from "~/db/jobs";
import type { SentScript, SentSpeech } from "~/providers/sent";
import { budgetProblem } from "~/usage/budget";
import {
  append,
  bookSpend,
  chapterUidOf,
  endpointSummary,
  NOT_BILLED,
  requestPage,
  settleScript,
  settleSpeech,
  type RequestWhere,
} from "~/usage/ledger";
import { epubFile, story } from "../support/epub";
import { jsonBody, speechEndpoint, testApi, type TestApi } from "../support/server";
import { openaiProfile } from "../support/profiles";

/** A profile at $2 in / $8 out per million tokens, with no schedule or promotion to move it. */
const profile: Profile = {
  ...openaiProfile(),
  inPrice: 2,
  outPrice: 8,
  pricing: undefined,
};

/** A speech endpoint billed per character at $15 per million, or per minute at $0.30. */
const speech = (unit: "chars" | "minute" = "chars"): Endpoint =>
  speechEndpoint({ billing: { unit, rate: unit === "chars" ? 15 : 0.3 }, pricing: undefined });

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
  billed: true,
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
    label: "Script chunk 1",
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

  test("a speech request the provider did not bill is a row that costs nothing, and says why", async () => {
    const { api, work } = await book();
    const refused = spoken({
      status: "failed",
      audioSeconds: 0,
      billed: false,
      error: { code: 401, message: "key refused" },
    });
    const row = settleSpeech(api.db, speech("chars"), work, refused);
    expect([row.status, row.cost, row.error?.code]).toEqual(["failed", 0, 401]);
    // what it sent is still counted, and the receipt says why none of it was charged
    expect(row.usage.chars).toBe(11);
    expect(row.speech?.lines).toEqual([
      expect.objectContaining({ quantity: 11, amount: 0, note: NOT_BILLED }),
    ]);
  });

  test("a billed speech request that failed is charged for what it sent per character, and nothing per minute", async () => {
    const { api, work } = await book();
    const unusable = spoken({
      status: "failed",
      audioSeconds: 0,
      billed: true,
      error: { code: 200, message: "sent no audio" },
    });
    expect(settleSpeech(api.db, speech("chars"), work, unusable).cost).toBeCloseTo(
      (11 * 15) / 1e6,
      10,
    );
    expect(settleSpeech(api.db, speech("minute"), work, unusable).cost).toBe(0);
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

// ---------- an endpoint's past, as the Endpoints page reads it ----------

const NOW = Date.UTC(2026, 8, 23, 12);

/** A settled request against endpoint `p`, finished ten minutes before NOW unless told otherwise. */
const settled = (over: Partial<RequestRecord> = {}): Omit<RequestRecord, "id" | "chapterId"> => ({
  endpointId: "p",
  kind: "scripting",
  bookId: null,
  label: "chunk",
  status: "done",
  attempts: 1,
  queuedAt: NOW - 11 * 60_000,
  startedAt: NOW - 10.5 * 60_000,
  finishedAt: NOW - 10 * 60_000,
  queueMs: 5000,
  responseMs: 5000,
  usage: { inputTokens: 1000, outputTokens: 500 },
  cost: 0.001,
  costBasis: "calculated",
  simulated: true,
  ...over,
});

/** The summary of endpoint `p` over `range` up to NOW, from the rows `over` describes. */
function summarised(rows: Partial<RequestRecord>[], range: RangeKey = "1h", kind = rows[0]?.kind) {
  const api = testApi();
  for (const r of rows) append(api.db, settled(r), null);
  return endpointSummary(api.db, kind ?? "scripting", "p", range, NOW, NOW - 3_600_000).series;
}

describe("an endpoint's summary", () => {
  test("counts every request in the range, not a page of them: 2,001 at $1 is $2,001", async () => {
    const api = testApi();
    const now = Date.now();
    api.db.transaction((tx) => {
      for (let i = 0; i < 2001; i++)
        append(
          tx,
          settled({ cost: 1, finishedAt: now - 1000 - i * 100, queuedAt: now - 60_000 }),
          null,
        );
    });
    const { body } = await api.request<{ summary: EndpointSummary }>(
      `/api/endpoints/summary?kind=scripting&id=p&range=1h&today=${now - 3_600_000}`,
    );
    const { series, today } = body.summary;
    expect(series.totals.requests).toBe(2001);
    expect(series.totals.cost).toBe(2001);
    expect(today.cost).toBe(2001);
    expect(series.buckets.reduce((n, b) => n + b.cost, 0)).toBe(2001);
    expect(series.buckets.reduce((n, b) => n + b.requests, 0)).toBe(2001);

    // the list reads every one of them across its pages, each once
    const seen = new Set<string>();
    let before: string | null = null;
    let pages = 0;
    do {
      const q: string = before ? `&before=${before}` : "";
      const page = (
        await api.request<RequestPage>(
          `/api/endpoints/requests?kind=scripting&id=p&range=1h&limit=500${q}`,
        )
      ).body;
      expect([page.total, page.of]).toEqual([2001, 2001]);
      for (const r of page.requests) seen.add(r.id);
      before = page.next;
      pages++;
    } while (before);
    expect(seen.size).toBe(2001);
    expect(pages).toBe(5);

    // and a clicked bucket lists exactly the requests the bucket counted
    const spike = series.buckets.find((b) => b.requests)!;
    const { body: inside } = await api.request<RequestPage>(
      `/api/endpoints/requests?kind=scripting&id=p&range=1h&limit=2000&from=${spike.from}&to=${spike.to}`,
    );
    expect(inside.total).toBe(spike.requests);
    expect(inside.requests).toHaveLength(spike.requests);
    expect(
      inside.requests.every((r) => r.finishedAt! >= spike.from && r.finishedAt! < spike.to),
    ).toBe(true);
  });

  test("a request whose cost is unknown is counted as unknown, whatever its status", () => {
    const s = summarised([
      { cost: 0.25 },
      { cost: null, costBasis: "unknown" },
      { cost: null, costBasis: "unknown", status: "cancelled" },
    ]);
    expect(s.totals.cost).toBe(0.25);
    expect(s.totals.unknownCost).toBe(2);
    expect(s.buckets.reduce((n, b) => n + b.unknownCost, 0)).toBe(2);
  });

  test("keeps the wait for a slot and the provider's answer apart", () => {
    const s = summarised([
      { queueMs: 2000, responseMs: 8000 },
      { queueMs: 4000, responseMs: 6000 },
    ]);
    expect(s.totals.requests).toBe(2);
    expect(s.totals.queueMs).toBe(3000);
    expect(s.totals.responseMs).toBe(7000);
  });

  test("reads the 95th percentile over every request that came back, per bucket and in all", () => {
    const times = Array.from({ length: 40 }, (_, i) => (i + 1) * 100);
    const s = summarised(times.map((responseMs) => ({ responseMs })));
    // the value 95% of the way up the sorted times: the 39th of 40
    expect(s.totals.p95Ms).toBe(3900);
    expect(s.buckets.find((b) => b.requests)!.p95Ms).toBe(3900);
    expect(summarised([{ responseMs: 700 }]).totals.p95Ms).toBe(700);
  });

  test("throughput is tokens a minute for scripting and audio minutes a minute for speech", () => {
    const tokens = summarised([{ usage: { inputTokens: 600, outputTokens: 0 } }]);
    expect(tokens.totals.throughput).toBeCloseTo(10, 6); // 600 tokens over 60 minutes
    const audio = summarised([{ kind: "tts", usage: { chars: 100, audioSeconds: 600 } }]);
    expect(audio.totals.throughput).toBeCloseTo(10 / 60, 6); // 10 audio minutes over 60
    const heard = summarised([{ kind: "transcription", usage: { audioSeconds: 1200 } }]);
    expect(heard.totals.throughput).toBeCloseTo(20 / 60, 6);
  });

  test("throughput is unknown, not zero, when no finished request reported usage", () => {
    const noUsage = { usage: {}, cost: null, costBasis: "unknown" as const };
    const s = summarised([noUsage, noUsage]);
    expect(s.totals.throughput).toBeNull();
    expect(s.totals.unreported).toBe(2);
    expect(s.totals.unknownCost).toBe(2);
    expect(s.buckets.filter((b) => b.requests).map((b) => b.throughput)).toEqual([null]);
    // the rest of the range ran nothing, which is a measured zero
    expect(s.buckets.filter((b) => !b.requests).every((b) => b.throughput === 0)).toBe(true);
    // a speech endpoint that never learned how much audio came back is the same
    expect(summarised([{ kind: "tts", usage: { chars: 40 } }]).totals.throughput).toBeNull();
  });

  test("a mix measures throughput over the requests that reported and counts the rest", () => {
    const s = summarised([
      { usage: { inputTokens: 600, outputTokens: 0 } },
      { usage: {} },
      // failed without usage: it produced nothing, which is known
      { usage: {}, status: "failed" },
    ]);
    expect(s.totals.throughput).toBeCloseTo(10, 6);
    expect(s.totals.unreported).toBe(1);
  });

  test("an empty range has zero throughput and nothing unreported", () => {
    const s = summarised([], "1h", "scripting");
    expect([s.totals.requests, s.totals.throughput, s.totals.unreported]).toEqual([0, 0, 0]);
    expect(s.buckets).toHaveLength(24);
  });

  test("requests outside the range do not reach the buckets", () => {
    const old = { finishedAt: NOW - 5 * 3600e3, queuedAt: NOW - 5 * 3600e3 - 1000 };
    expect(summarised([old], "1h").totals.requests).toBe(0);
    expect(summarised([old], "6h").totals.requests).toBe(1);
  });

  test("a cache percentage divides by the input of the requests that reported one", () => {
    const { totals } = summarised([
      // reported: 4,000 of 10,000 cached
      { usage: { inputTokens: 10_000, outputTokens: 0, cachedInput: 4000 } },
      // said nothing at all: its 90,000 input tokens are not evidence of a miss
      { usage: { inputTokens: 90_000, outputTokens: 0 } },
    ]);
    expect(totals.inputTokens).toBe(100_000);
    expect(totals.cacheReported).toBe(1);
    expect(totals.cachedInputTokens).toBe(4000);
    // 40% of what was reported on, not 4% of everything that went out
    expect(totals.cacheReportedInputTokens).toBe(10_000);
  });

  test("says what was spent today and when the endpoint last settled anything, ever", () => {
    const api = testApi();
    append(api.db, settled({ cost: 2, finishedAt: NOW - 2 * 3600e3 }), null);
    append(api.db, settled({ cost: 3, finishedAt: NOW - 600_000 }), null);
    append(api.db, settled({ cost: null, costBasis: "unknown", finishedAt: NOW - 300_000 }), null);
    const day = endpointSummary(api.db, "scripting", "p", "1h", NOW, NOW - 3600e3);
    expect(day.today).toEqual({ cost: 3, unknown: 1 });
    expect(day.lastSeen).toBe(NOW - 300_000);
  });
});

describe("an endpoint's request list", () => {
  test("filters by status, book and words on the server, and still says how many the range holds", () => {
    const api = testApi();
    append(api.db, settled({ label: "Script chunk 1" }), null);
    append(api.db, settled({ label: "Script chunk 2", status: "failed" }), null);
    append(
      api.db,
      settled({
        label: "Script chunk 3",
        status: "failed",
        error: { code: 429, message: "Slow down", body: "" },
      }),
      null,
    );
    const page = (where: Partial<RequestWhere>) =>
      requestPage(api.db, "scripting", "p", { since: NOW - 3600e3, ...where }, { limit: 10 });
    expect(page({ status: "failed" }).total).toBe(2);
    expect(page({ search: "SLOW" }).requests.map((r) => r.label)).toEqual(["Script chunk 3"]);
    expect(page({ search: "chunk 1" })).toMatchObject({ total: 1, of: 3 });
    expect(page({ bookId: "nope" }).total).toBe(0);
  });
});
