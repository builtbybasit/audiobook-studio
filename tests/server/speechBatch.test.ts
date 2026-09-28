// The batch speech API from the client's side (`docs/speech-batch-api.md`), against a fake server
// that speaks it: what a server's capabilities are read as and how long they are kept, what a batch
// is sent as, how each item's answer lands on its own line whatever order it comes in, and what the
// ledger is told about every item — however the batch, or the item, ended.
import { describe, expect, test } from "bun:test";

import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { fakeDuration, toneOf, toneWav } from "~/providers/fakeSpeech";
import { ProviderError } from "~/providers/http";
import type { SentSpeech } from "~/providers/sent";
import type { BatchOutcome, SpeechBatch, SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { BATCH_RATE, batchServer, type BatchServerOptions } from "../support/batchServer";

const omni: ProviderTarget = {
  id: "omni",
  name: "OmniVoice",
  baseUrl: "http://gpu.local:8000/v1",
  model: "omnivoice",
  apiKey: null,
  needsKey: false,
  timeoutSec: 5,
  maxRetries: 2,
  cooldownSec: 0,
};

const TEXTS = [
  "We are short again.",
  "Then we count it twice.",
  "And if it is still short, we count it a third time, slowly.",
  "Fine.",
];

const line = (text: string, over: Partial<SpeechInput> = {}): SpeechInput => ({
  text,
  speaker: "Mara",
  type: "dialogue",
  direction: "",
  instructions: "",
  voiceRef: "omni/mara",
  sampleRate: null,
  encoding: { format: "wav" },
  target: omni,
  signal: new AbortController().signal,
  ...over,
});

const provider = (fetch: typeof globalThis.fetch) =>
  endpointSpeechProvider({ fetch, backoffMs: () => 0 });

/**
 * A batch of `texts` sent to `server` through the real provider, and everything it told: each
 * item's outcome in the order they were answered, each item's ledger reports, and the rate limits.
 */
async function send(
  server: ReturnType<typeof batchServer>,
  texts: string[] = TEXTS,
  over: {
    target?: ProviderTarget;
    items?: (i: number) => Partial<SpeechInput>;
    signal?: AbortSignal;
    answered?(index: number): void;
  } = {},
) {
  const answered: { index: number; outcome: BatchOutcome }[] = [];
  const reports: SentSpeech[][] = texts.map(() => []);
  const limited: number[] = [];
  const target = over.target ?? omni;
  const signal = over.signal ?? new AbortController().signal;
  const batch: SpeechBatch = {
    target,
    signal,
    items: texts.map((text, i) =>
      line(text, { target, signal, sent: (r) => void reports[i].push(r), ...over.items?.(i) }),
    ),
    answered(index, outcome) {
      answered.push({ index, outcome });
      over.answered?.(index);
    },
    rateLimited: (ms) => void limited.push(ms),
  };
  let thrown: unknown = null;
  try {
    await provider(server.fetch).speakBatch!(batch);
  } catch (e) {
    thrown = e;
  }
  const outcome = (i: number) => answered.find((a) => a.index === i)?.outcome;
  return {
    thrown,
    answered,
    reports,
    limited,
    clip: (i: number) => {
      const o = outcome(i);
      if (!o || !("clip" in o)) throw new Error(`item ${i} has no clip: ${JSON.stringify(o)}`);
      return o.clip;
    },
    error: (i: number) => {
      const o = outcome(i);
      if (!o || !("error" in o)) throw new Error(`item ${i} did not fail`);
      return o.error as ProviderError;
    },
  };
}

const server = (options: BatchServerOptions = {}) => batchServer(options);

describe("capabilities", () => {
  test("are read for the endpoint's model, unknown fields and all", async () => {
    const s = server({ batch: { max_items: 8, max_input_chars: null }, maxItemChars: 900 });
    const limits = await provider(s.fetch).batchLimits!(omni, new AbortController().signal);
    expect(limits).toEqual({ maxItems: 8, maxInputChars: null, maxItemChars: 900 });
    expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /audio/speech/capabilities",
    ]);
  });

  test("are asked once in a while, not before every chapter — a no included", async () => {
    const s = server();
    const p = provider(s.fetch);
    const signal = new AbortController().signal;
    await p.batchLimits!(omni, signal);
    await p.batchLimits!(omni, signal);
    expect(s.requests).toHaveLength(1);
    // another model, or the same one with a key, is another question
    await p.batchLimits!({ ...omni, apiKey: "sk-local" }, signal);
    expect(s.requests).toHaveLength(2);

    const none = server({ capabilitiesStatus: 404 });
    const q = provider(none.fetch);
    expect(await q.batchLimits!(omni, signal)).toBeNull();
    expect(await q.batchLimits!(omni, signal)).toBeNull();
    expect(none.requests).toHaveLength(1);
  });

  test("are no batches from a server without the route, or that does not batch the model", async () => {
    const signal = new AbortController().signal;
    for (const status of [404, 405, 501]) {
      const s = server({ capabilitiesStatus: status });
      expect(await provider(s.fetch).batchLimits!(omni, signal)).toBeNull();
    }
    const other = server({ model: "kokoro" });
    expect(await provider(other.fetch).batchLimits!(omni, signal)).toBeNull();
    const single = server({ batch: null });
    expect(await provider(single.fetch).batchLimits!(omni, signal)).toBeNull();
  });

  test("are never asked of a hosted provider, which has no such route", async () => {
    const s = server();
    const openai = { ...omni, baseUrl: "https://api.openai.com/v1", apiKey: "sk-openai" };
    expect(await provider(s.fetch).batchLimits!(openai, new AbortController().signal)).toBeNull();
    expect(s.requests).toHaveLength(0);
  });

  test("that could not be asked are thrown, and asked again next time", async () => {
    const s = server();
    let down = true;
    const fetch = (async (url: string, init: RequestInit) => {
      if (down) throw new TypeError("connect ECONNREFUSED");
      return s.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    const p = provider(fetch);
    const once = { ...omni, maxRetries: 0 };
    const signal = new AbortController().signal;
    await expect(p.batchLimits!(once, signal)).rejects.toThrow(/could not be reached/);
    down = false;
    expect(await p.batchLimits!(once, signal)).toMatchObject({ maxItems: 16 });
  });
});

describe("a batch", () => {
  test("is sent as one request, and every item comes back as its own clip", async () => {
    const s = server();
    const r = await send(s, TEXTS, {
      items: (i) => (i === 1 ? { instructions: "  Tired, flat.  " } : {}),
    });
    expect(r.thrown).toBeNull();
    expect(s.batches()).toEqual([
      {
        model: "omnivoice",
        response_format: "wav",
        items: [
          { id: "0", input: TEXTS[0], voice: "mara" },
          { id: "1", input: TEXTS[1], voice: "mara", instructions: "Tired, flat." },
          { id: "2", input: TEXTS[2], voice: "mara" },
          { id: "3", input: TEXTS[3], voice: "mara" },
        ],
      },
    ]);
    expect(s.requests[0].headers.get("accept")).toBe("application/x-ndjson");
    expect(r.answered.map((a) => a.index)).toEqual([0, 1, 2, 3]);
    TEXTS.forEach((text, i) => {
      const clip = r.clip(i);
      expect(clip).toMatchObject({ format: "wav", mime: "audio/wav", model: "omnivoice" });
      expect(clip.voice).toBe("mara");
      expect(clip.duration).toBeCloseTo(fakeDuration(text), 3);
    });
  });

  test("reports one ledger row per item, as if each had gone alone", async () => {
    const s = server();
    const r = await send(s, TEXTS.slice(0, 2), {
      items: (i) => (i === 1 ? { instructions: "Tired." } : {}),
    });
    expect(r.reports.map((rows) => rows.length)).toEqual([1, 1]);
    const [first, second] = r.reports.map((rows) => rows[0]);
    expect(first).toMatchObject({
      status: "done",
      billed: true,
      simulated: false,
      attempts: 1,
      rateLimited: false,
      text: TEXTS[0],
      instructions: "",
      reported: {
        chars: TEXTS[0].length,
        audioSeconds: fakeDuration(TEXTS[0]),
        textTokens: null,
        audioTokens: null,
        format: "plain",
        problems: [],
      },
    });
    expect(first.audioSeconds).toBeCloseTo(fakeDuration(TEXTS[0]), 3);
    expect(second).toMatchObject({ status: "done", text: TEXTS[1], instructions: "Tired." });
    expect(first.finishedAt).toBeGreaterThanOrEqual(first.startedAt);
  });

  test("keeps the tokens a model counts beside its characters", async () => {
    const s = server({
      usageFor: (item, duration) => ({
        input_characters: item.input.length,
        audio_seconds: duration,
        input_tokens: 12,
        output_audio_tokens: 340,
        a_count_nobody_asked_for: 7,
      }),
    });
    const r = await send(s, [TEXTS[0]]);
    expect(r.reports[0][0].reported).toMatchObject({ textTokens: 12, audioTokens: 340 });
  });

  test("lands each item on its own line when the server finishes them out of order", async () => {
    const s = server({ order: "reversed" });
    const voices = ["mara", "tobin", "ines", "odo"];
    const r = await send(s, TEXTS, { items: (i) => ({ voiceRef: `omni/${voices[i]}` }) });
    expect(r.answered.map((a) => a.index)).toEqual([3, 2, 1, 0]);
    TEXTS.forEach((text, i) => {
      expect(r.clip(i).voice).toBe(voices[i]);
      expect(r.clip(i).duration).toBeCloseTo(fakeDuration(text), 3);
      expect(r.reports[i][0].text).toBe(text);
    });
  });

  test("fails one item alone, and renders the others", async () => {
    const s = server({
      voices: ["mara"],
      failItem: (_, i) =>
        i === 2 ? { code: "out_of_memory", message: "CUDA out of memory", retryable: true } : null,
    });
    const r = await send(s, TEXTS, {
      items: (i) => (i === 1 ? { voiceRef: "omni/nobody" } : {}),
    });
    expect(r.thrown).toBeNull();
    expect(r.clip(0).duration).toBeGreaterThan(0);
    expect(r.clip(3).duration).toBeGreaterThan(0);
    expect(r.error(1)).toBeInstanceOf(ProviderError);
    expect(r.error(1).message).toContain("No voice 'nobody' on this server (voice_not_found)");
    expect(r.error(1).retryable).toBe(false);
    expect(r.error(2).message).toContain("CUDA out of memory");
    expect(r.error(2).retryable).toBe(true);
    // a failed item was not rendered, and a server you run yourself bills nothing for it
    for (const i of [1, 2])
      expect(r.reports[i]).toEqual([
        expect.objectContaining({ status: "failed", billed: false, audioSeconds: 0 }),
      ]);
    expect(r.reports[0][0].status).toBe("done");
  });

  test("is sent again whole when the server is too busy for it, and the gate is told", async () => {
    const s = server({ refuse: { status: 429, times: 1, retryAfter: "0" } });
    const r = await send(s);
    expect(r.thrown).toBeNull();
    expect(s.batches()).toHaveLength(2);
    expect(r.limited).toEqual([0]);
    expect(r.answered).toHaveLength(TEXTS.length);
    for (const rows of r.reports)
      expect(rows).toEqual([
        expect.objectContaining({ status: "done", attempts: 2, rateLimited: true }),
      ]);

    const busy = server({ refuse: { status: 503, times: 2 } });
    const again = await send(busy);
    expect(again.thrown).toBeNull();
    expect(busy.batches()).toHaveLength(3);
    expect(again.reports[0][0]).toMatchObject({ attempts: 3, rateLimited: false });
  });

  test("refused as unreadable fails every item, unbilled, and is not sent again", async () => {
    const s = server({ refuse: { status: 400, times: 5 } });
    const r = await send(s);
    expect(r.thrown).toBeInstanceOf(ProviderError);
    expect((r.thrown as ProviderError).status).toBe(400);
    expect((r.thrown as ProviderError).retryable).toBe(false);
    expect((r.thrown as ProviderError).message).toContain("Two items share one id");
    expect(s.batches()).toHaveLength(1);
    // the items are the caller's to fail; the ledger has each one's request all the same
    expect(r.answered).toEqual([]);
    for (const rows of r.reports)
      expect(rows).toEqual([
        expect.objectContaining({
          status: "failed",
          billed: false,
          error: expect.objectContaining({ code: 400 }),
        }),
      ]);
  });

  test("cut off part-way throws to be sent again, once the items that came are told", async () => {
    const s = server({ dropAfter: 2 });
    const r = await send(s);
    expect(r.thrown).toBeInstanceOf(ProviderError);
    const thrown = r.thrown as ProviderError;
    expect(thrown.retryable).toBe(true);
    expect(thrown.message).toContain("leaving 2 of its 4 lines unanswered");
    expect(r.answered.map((a) => a.index)).toEqual([0, 1]);
    expect(r.reports[0][0].status).toBe("done");
    for (const i of [2, 3])
      expect(r.reports[i]).toEqual([
        expect.objectContaining({
          status: "failed",
          billed: false,
          error: expect.objectContaining({ message: thrown.message }),
        }),
      ]);
  });

  test("that ends without its last line is cut off too — unless nothing is missing", async () => {
    const whole = await send(server({ noDone: true }));
    expect(whole.thrown).toBeNull();
    expect(whole.answered).toHaveLength(TEXTS.length);

    // an item the server never answered is left to be sent again, whether or not it said `done`
    for (const [noDone, said] of [
      [true, "before it said it was done"],
      [false, "said a batch was done"],
    ] as const) {
      const r = await send(server({ noDone, forget: [3] }));
      expect((r.thrown as ProviderError).retryable).toBe(true);
      expect((r.thrown as ProviderError).message).toContain(said);
      expect(r.answered.map((a) => a.index)).toEqual([0, 1, 2]);
      expect(r.reports[3]).toEqual([expect.objectContaining({ status: "failed", billed: false })]);
    }
  });

  test("outlives the endpoint's timeout while the server keeps talking", async () => {
    // four items at 150 ms each is 600 ms, three times the timeout; the pings say it is alive
    const target = { ...omni, timeoutSec: 0.2 };
    const s = server({ itemDelayMs: 150, pingEveryMs: 40 });
    const r = await send(s, TEXTS, { target });
    expect(r.thrown).toBeNull();
    expect(r.answered).toHaveLength(TEXTS.length);
  });

  test("gives up on a server that goes quiet for longer than the timeout", async () => {
    const target = { ...omni, timeoutSec: 0.2 };
    const s = server({ itemDelayMs: 600 });
    const r = await send(s, TEXTS.slice(0, 2), { target });
    expect(r.thrown).toBeInstanceOf(ProviderError);
    expect((r.thrown as ProviderError).retryable).toBe(true);
    expect((r.thrown as ProviderError).message).toContain("sent nothing for 0.2 s");
    expect(r.answered).toEqual([]);
    for (const rows of r.reports)
      expect(rows).toEqual([expect.objectContaining({ status: "failed", billed: false })]);
    // the request was closed, which is how a server knows to stop
    expect(s.state.cancelled).toBe(1);
  });

  test("cancelled mid-stream closes the request and reports nothing more", async () => {
    const s = server({ itemDelayMs: 30 });
    const job = new AbortController();
    const r = await send(s, TEXTS, {
      signal: job.signal,
      answered: (i) => i === 0 && job.abort(new Error("cancelled by the reader")),
    });
    expect((r.thrown as Error).message).toBe("cancelled by the reader");
    expect(r.answered.map((a) => a.index)).toEqual([0]);
    expect(r.reports.map((rows) => rows.length)).toEqual([1, 0, 0, 0]);
    expect(s.state.cancelled).toBe(1);
  });

  test("fails an item answered in another format than asked, billed — it was rendered", async () => {
    const s = server({ answerFormat: "mp3" });
    const r = await send(s, [TEXTS[0]]);
    expect(r.error(0).message).toContain("answered in mp3 where wav was asked for");
    expect(r.error(0).retryable).toBe(false);
    expect(r.reports[0]).toEqual([
      expect.objectContaining({
        status: "failed",
        billed: true,
        reported: expect.objectContaining({ chars: TEXTS[0].length }),
      }),
    ]);

    const garbled = server({ audioFor: () => Buffer.from("not audio").toString("base64") });
    const g = await send(garbled, [TEXTS[0]]);
    expect(g.error(0).message).toContain("is not a WAV");
    expect(g.reports[0][0]).toMatchObject({ status: "failed", billed: true });
  });

  test("ignores the lines it does not know, and any item answered twice or never sent", async () => {
    const wav = Buffer.from(toneWav(toneOf("mara"), 1, BATCH_RATE)).toString("base64");
    const item = (id: string, index: number) =>
      JSON.stringify({ type: "item", id, index, status: "done", format: "wav", audio: wav });
    const stream = [
      '{"type":"ping"}',
      '{"type":"progress","percent":50}',
      "this is not JSON",
      item("99", 99),
      item("0", 0),
      JSON.stringify({
        type: "item",
        id: "0",
        index: 0,
        status: "failed",
        error: { code: "render_failed", message: "second thoughts", retryable: true },
      }),
      // named by its place alone
      JSON.stringify({ type: "item", index: 1, status: "done", format: "wav", audio: wav }),
      '{"type":"done","items":{"done":2,"failed":0}}',
      item("1", 1),
    ].join("\n");
    const fetch = (async () =>
      new Response(stream, {
        headers: { "content-type": "application/x-ndjson" },
      })) as unknown as typeof globalThis.fetch;
    const r = await send({ ...server(), fetch }, TEXTS.slice(0, 2));
    expect(r.thrown).toBeNull();
    expect(r.answered.map((a) => a.index)).toEqual([0, 1]);
    expect(r.clip(0).duration).toBeCloseTo(1, 3);
    expect(r.reports.map((rows) => rows.length)).toEqual([1, 1]);
  });

  test("is refused item by item before a request, as a line is", async () => {
    const s = server();
    const r = await send(s, TEXTS.slice(0, 3), {
      items: (i) => (i === 1 ? { voiceRef: null } : {}),
    });
    expect(r.error(1).message).toContain("has no voice to speak with");
    expect(r.reports[1]).toEqual([]);
    expect(s.batches()[0].items.map((i) => i.input)).toEqual([TEXTS[0], TEXTS[2]]);
    expect(r.clip(0).duration).toBeGreaterThan(0);
    expect(r.clip(2).duration).toBeCloseTo(fakeDuration(TEXTS[2]), 3);

    // nothing left to send: nothing is sent
    const locked = server();
    const keyless = await send(locked, TEXTS.slice(0, 2), {
      target: { ...omni, needsKey: true },
    });
    expect(keyless.thrown).toBeNull();
    expect(keyless.error(0).message).toContain("needs an API key");
    expect(keyless.error(1).message).toContain("needs an API key");
    expect(locked.requests).toHaveLength(0);
  });
});

describe("the Test button", () => {
  test("says when the server takes batches", async () => {
    const s = server();
    const result = await provider(s.fetch).probe!(omni, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/lists “omnivoice” · takes batches of up to 16 lines$/);
  });

  test("passes a server that takes no batches, or cannot say, without a word about them", async () => {
    const none = server({ capabilitiesStatus: 404 });
    const plain = await provider(none.fetch).probe!(omni, new AbortController().signal);
    expect(plain.ok).toBe(true);
    expect(plain.message).not.toContain("batches");

    const broken = server({ capabilitiesStatus: 500 });
    const still = await provider(broken.fetch).probe!(omni, new AbortController().signal);
    expect(still.ok).toBe(true);
    expect(still.message).not.toContain("batches");
  });
});

describe("the plain route beside it", () => {
  test("still speaks one line at a time", async () => {
    const s = server();
    const clip = await provider(s.fetch).speak(line(TEXTS[0]));
    expect(clip.duration).toBeCloseTo(fakeDuration(TEXTS[0]), 3);
    expect(s.requests.map((r) => r.path)).toEqual(["/audio/speech"]);
  });
});
