// An endpoint's daily limit: what it may be charged since local midnight, across every book.
//
// It is asked per request, not per run — a long run legitimately spans days — so a run is refused
// before anything is queued only when the limit cannot cover even its first request, and otherwise
// stops before the request that would pass it, keeping what already landed. "Spent" is the ledger
// since midnight plus what requests out at the endpoint right now hold.
//
// The speech model is the fake, which reports each line as a priced request on an endpoint billing
// $15 per million characters; a line's worst case is then exactly what it is charged, so a limit a
// hair over the first line's figure lets exactly one line through.
import { describe, expect, test } from "bun:test";

import type { Book, Endpoint, Job, Profile, RequestRecord, Segment } from "@/types";
import { makeCredentials } from "~/demo/seed/fixtures/credentials";
import { narrationCost } from "~/narration/cost";
import { fakeScriptingProvider } from "~/providers/fake";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import type { ScriptingProvider } from "~/providers/scripting";
import { budgetProblem, heldToday, holdToday, startOfToday } from "~/usage/budget";
import { append, endpointRequests } from "~/usage/ledger";
import { epubFile, story } from "../support/epub";
import { openaiProfile } from "../support/profiles";
import {
  gatedSpeechProvider,
  jsonBody,
  saveEndpoints,
  speechEndpoint,
  testApi,
  voicedBook,
  type TestApi,
} from "../support/server";

const speech = (over: Partial<Endpoint> = {}): Endpoint =>
  speechEndpoint({ price: 15, billing: { unit: "chars", rate: 15 }, concurrency: 1, ...over });

interface Queued {
  jobs: Job[];
}
interface Failure {
  error: { code: string; message: string };
}

const voiced = (api: TestApi, endpoint = speech(), chapters = ["One"]) =>
  voicedBook(api, {
    endpoints: [endpoint],
    paragraphs: ["“We are short again,” said Mara.", ...story(2)],
    voiceOf: "studio/ash",
    chapters,
  });

const narrate = (api: TestApi, id: string, ids = [1]) =>
  api.request<Queued | Failure>(`/api/books/${id}/chapters/narrate`, jsonBody({ ids }));

const linesOf = async (api: TestApi, id: string, chapter = 1) =>
  (await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/${chapter}/script`)).body
    .segments;

const jobById = async (api: TestApi, id: number) =>
  (await api.request<{ job: Job }>(`/api/jobs/${id}`)).body.job;

/** The worst case of the chapter's first line, and of the whole chapter, on `studio`. */
async function figures(api: TestApi, id: string) {
  const cost = narrationCost(api.db, id, await linesOf(api, id));
  const first = cost.firsts.find((f) => f.endpoint === "studio")!.cost;
  expect(first).toBeGreaterThan(0);
  return { first, whole: cost.reserved };
}

/** A settled request charged `cost` on `studio` at `at`, as another book's would be. */
const spent = (api: TestApi, cost: number, at: number) =>
  append(
    api.db,
    {
      endpointId: "studio",
      kind: "tts",
      bookId: null,
      label: "Elsewhere",
      status: "done",
      attempts: 1,
      queuedAt: at,
      startedAt: at,
      finishedAt: at,
      queueMs: 0,
      responseMs: 0,
      usage: {},
      cost,
      costBasis: "calculated",
      simulated: false,
    } satisfies Omit<RequestRecord, "id" | "chapterId">,
    null,
  );

describe("a speech endpoint's daily limit", () => {
  test("lets a run bigger than itself queue, spends up to it, and stops before the line that would pass it", async () => {
    const api = testApi();
    const id = await voiced(api);
    const { first, whole } = await figures(api, id);
    const limit = first * 1.001;
    expect(whole).toBeGreaterThan(limit);
    await saveEndpoints(api, [speech({ spendLimit: limit })]);

    const { status, body } = await narrate(api, id);
    expect(status).toBe(202);
    await api.runner.idle();

    const job = await jobById(api, (body as Queued).jobs[0].id);
    expect(job.status).toBe("failed");
    expect(String(job.activity?.at(-1)?.detail?.error)).toMatch(
      /^Studio speech's \$.+ daily limit is reached: \$.+ spent today, \$.+ for the next line .+ Raise it on the endpoint's Pricing tab, or run it again tomorrow\.$/,
    );
    const [line, ...rest] = await linesOf(api, id);
    expect(line.audio.status).toBe("done");
    expect(rest.map((s) => s.audio.status)).toEqual(rest.map(() => "none"));
    expect(endpointRequests(api.db, "tts", "studio", 0)).toHaveLength(1);
    expect(heldToday(api.db, "tts", "studio")).toBe(0);
  });

  test("refuses a run before anything is queued only when it cannot cover the first line", async () => {
    const api = testApi();
    const id = await voiced(api);
    const { first } = await figures(api, id);
    await saveEndpoints(api, [speech({ spendLimit: first / 2 })]);
    const before = await linesOf(api, id);

    const { status, body } = await narrate(api, id);
    expect(status).toBe(409);
    expect((body as Failure).error.message).toMatch(
      /^Studio speech's .+ daily limit is reached: .+ for the first line/,
    );
    const { jobs } = (await api.request<{ jobs: Job[] }>("/api/jobs")).body;
    expect(jobs.filter((j) => j.kind === "narration")).toEqual([]);
    expect(await linesOf(api, id)).toEqual(before);
  });

  test("counts what was spent since midnight, not before it", async () => {
    const api = testApi();
    const id = await voiced(api);
    await saveEndpoints(api, [speech({ spendLimit: 1 })]);

    spent(api, 100, startOfToday() - 60_000);
    expect((await narrate(api, id)).status).toBe(202);
    await api.runner.idle();

    spent(api, 100, Date.now());
    const { status, body } = await narrate(api, id);
    expect(status).toBe(409);
    expect((body as Failure).error.message).toMatch(/\$100\.00 spent today/);
  });

  test("counts what requests out at the endpoint right now hold", async () => {
    const gate = gatedSpeechProvider();
    const api = testApi({ speech: gate.provider });
    const id = await voiced(api, speech(), ["One", "Two"]);
    const { first } = await figures(api, id);
    await saveEndpoints(api, [speech({ spendLimit: first * 1.5 })]);

    expect((await narrate(api, id, [1])).status).toBe(202);
    await gate.started;
    expect(heldToday(api.db, "tts", "studio")).toBeCloseTo(first, 12);
    // chapter two opens on the same line: alone it fits, beside the one out it does not
    const { status, body } = await narrate(api, id, [2]);
    expect(status).toBe(409);
    expect((body as Failure).error.message).toContain("held by requests out now");

    gate.release();
    await api.runner.idle();
    expect(heldToday(api.db, "tts", "studio")).toBe(0);
  });

  test("of none is no limit at all", async () => {
    const api = testApi();
    const id = await voiced(api);
    await saveEndpoints(api, [speech({ spendLimit: null })]);
    spent(api, 1_000_000, Date.now());

    const { status, body } = await narrate(api, id);
    expect(status).toBe(202);
    await api.runner.idle();
    expect((await jobById(api, (body as Queued).jobs[0].id)).status).toBe("done");
  });

  test("holds a voice sample to it, which is billed to the endpoint with no book", async () => {
    const api = testApi({ samples: fakeSpeechProvider() });
    await saveEndpoints(api, [speech({ spendLimit: 1 })]);
    spent(api, 1, Date.now());
    const { status, body } = await api.request<Failure>(
      "/api/endpoints/sample",
      jsonBody({ id: "studio", voice: "ash" }),
    );
    expect(status).toBe(409);
    expect(body.error.message).toMatch(/daily limit is reached: .+ for this voice sample/);
  });
});

describe("the daily limit's arithmetic", () => {
  test("what is held is given back in parts, never more than was held", async () => {
    const api = testApi();
    await saveEndpoints(api, [speech({ spendLimit: 1 })]);
    const ask = {
      kind: "narration" as const,
      cost: 0,
      requests: [{ endpoint: "studio", cost: 0.6 }],
    };
    const give = holdToday(api.db, "tts", "studio", 0.5);
    expect(budgetProblem(api.db, null, ask)).toMatch(/\$0\.50 held by requests out now/);
    give(0.2);
    expect(heldToday(api.db, "tts", "studio")).toBeCloseTo(0.3, 12);
    expect(budgetProblem(api.db, null, ask)).toBeNull();
    give();
    give(5);
    expect(heldToday(api.db, "tts", "studio")).toBe(0);
  });
});

describe("a scripting profile's daily limit", () => {
  const profile = (over: Partial<Profile> = {}): Profile =>
    openaiProfile({ maxChars: 700, splitAt: "sentence", concurrency: 1, ...over });
  /** A book on the shelf, its review done, with one chapter of `paragraphs`. */
  const shelved = async (api: TestApi, paragraphs: string[]) => {
    const { body } = await api.import<{ book: Book }>(
      await epubFile({ chapters: [{ title: "One", paragraphs }] }),
    );
    await api.request(`/api/books/${body.book.id}/confirm`, { method: "POST" });
    return body.book.id;
  };
  const saveProfile = (api: TestApi, p: Profile) =>
    api.request("/api/endpoints", {
      ...jsonBody({ endpoints: [], profiles: [p], credentials: makeCredentials() }),
      method: "PUT",
    });

  test("lowered under a running job stops it before its next request, keeping what was paid for", async () => {
    // the fake, with its first request held until the test says so
    const inner = fakeScriptingProvider();
    let onStart!: () => void;
    let onRelease!: () => void;
    const started = new Promise<void>((r) => (onStart = r));
    const gate = new Promise<void>((r) => (onRelease = r));
    let calls = 0;
    const held: ScriptingProvider = {
      name: inner.name,
      async script(input) {
        if (++calls === 1) {
          onStart();
          await gate;
        }
        return inner.script(input);
      },
    };
    const api = testApi({ scripting: held });
    const id = await shelved(api, ["“We are short again,” said Mara.", ...story(12)]);
    await saveProfile(api, profile());
    const { status, body } = await api.request<Queued>(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1], profile: "openai" }),
    );
    expect(status).toBe(202);
    await started;
    await saveProfile(api, profile({ spendLimit: 0 }));
    onRelease();
    await api.runner.idle();

    const job = await jobById(api, body.jobs[0].id);
    expect(job.status).toBe("failed");
    expect(String(job.activity?.at(-1)?.detail?.error)).toMatch(
      /^OpenAI's \$0\.00 daily limit is reached: .+ for the next request/,
    );
    expect(calls).toBe(1);
    expect(endpointRequests(api.db, "scripting", "openai", 0)).toHaveLength(1);
    expect(heldToday(api.db, "scripting", "openai")).toBe(0);
  });

  test("refuses a run whose first request it cannot cover", async () => {
    const api = testApi();
    const id = await shelved(api, story(2));
    await saveProfile(api, profile({ spendLimit: 0 }));
    const { status, body } = await api.request<Failure>(
      `/api/books/${id}/chapters/script`,
      jsonBody({ ids: [1], profile: "openai" }),
    );
    expect(status).toBe(409);
    expect(body.error.message).toMatch(
      /^OpenAI's .+ daily limit is reached: .+ for the first request/,
    );
  });
});
