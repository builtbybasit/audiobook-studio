// Speech to text: the transcription endpoints. The wire against a `fetch` that answers from memory
// — the form sent, the words read back, a server with no word times, a refusal — and the routes
// over it: saved with the rest of the configuration and its key kept write-only, tested, and asked
// what is said in a clone sample, priced into the ledger by the minute of audio sent.
import { describe, expect, test } from "bun:test";

import type { RequestRecord, Transcriber } from "@/types";
import { toneWav } from "~/providers/fakeSpeech";
import type { SentTranscription } from "~/providers/sent";
import type { ProviderTarget } from "~/providers/target";
import {
  endpointTranscriber,
  SIMULATED_TRANSCRIPT,
  type TranscriptionInput,
  type TranscriptionProvider,
} from "~/providers/transcription";
import { HEADS, sampleFile } from "../support/cloning";
import { jsonBody, testApi, type TestApi } from "../support/server";

const target = (over: Partial<ProviderTarget> = {}): ProviderTarget => ({
  id: "phonon",
  name: "Phonon",
  baseUrl: "http://127.0.0.1:8001/v1",
  model: "phonon-2",
  apiKey: null,
  needsKey: false,
  timeoutSec: 5,
  maxRetries: 1,
  cooldownSec: 0,
  ...over,
});

const transcriber = (over: Partial<Transcriber> = {}): Transcriber => ({
  id: "phonon",
  name: "Phonon",
  baseUrl: "http://127.0.0.1:8001/v1",
  model: "phonon-2",
  enabled: true,
  concurrency: 2,
  needsKey: false,
  perMinute: 0,
  ...over,
});

/** A `fetch` that remembers each request and answers it with `answer`, and the real wire over it. */
function answering(answer: (n: number) => Response | Promise<Response>) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return answer(sent.length);
  }) as unknown as typeof globalThis.fetch;
  return { sent, provider: endpointTranscriber({ fetch, backoffMs: () => 0 }) };
}

const input = (over: Partial<TranscriptionInput> = {}): TranscriptionInput => ({
  audio: new Blob([toneWav(440, 1)], { type: "audio/wav" }),
  name: "line.wav",
  seconds: 1,
  words: false,
  signal: new AbortController().signal,
  ...over,
});

/** What Phonon answers `verbose_json` with, word times and all. */
const verbose = () =>
  Response.json({
    text: " We are short again.",
    duration: 1.4,
    words: [
      { word: "We", start: 0.1, end: 0.22 },
      { word: "are", start: 0.22, end: 0.4 },
      { word: "short", start: 0.4, end: 0.8 },
      { word: "again.", start: 0.8, end: 1.3 },
    ],
  });

describe("the transcription wire", () => {
  test("posts the file and the model, and reads the text alone when no times are asked for", async () => {
    const f = answering(() => Response.json({ text: "We are short again." }));
    const heard = await f.provider.transcribe(input(), target());
    expect(heard).toEqual({ text: "We are short again." });
    expect(f.sent[0].url).toBe("http://127.0.0.1:8001/v1/audio/transcriptions");
    const form = f.sent[0].init.body as FormData;
    expect([...form.keys()].sort()).toEqual(["file", "language", "model", "response_format"]);
    expect(form.get("response_format")).toBe("json");
    expect(form.get("model")).toBe("phonon-2");
    expect((form.get("file") as File).name).toBe("line.wav");
    expect(new Headers(f.sent[0].init.headers).has("authorization")).toBe(false);
  });

  test("asks for each word's time, and passes hints as the prompt", async () => {
    const f = answering(() => verbose());
    const heard = await f.provider.transcribe(
      input({ words: true, hints: ["Mara", "Ostrava"] }),
      target({ apiKey: "sk-1", needsKey: true }),
    );
    expect(heard.text).toBe("We are short again.");
    expect(heard.words?.map((w) => [w.word, w.start, w.end])).toEqual([
      ["We", 0.1, 0.22],
      ["are", 0.22, 0.4],
      ["short", 0.4, 0.8],
      ["again.", 0.8, 1.3],
    ]);
    const form = f.sent[0].init.body as FormData;
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["word"]);
    expect(form.get("prompt")).toBe("Mara, Ostrava");
    expect(new Headers(f.sent[0].init.headers).get("authorization")).toBe("Bearer sk-1");
  });

  test("a server with no word times still gives the words", async () => {
    const f = answering(() => Response.json({ text: "We are short again.", duration: 1.4 }));
    expect(await f.provider.transcribe(input({ words: true }), target())).toEqual({
      text: "We are short again.",
    });
  });

  test("each request is reported once: billed when answered, not when refused", async () => {
    const reports: SentTranscription[] = [];
    const sent = (r: SentTranscription) => reports.push(r);

    const ok = answering(() => Response.json({ text: "Hello." }));
    await ok.provider.transcribe(input({ seconds: 3, sent }), target());
    expect(reports.at(-1)).toMatchObject({ status: "done", billed: true, audioSeconds: 3 });

    const refused = answering(() => new Response("bad audio", { status: 400 }));
    await expect(refused.provider.transcribe(input({ sent }), target())).rejects.toThrow(
      "Phonon answered 400: bad audio",
    );
    expect(refused.sent).toHaveLength(1);
    expect(reports.at(-1)).toMatchObject({ status: "failed", billed: false });

    const empty = answering(() => Response.json({ nothing: true }));
    await expect(empty.provider.transcribe(input({ sent }), target())).rejects.toThrow(
      "Phonon answered without a transcript",
    );
    expect(reports.at(-1)).toMatchObject({ status: "failed", billed: true });
    expect(reports).toHaveLength(3);
  });

  test("a busy server is tried again, as the endpoint's retries allow", async () => {
    const f = answering((n) =>
      n === 1 ? new Response("busy", { status: 503 }) : Response.json({ text: "Hello." }),
    );
    expect((await f.provider.transcribe(input(), target())).text).toBe("Hello.");
    expect(f.sent).toHaveLength(2);
  });

  test("a key is asked for before anything is sent", async () => {
    const f = answering(() => Response.json({ text: "Hello." }));
    await expect(
      f.provider.transcribe(input(), target({ needsKey: true, apiKey: null })),
    ).rejects.toThrow("Phonon needs an API key");
    expect(f.sent).toHaveLength(0);
  });

  test("a simulated endpoint answers here, with no times", async () => {
    const f = answering(() => Response.json({ text: "never" }));
    const heard = await f.provider.transcribe(
      input({ words: true }),
      target({ baseUrl: "simulated://phonon", simulation: { latencyMs: 0, failRate: 0 } }),
    );
    expect(heard).toEqual({ text: SIMULATED_TRANSCRIPT });
    expect(f.sent).toHaveLength(0);
  });

  test("the probe reads the models and says when the model is not listed", async () => {
    const listed = answering(() => Response.json({ data: [{ id: "phonon-2" }] }));
    const yes = await listed.provider.probe(target(), new AbortController().signal);
    expect(yes.ok).toBe(true);
    expect(yes.message).toContain("lists “phonon-2”");
    expect(listed.sent[0].url).toBe("http://127.0.0.1:8001/v1/models");

    const aliased = answering(() => Response.json({ data: [{ id: "FermionResearch/phonon-2" }] }));
    const alias = await aliased.provider.probe(target(), new AbortController().signal);
    expect(alias.ok).toBe(true);
    expect(alias.message).toContain("lists “FermionResearch/phonon-2”, not “phonon-2”");
  });
});

// ---------- the routes ----------

async function save(api: TestApi, ...transcribers: Transcriber[]): Promise<void> {
  const { status } = await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [], profiles: [], transcribers, credentials: [] }),
    method: "PUT",
  });
  expect(status).toBe(200);
}

/** A form of one recording, as the clone form's Transcribe button sends it. */
const form = (file: File, id?: string): FormData => {
  const f = new FormData();
  f.set("file", file, file.name);
  if (id) f.set("id", id);
  return f;
};

/** A real WAV of `seconds`, so its length can be priced. */
const wavFile = (seconds: number) =>
  new File([toneWav(440, seconds)], "take-1.wav", { type: "audio/wav" });

const postTranscribe = (api: TestApi, body: FormData) =>
  api.request<{ text: string; error?: { message: string } }>("/api/endpoints/transcribe", {
    method: "POST",
    body,
  });

/** A provider that remembers what it was asked and hears `text`, reporting each request. */
function hearing(text = "We are short again."): {
  provider: TranscriptionProvider;
  asked: { input: TranscriptionInput; target: ProviderTarget }[];
} {
  const asked: { input: TranscriptionInput; target: ProviderTarget }[] = [];
  return {
    asked,
    provider: {
      name: "hearing (test)",
      async transcribe(i, t) {
        asked.push({ input: i, target: t });
        const now = Date.now();
        i.sent?.({
          startedAt: now,
          finishedAt: now,
          attempts: 1,
          rateLimited: false,
          simulated: false,
          status: "done",
          audioSeconds: i.seconds,
          billed: true,
        });
        return { text };
      },
      probe: async () => ({ ok: true, message: "Answered in 3 ms", ms: 3 }),
    },
  };
}

describe("transcription endpoints over HTTP", () => {
  test("are saved with the configuration, their key write-only, and kept by a save that leaves them out", async () => {
    const api = testApi();
    await save(api, transcriber({ apiKey: "sk-secret", needsKey: true, perMinute: 0.006 }));
    const read = await api.request<{ transcribers: Transcriber[] }>("/api/endpoints");
    expect(read.body.transcribers).toEqual([
      transcriber({ hasKey: true, needsKey: true, perMinute: 0.006 }),
    ]);
    expect(JSON.stringify(read.body)).not.toContain("sk-secret");

    // a page from before there were any sends none, and keeps them
    await api.request("/api/endpoints", {
      ...jsonBody({ endpoints: [], profiles: [], credentials: [] }),
      method: "PUT",
    });
    const kept = await api.request<{ transcribers: Transcriber[] }>("/api/endpoints");
    expect(kept.body.transcribers.map((t) => [t.id, t.hasKey])).toEqual([["phonon", true]]);
  });

  test("may share an id with a speech endpoint and a profile", async () => {
    const api = testApi();
    const { status, body } = await api.request<{ transcribers: Transcriber[] }>("/api/endpoints", {
      ...jsonBody({
        endpoints: [],
        profiles: [],
        transcribers: [transcriber({ id: "openai" })],
        credentials: [],
      }),
      method: "PUT",
    });
    expect(status).toBe(200);
    expect(body.transcribers[0].id).toBe("openai");
    const twice = await api.request<{ error: { message: string } }>("/api/endpoints", {
      ...jsonBody({
        endpoints: [],
        profiles: [],
        transcribers: [transcriber(), transcriber()],
        credentials: [],
      }),
      method: "PUT",
    });
    expect(twice.status).toBe(400);
    expect(twice.body.error.message).toBe("Two transcription endpoints are called “phonon”");
  });

  test("the Test button asks the saved endpoint", async () => {
    const h = hearing();
    const api = testApi({ transcription: h.provider });
    await save(api, transcriber());
    const { status, body } = await api.request<{ ok: boolean; message: string }>(
      "/api/endpoints/test",
      jsonBody({ kind: "transcription", id: "phonon" }),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, message: "Answered in 3 ms" });
    const none = await api.request(
      "/api/endpoints/test",
      jsonBody({ kind: "transcription", id: "x" }),
    );
    expect(none.status).toBe(404);
  });

  test("hears a sample on the first endpoint switched on, once, and prices it by the minute", async () => {
    const h = hearing("We are short again.");
    const api = testApi({ transcription: h.provider });
    await save(
      api,
      transcriber({ id: "off", enabled: false }),
      transcriber({ id: "phonon", perMinute: 0.6 }),
    );
    const { status, body } = await postTranscribe(api, form(wavFile(2)));
    expect(status).toBe(200);
    expect(body).toEqual({ text: "We are short again." });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].target).toMatchObject({ id: "phonon", maxRetries: 0 });
    expect(h.asked[0].input).toMatchObject({ name: "sample.wav", words: false });
    expect(h.asked[0].input.seconds).toBeCloseTo(2, 2);

    const rows = await api.request<{ requests: RequestRecord[] }>(
      "/api/endpoints/requests?kind=transcription&id=phonon&range=1h",
    );
    expect(rows.body.requests).toHaveLength(1);
    const row = rows.body.requests[0];
    expect(row).toMatchObject({ kind: "transcription", bookId: null, label: "Sample transcript" });
    expect(row.usage.audioSeconds).toBeCloseTo(2, 2);
    // two minutes' worth at $0.60 a minute, for two seconds
    expect(row.cost).toBeCloseTo(0.02, 4);
  });

  test("an endpoint named is the one asked", async () => {
    const h = hearing();
    const api = testApi({ transcription: h.provider });
    await save(api, transcriber({ id: "a" }), transcriber({ id: "b" }));
    await postTranscribe(api, form(wavFile(1), "b"));
    expect(h.asked[0].target.id).toBe("b");
  });

  test("refuses what it cannot send: no endpoint on, not audio, no file, past the daily limit", async () => {
    const h = hearing();
    const api = testApi({ transcription: h.provider });

    const none = await postTranscribe(api, form(wavFile(1)));
    expect(none.status).toBe(400);
    expect(none.body.error?.message).toBe(
      "No transcription endpoint is switched on. Add one on the Endpoints page.",
    );

    await save(api, transcriber({ perMinute: 60, spendLimit: 0.5 }));
    const text = await postTranscribe(api, form(sampleFile("notes.wav", HEADS.text)));
    expect(text.status).toBe(400);
    expect(text.body.error?.message).toBe("That file is not audio this app can read");

    const empty = await postTranscribe(api, new FormData());
    expect(empty.status).toBe(400);

    // a second of audio at $60 a minute is $1, over a $0.50 day
    const over = await postTranscribe(api, form(wavFile(1)));
    expect(over.status).toBe(409);
    expect(over.body.error?.message).toContain("daily limit");
    expect(h.asked).toHaveLength(0);
  });
});
