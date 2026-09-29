// A simulated speech endpoint (`simulated://…`): answered by the server's own tone, through the
// real provider, and never the network.
//
// Two parts. The provider on its own: the refusals a line still gets, the latency it waits and a
// cancel cuts short, the share of lines it fails and how, and the questions it answers without a
// request — batches, the Test button, its voices, a clone. And a whole narration through the real
// API: an endpoint saved as simulated, its voices fetched, sampled, cast and narrated, with every
// `fetch` the server was given failing the test if it is ever called.
import { describe, expect, test } from "bun:test";

import type { Endpoint, Job, Segment } from "@/types";
import { SIMULATED_BASE_URL, SIMULATED_SPEECH_MODEL, SIMULATED_VOICES } from "@/lib/providers";
import { endpointVoiceCloner } from "~/providers/clone";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { fakeDuration } from "~/providers/fakeSpeech";
import { ProviderError } from "~/providers/http";
import type { SentSpeech } from "~/providers/sent";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { endpointVoiceLister } from "~/providers/voices";
import { readWavHeader } from "~/providers/wavEncoder";
import { endpointRequests } from "~/usage/ledger";
import { story } from "../support/epub";
import {
  jsonBody,
  narrateChapters,
  saveEndpoints,
  speechEndpoint,
  testApi,
  voicedBook,
} from "../support/server";

/** A `fetch` that fails the test, and remembers where it was asked to go. */
function noNetwork() {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(String(url));
    throw new Error(`a simulated endpoint made a request: ${String(url)}`);
  }) as unknown as typeof globalThis.fetch;
  return { asked, fetch };
}

const target = (simulation = { latencyMs: 0, failRate: 0 }): ProviderTarget => ({
  id: "sim",
  name: "Simulated speech",
  baseUrl: SIMULATED_BASE_URL,
  model: SIMULATED_SPEECH_MODEL,
  apiKey: null,
  // a simulated endpoint needs no key, whatever it says
  needsKey: true,
  timeoutSec: 5,
  maxRetries: 2,
  cooldownSec: 0,
  simulation,
});

const line = (t: ProviderTarget | null, over: Partial<SpeechInput> = {}): SpeechInput => ({
  text: "Come in, and shut the door.",
  speaker: "Mara",
  type: "dialogue",
  direction: "",
  instructions: "",
  voiceRef: "sim/ash",
  sampleRate: 24000,
  encoding: { format: "wav" },
  target: t,
  signal: new AbortController().signal,
  ...over,
});

/** Collects what a provider reports through `sent`. */
function reports() {
  const got: SentSpeech[] = [];
  return { got, sent: (r: SentSpeech) => void got.push(r) };
}

describe("a simulated endpoint's line", () => {
  test("is a tone at the rate asked for, named with the endpoint's model, and reported as simulated", async () => {
    const net = noNetwork();
    const r = reports();
    const clip = await endpointSpeechProvider({ fetch: net.fetch }).speak(
      line(target(), { sent: r.sent }),
    );
    expect(clip).toMatchObject({
      format: "wav",
      mime: "audio/wav",
      model: SIMULATED_SPEECH_MODEL,
      voice: "ash",
    });
    expect(clip.duration).toBeCloseTo(fakeDuration("Come in, and shut the door."), 6);
    expect(readWavHeader(clip.bytes).sampleRate).toBe(24000);
    expect(r.got).toEqual([
      expect.objectContaining({ status: "done", simulated: true, attempts: 1, billed: true }),
    ]);
    expect(net.asked).toEqual([]);
  });

  test("is refused before anything when it has no voice or no endpoint, and reports nothing", async () => {
    const provider = endpointSpeechProvider({ fetch: noNetwork().fetch });
    const r = reports();
    await expect(provider.speak(line(target(), { voiceRef: null, sent: r.sent }))).rejects.toThrow(
      "has no voice",
    );
    await expect(provider.speak(line(null, { sent: r.sent }))).rejects.toThrow(
      "no longer configured",
    );
    // held to the formats it has, like any provider: WAV only
    await expect(
      provider.speak(line(target(), { encoding: { format: "mp3" }, sent: r.sent })),
    ).rejects.toThrow("cannot be asked for");
    expect(r.got).toEqual([]);
  });

  test("fails every line at a fail rate of 1, as a server error worth another try, and none at 0", async () => {
    const r = reports();
    const failing = endpointSpeechProvider({ random: () => 0.99 });
    for (const text of ["One.", "Two.", "Three."]) {
      const e = await failing
        .speak(line(target({ latencyMs: 0, failRate: 1 }), { text, sent: r.sent }))
        .catch((e: unknown) => e);
      expect(e).toBeInstanceOf(ProviderError);
      expect(e).toMatchObject({ retryable: true, status: 500 });
      expect((e as Error).message).toContain("fails 100% of them");
    }
    expect(r.got).toHaveLength(3);
    for (const sent of r.got)
      expect(sent).toMatchObject({
        status: "failed",
        billed: false,
        simulated: true,
        audioSeconds: 0,
        error: { code: 500 },
      });

    const never = endpointSpeechProvider({ random: () => 0 });
    for (const text of ["One.", "Two.", "Three."])
      expect(
        (await never.speak(line(target({ latencyMs: 0, failRate: 0 }), { text }))).duration,
      ).toBeGreaterThan(0);
  });

  test("fails the lines whose draw falls within its fail rate", async () => {
    const draws = [0.1, 0.6, 0.2, 0.9];
    const provider = endpointSpeechProvider({ random: () => draws.shift()! });
    const outcomes = [];
    for (let i = 0; i < 4; i++)
      outcomes.push(
        await provider.speak(line(target({ latencyMs: 0, failRate: 0.5 }))).then(
          () => "done",
          () => "failed",
        ),
      );
    expect(outcomes).toEqual(["failed", "done", "failed", "done"]);
  });

  test("takes as long as its latency, and a cancel cuts the wait short and reports nothing", async () => {
    const provider = endpointSpeechProvider();
    const started = Date.now();
    const clip = await provider.speak(line(target({ latencyMs: 40, failRate: 0 })));
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(clip.ms).toBeGreaterThanOrEqual(35);

    const controller = new AbortController();
    const r = reports();
    const run = provider.speak(
      line(target({ latencyMs: 10_000, failRate: 0 }), {
        signal: controller.signal,
        sent: r.sent,
      }),
    );
    const cancelled = Date.now();
    controller.abort(new Error("cancelled"));
    await expect(run).rejects.toThrow("cancelled");
    expect(Date.now() - cancelled).toBeLessThan(1000);
    expect(r.got).toEqual([]);
  });
});

describe("what a simulated endpoint answers without a request", () => {
  test("takes one line at a time, and its Test button says it answered here", async () => {
    const net = noNetwork();
    const provider = endpointSpeechProvider({ fetch: net.fetch });
    const signal = new AbortController().signal;
    expect(await provider.batchLimits!(target(), signal)).toBeNull();
    expect(await provider.probe!(target(), signal)).toEqual({
      ok: true,
      message: "Simulated: answered here, without a request",
      ms: 0,
    });
    expect(net.asked).toEqual([]);
  });

  test("lists the voices it names, needs no key for them, and has no public catalogue", async () => {
    const net = noNetwork();
    const lister = endpointVoiceLister({ fetch: net.fetch });
    const signal = new AbortController().signal;
    expect(await lister.list(target(), { source: "library" }, signal)).toEqual({
      voices: [...SIMULATED_VOICES],
      total: SIMULATED_VOICES.length,
      page: 1,
      hasMore: false,
    });
    await expect(lister.list(target(), { source: "public" }, signal)).rejects.toThrow(
      "has no public voice catalogue",
    );
    expect(net.asked).toEqual([]);
  });

  test("makes no voice from samples", async () => {
    const net = noNetwork();
    const e = await endpointVoiceCloner({ fetch: net.fetch })
      .clone(target(), { title: "Mine", samples: [] }, new AbortController().signal)
      .catch((e: unknown) => e);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as Error).message).toContain("cannot make a voice from samples");
    expect(net.asked).toEqual([]);
  });
});

describe("narrating through a simulated endpoint", () => {
  test("fetches, samples, casts and narrates end to end without a request leaving the server", async () => {
    const net = noNetwork();
    const api = testApi({
      speech: endpointSpeechProvider({ fetch: net.fetch }),
      samples: endpointSpeechProvider({ fetch: net.fetch }),
      voices: endpointVoiceLister({ fetch: net.fetch }),
    });
    const endpoint = speechEndpoint({
      id: "sim",
      name: "Simulated speech",
      baseUrl: SIMULATED_BASE_URL,
      model: SIMULATED_SPEECH_MODEL,
      sampleRate: 22050,
      voices: [],
    });
    expect((await saveEndpoints(api, [endpoint])).status).toBe(200);

    const tested = await api.request<{ ok: boolean; message: string }>(
      "/api/endpoints/test",
      jsonBody({ kind: "tts", id: "sim" }),
    );
    expect(tested.body).toMatchObject({ ok: true, message: expect.stringContaining("Simulated") });

    // "Fetch from server", and the voices put on the endpoint the way the page does
    const listed = await api.request<{ voices: Endpoint["voices"] }>(
      "/api/endpoints/voices",
      jsonBody({ id: "sim", source: "library" }),
    );
    expect(listed.status).toBe(200);
    expect(listed.body.voices.map((v) => v.id)).toContain("birch");
    expect((await saveEndpoints(api, [{ ...endpoint, voices: listed.body.voices }])).status).toBe(
      200,
    );

    // the Voices tab's sample is the tone, at the endpoint's rate
    const sample = await api.fetch(
      "/api/endpoints/sample",
      jsonBody({ id: "sim", voice: "birch" }),
    );
    expect(sample.status).toBe(200);
    expect(sample.headers.get("content-type")).toBe("audio/wav");
    expect(readWavHeader(new Uint8Array(await sample.arrayBuffer())).sampleRate).toBe(22050);

    // the endpoint as saved above, with its voices: the book is cast with one of them
    const id = await voicedBook(api, {
      paragraphs: ["“We are short again,” said Mara.", ...story(3)],
      voiceOf: "sim/birch",
    });

    const [queued] = await narrateChapters(api, id, [1]);
    const job = (await api.request<{ job: Job }>(`/api/jobs/${queued.id}`)).body.job;
    expect(job.status).toBe("done");

    const { segments } = (
      await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`)
    ).body;
    expect(segments.length).toBeGreaterThan(2);
    for (const s of segments) {
      expect(s.audio.status).toBe("done");
      expect(s.audio.model).toBe(SIMULATED_SPEECH_MODEL);
      const res = await api.fetch(s.audio.url!, {});
      expect(res.headers.get("content-type")).toBe("audio/wav");
      const wav = readWavHeader(new Uint8Array(await res.arrayBuffer()));
      expect(wav.sampleRate).toBe(22050);
      expect(s.audio.duration).toBeCloseTo(fakeDuration(s.audio.said ?? s.text), 2);
    }

    // one row a line and one for the sample, every one simulated, and nothing charged
    const rows = endpointRequests(api.db, "tts", "sim", 0);
    expect(rows).toHaveLength(segments.length + 1);
    for (const row of rows) {
      expect(row.simulated).toBe(true);
      expect(row.status).toBe("done");
      expect(row.cost).toBe(0);
    }
    expect(net.asked).toEqual([]);
  });
});
