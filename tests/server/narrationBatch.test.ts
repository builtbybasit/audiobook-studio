// Narration through an endpoint that takes lines in batches (`docs/speech-batch-api.md`): the
// waiting lines gathered in the chapter's order up to what the endpoint takes, each batch in one
// of its slots, every line landing on its own however the answers are ordered, a long line sent as
// its parts, and a line the server fumbled — or a batch it dropped — sent again in a later batch.
//
// The provider is the tone-rendering fake in its batch mode, which answers a batch's items last
// first so nothing here passes by assuming the order they were sent in.
import { describe, expect, test } from "bun:test";

import type { Endpoint, Job, Segment } from "@/types";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { fakeDuration, fakeSpeechProvider, type FakeSpeechOptions } from "~/providers/fakeSpeech";
import { endpointRequests } from "~/usage/ledger";
import { story } from "../support/epub";
import { batchServer } from "../support/batchServer";
import {
  jsonBody,
  narrateChapters,
  speechEndpoint,
  testApi,
  voicedBook,
  type TestApi,
} from "../support/server";

// One batch out at a time unless a test says otherwise, so a line sent again goes in the next one;
// the batch server's model and its one voice; and priced, so every item is a charge of its own.
const speech = (over: Partial<Endpoint> = {}): Endpoint =>
  speechEndpoint({
    id: "local",
    model: "omnivoice",
    concurrency: 1,
    price: 15,
    billing: { unit: "chars", rate: 15 },
    maxRetries: 2,
    voices: [{ id: "mara", gender: "f", label: "Mara" }],
    ...over,
  });

/**
 * A scripted, cast one-chapter book of `paragraphs` on `endpoint`. The story's five make eleven
 * lines with the title: three batches of four, the last one short.
 */
const book = (api: TestApi, endpoint: Endpoint, paragraphs = story(5)) =>
  voicedBook(api, { endpoints: [endpoint], paragraphs, voiceOf: "local/mara" });

/** Narrate chapter 1 to the end with a batching fake; what it was sent, and how it went. */
async function run(
  options: Partial<FakeSpeechOptions>,
  endpoint = speech(),
  paragraphs?: string[],
) {
  const batches: string[][] = [];
  const api = testApi({
    speech: fakeSpeechProvider({
      batch: { maxItems: 4, maxInputChars: null, maxItemChars: null },
      batches,
      ...options,
    }),
  });
  const id = await book(api, endpoint, paragraphs);
  const [queued] = await narrateChapters(api, id, [1]);
  const job = (await api.request<{ job: Job }>(`/api/jobs/${queued.id}`)).body.job;
  const lines = (await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`))
    .body.segments;
  return { api, id, job, lines, batches };
}

describe("narrating through an endpoint that takes batches", () => {
  test("sends the lines in batches of what it takes, in the chapter's order, and every line lands on its own", async () => {
    const { job, lines, batches } = await run({});
    expect(job.status).toBe("done");
    expect(batches.slice(0, -1).every((b) => b.length === 4)).toBe(true);
    expect(batches.at(-1)!.length).toBeLessThanOrEqual(4);
    expect(batches.flat()).toEqual(lines.map((s) => s.audio.said ?? s.text));
    // answered last first, and still each clip is its own line's
    for (const s of lines) {
      expect(s.audio.status).toBe("done");
      expect(s.audio.duration).toBeCloseTo(fakeDuration(s.text), 6);
    }
    expect(job.activity?.some((e) => e.message === "Sending in batches")).toBe(true);
  });

  test("fills a batch only up to the characters it takes, and always sends a line on its own if it must", async () => {
    const { lines, batches } = await run({
      batch: { maxItems: 10, maxInputChars: 120, maxItemChars: null },
    });
    for (const b of batches)
      if (b.length > 1) expect(b.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(120);
    expect(batches.flat()).toHaveLength(lines.length);
  });

  test("a line longer than an item may be goes as its parts, in one batch, and lands joined", async () => {
    // one sentence, so the script keeps it as one line, cut at its clauses to fit
    const long =
      "Mara counted the ledger twice by lamplight, and Tobin watched her do it from the door, and neither of them said a word about the coin.";
    const { lines, batches } = await run(
      { batch: { maxItems: 8, maxInputChars: null, maxItemChars: 60 } },
      speech(),
      [long],
    );
    // the chapter's title is its first line; the long one goes beside it, as its parts
    const s = lines.find((l) => l.text === long)!;
    expect(s.audio.status).toBe("done");
    expect(s.audio.parts).toBeGreaterThan(1);
    expect(batches).toHaveLength(1);
    const parts = batches[0].slice(1);
    expect(parts).toHaveLength(s.audio.parts!);
    expect(parts.join(" ")).toBe(long);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(60);
    expect(s.audio.duration).toBeCloseTo(
      parts.reduce((n, t) => n + fakeDuration(t), 0),
      6,
    );
  });

  test("a line the server fumbled goes again in a later batch; one it could not render fails alone", async () => {
    // the narration after the second and third speeches — "the clerk wrote the 2th line…"
    const { job, lines, batches } = await run({
      retryLines: (text) => text.includes("2th line"),
      failLines: (text) => text.includes("3th line"),
    });
    expect(job.status).toBe("failed");
    const fumbled = lines.find((s) => s.text.includes("2th line"))!;
    const broken = lines.find((s) => s.text.includes("3th line"))!;
    expect(fumbled.audio.status).toBe("done");
    expect(broken.audio.status).toBe("failed");
    expect(lines.filter((s) => s.audio.status === "failed")).toHaveLength(1);
    // the fumbled line was sent twice, the second time in a later batch
    const sent = batches.map((b) => b.includes(fumbled.text));
    expect(sent.filter(Boolean)).toHaveLength(2);
  });

  test("a batch dropped part-way sends again what it had not answered, and keeps what it had", async () => {
    const { job, lines, batches } = await run({ dropAfter: 2 });
    expect(job.status).toBe("done");
    expect(lines.every((s) => s.audio.status === "done")).toBe(true);
    // four sent, two answered (the last two, answered first), the first two sent again
    expect(batches[0]).toHaveLength(4);
    expect(batches[1].slice(0, 2)).toEqual(batches[0].slice(0, 2));
  });

  test("prices every item as its own request, filed under its line", async () => {
    const { api, lines } = await run({});
    const rows = endpointRequests(api.db, "tts", "local", 0);
    expect(rows).toHaveLength(lines.length);
    for (const s of lines)
      expect(rows.filter((r) => r.label === `Line ${s.id} · ${s.speaker}`)).toHaveLength(1);
  });

  test("each batch takes one of the endpoint's slots: at a concurrency of two, two are out at once", async () => {
    const batches: string[][] = [];
    const api = testApi({
      speech: fakeSpeechProvider({
        batch: { maxItems: 3, maxInputChars: null, maxItemChars: null },
        batches,
        delayMs: 30,
      }),
    });
    const id = await book(api, speech({ concurrency: 2 }));
    await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [1] }));
    let most = 0;
    while (api.runner.running) {
      most = Math.max(most, api.gate.live().local?.active ?? 0);
      await Bun.sleep(3);
    }
    await api.runner.idle();
    expect(most).toBe(2);
    expect(batches.every((b) => b.length <= 3)).toBe(true);
  });

  test("a cancel with a batch out stops it, keeps what landed, and puts the rest back", async () => {
    const batches: string[][] = [];
    const api = testApi({
      speech: fakeSpeechProvider({
        batch: { maxItems: 4, maxInputChars: null, maxItemChars: null },
        batches,
        delayMs: 40,
      }),
    });
    const id = await book(api, speech());
    const { body } = await api.request<{ jobs: Job[] }>(
      `/api/books/${id}/chapters/narrate`,
      jsonBody({ ids: [1] }),
    );
    while (!batches.length) await Bun.sleep(2);
    await api.request(`/api/jobs/${body.jobs[0].id}/cancel`, { method: "POST" });
    await api.runner.idle();

    const job = (await api.request<{ job: Job }>(`/api/jobs/${body.jobs[0].id}`)).body.job;
    expect(job.status).toBe("cancelled");
    const lines = (await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`))
      .body.segments;
    expect(lines.every((s) => s.audio.status === "none" || s.audio.status === "done")).toBe(true);
    expect(lines.some((s) => s.audio.status === "none")).toBe(true);
    expect(api.gate.live().local).toMatchObject({ active: 0, waiting: 0 });
  });

  test("end to end: the real provider against a server that answers the batch API, out of order", async () => {
    const server = batchServer({
      batch: { max_items: 5, max_input_chars: null },
      voices: ["mara"],
      order: "reversed",
    });
    const api = testApi({
      speech: endpointSpeechProvider({ fetch: server.fetch, backoffMs: () => 0 }),
    });
    const id = await book(api, speech());
    const [queued] = await narrateChapters(api, id, [1]);

    const job = (await api.request<{ job: Job }>(`/api/jobs/${queued.id}`)).body.job;
    expect(job.status).toBe("done");
    const lines = (await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`))
      .body.segments;
    expect(lines.every((s) => s.audio.status === "done" && s.audio.sampleRate === 24000)).toBe(
      true,
    );
    const sent = server.batches();
    expect(sent.every((b) => b.items.length <= 5)).toBe(true);
    expect(sent.flatMap((b) => b.items.map((i) => i.input))).toEqual(
      lines.map((s) => s.audio.said ?? s.text),
    );
    // no line went the single-line way
    expect(server.requests.some((r) => r.path === "/audio/speech")).toBe(false);
    expect(endpointRequests(api.db, "tts", "local", 0)).toHaveLength(lines.length);
  });
});
