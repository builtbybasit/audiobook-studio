// Narration as its endpoints will take it: up to each endpoint's concurrency at once, lines for
// two endpoints alongside each other, nothing to an endpoint that is paused until it is resumed, and
// nothing more to one that was rate limited until its cooldown ends — the speech gate
// (`server/providers/gate.ts`) as the narration job uses it, through the real runner and routes.
//
// The provider here is the tone-rendering fake with a short pause per line, wrapped to count how
// many lines are inside it per endpoint at any moment. The pause is what gives lines the chance to
// overlap; a count that never passes the limit holds however the timing falls.
import { describe, expect, test } from "bun:test";

import type { Endpoint, Job, Segment } from "@/types";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import type { SpeechProvider } from "~/providers/speech";
import { story } from "../support/epub";
import {
  jsonBody,
  saveEndpoints,
  speechEndpoint,
  testApi,
  voicedBook,
  type TestApi,
} from "../support/server";

// One line at a time unless a test says otherwise: the limit is what every test here is about.
const speech = (id: string, over: Partial<Endpoint> = {}): Endpoint =>
  speechEndpoint({ id, concurrency: 1, ...over });

/**
 * A scripted one-chapter book whose speakers are cast by `voiceOf`, the endpoints saved first. The
 * chapter is its title, two spoken lines with their tags and four of the story's paragraphs — a
 * dozen lines, enough to fill any limit here with lines still waiting, and at the one-at-a-time
 * pace of a concurrency of one no longer than it needs to be.
 */
const book = (
  api: TestApi,
  endpoints: Endpoint[],
  voiceOf: (name: string) => string = () => `${endpoints[0].id}/ash`,
) =>
  voicedBook(api, {
    endpoints,
    paragraphs: [
      "“We are short again,” said Mara.",
      "“Then we count it twice,” said Tobin.",
      ...story(4),
    ],
    voiceOf,
  });

const narrate = async (api: TestApi, id: string) =>
  (await api.request<{ jobs: Job[] }>(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [1] })))
    .body.jobs[0];

const linesOf = async (api: TestApi, id: string): Promise<Segment[]> =>
  (await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`)).body.segments;

const jobById = async (api: TestApi, id: number) =>
  (await api.request<{ job: Job }>(`/api/jobs/${id}`)).body.job;

/** Wait, briefly, for something the run does on its own time; fail saying what never happened. */
async function until(what: string, ok: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The fake with a pause per line, counting the lines inside it per endpoint — how many now, the
 * most at once, the most across every endpoint together — and when each line started.
 */
function counting(delayMs = 15, around?: SpeechProvider["speak"]) {
  const inner = fakeSpeechProvider({ delayMs });
  const now = new Map<string, number>();
  const most = new Map<string, number>();
  const starts: { endpoint: string; at: number }[] = [];
  let together = 0;
  let mostTogether = 0;
  const provider: SpeechProvider = {
    name: inner.name,
    async speak(input) {
      const endpoint = input.voiceRef?.split("/")[0] ?? "";
      now.set(endpoint, (now.get(endpoint) ?? 0) + 1);
      most.set(endpoint, Math.max(most.get(endpoint) ?? 0, now.get(endpoint)!));
      mostTogether = Math.max(mostTogether, ++together);
      starts.push({ endpoint, at: Date.now() });
      try {
        return await (around ?? inner.speak)(input);
      } finally {
        now.set(endpoint, now.get(endpoint)! - 1);
        together--;
      }
    },
  };
  return { provider, most, starts, mostTogether: () => mostTogether, inner };
}

describe("narrating at an endpoint's concurrency", () => {
  test("sends up to the endpoint's concurrency at once and never more, and every line lands", async () => {
    const count = counting();
    const api = testApi({ speech: count.provider });
    const id = await book(api, [speech("a", { concurrency: 3 })]);
    const job = await narrate(api, id);
    await api.runner.idle();

    expect((await jobById(api, job.id)).status).toBe("done");
    expect(count.most.get("a")).toBe(3);
    expect((await linesOf(api, id)).every((s) => s.audio.status === "done")).toBe(true);
    expect(api.gate.live().a).toMatchObject({ active: 0, waiting: 0 });
  });

  test("at a concurrency of one, a line goes out only after the one before it has landed", async () => {
    const count = counting();
    const api = testApi({ speech: count.provider });
    const id = await book(api, [speech("a")]);
    await narrate(api, id);
    await api.runner.idle();
    expect(count.most.get("a")).toBe(1);
  });

  test("lines for two endpoints go out alongside each other, each at its own limit", async () => {
    const count = counting();
    const api = testApi({ speech: count.provider });
    const id = await book(api, [speech("a"), speech("b", { concurrency: 2 })], (name) =>
      name === "Mara" || name === "Tobin" ? "a/ash" : "b/ash",
    );
    const job = await narrate(api, id);
    await api.runner.idle();

    expect((await jobById(api, job.id)).status).toBe("done");
    expect(count.most.get("a")).toBe(1);
    expect(count.most.get("b")).toBe(2);
    expect(count.mostTogether()).toBe(3);
  });

  test("a concurrency raised mid-run applies to the lines still waiting", async () => {
    const count = counting(25);
    const api = testApi({ speech: count.provider });
    const id = await book(api, [speech("a")]);
    await narrate(api, id);
    await until("the first line to go out", () => count.starts.length > 0);
    await saveEndpoints(api, [speech("a", { concurrency: 4 })]);
    await api.runner.idle();
    expect(count.most.get("a")).toBe(4);
  });
});

describe("an endpoint that is paused", () => {
  test("holds its lines, queued, until it is resumed — and the job says why it waits", async () => {
    // no pause per line: nothing here is about lines overlapping, only about none going out
    const count = counting(0);
    const api = testApi({ speech: count.provider });
    const id = await book(api, [speech("a", { enabled: false })]);
    const job = await narrate(api, id);
    await until("the job to wait on the pause", async () =>
      ((await jobById(api, job.id)).activity ?? []).some((e) => /is paused/.test(e.message)),
    );

    expect(count.starts).toHaveLength(0);
    expect((await jobById(api, job.id)).status).toBe("running");
    expect((await linesOf(api, id)).every((s) => s.audio.status === "queued")).toBe(true);
    expect(api.gate.live().a).toMatchObject({ active: 0 });
    expect(api.gate.live().a.waiting).toBeGreaterThan(0);

    await saveEndpoints(api, [speech("a")]);
    await api.runner.idle();
    expect((await jobById(api, job.id)).status).toBe("done");
    const waits = (await jobById(api, job.id)).activity!.filter((e) =>
      e.message.startsWith("Waiting"),
    );
    expect(waits).toHaveLength(1);
  });

  test("cancelling while it holds puts every line back", async () => {
    const api = testApi();
    const id = await book(api, [speech("a", { enabled: false })]);
    const job = await narrate(api, id);
    await until("the lines to be queued", async () =>
      (await linesOf(api, id)).every((s) => s.audio.status === "queued"),
    );
    await api.request(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    await api.runner.idle();

    expect((await jobById(api, job.id)).status).toBe("cancelled");
    expect((await linesOf(api, id)).every((s) => s.audio.status === "none")).toBe(true);
    expect(api.gate.live().a).toMatchObject({ active: 0, waiting: 0 });
  });
});

describe("a rate limit", () => {
  test("holds the endpoint's other lines until its cooldown ends, and is said once", async () => {
    const COOLDOWN = 120;
    let limited = false;
    const count = counting(0, async (input) => {
      // the first request is refused once and waits its cooldown out before it tries again, as
      // `call` does with a 429
      if (!limited) {
        limited = true;
        input.rateLimited?.(COOLDOWN);
        await Bun.sleep(COOLDOWN);
      }
      return count.inner.speak(input);
    });
    const api = testApi({ speech: count.provider });
    const id = await book(api, [speech("a", { concurrency: 3 })]);
    const job = await narrate(api, id);
    await api.runner.idle();

    expect((await jobById(api, job.id)).status).toBe("done");
    // what was already out when the limit came back is not recalled; what asked after it waited
    const first = count.starts[0].at;
    const after = count.starts.slice(3);
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) expect(s.at).toBeGreaterThanOrEqual(first + COOLDOWN - 5);
    const live = api.gate.live().a;
    expect(live.rateLimits).toBe(1);
    expect(live.backoffUntil).toBeGreaterThanOrEqual(first + COOLDOWN - 5);
    const waits = (await jobById(api, job.id)).activity!.filter((e) =>
      /rate limited/.test(e.message),
    );
    expect(waits).toHaveLength(1);
  });
});

describe("cancelling a run with lines out", () => {
  test("stops the lines in flight and the ones waiting, keeps what landed, and frees every slot", async () => {
    const count = counting(40);
    const api = testApi({ speech: count.provider });
    const id = await book(api, [speech("a", { concurrency: 2 })]);
    const job = await narrate(api, id);
    await until("two lines to be out", () => count.starts.length >= 2);
    await api.request(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    await api.runner.idle();

    expect((await jobById(api, job.id)).status).toBe("cancelled");
    const statuses = (await linesOf(api, id)).map((s) => s.audio.status);
    expect(statuses.every((s) => s === "none" || s === "done")).toBe(true);
    expect(statuses.filter((s) => s === "none").length).toBeGreaterThan(0);
    expect(api.gate.live().a).toMatchObject({ active: 0, waiting: 0 });
  });
});
