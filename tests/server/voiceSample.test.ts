// A voice sample: what the demo buttons and the Endpoints page play for one saved voice.
//
// It is the one speech request no book asks for, and the one that goes to the endpoint itself
// whatever a test narrates through — so what these guard is that it is asked for the way a line of
// narration would be (the endpoint's voice, format and rate, with its saved key), that the audio
// comes back as the file it is with its length beside it, that the request lands in the ledger
// against the endpoint with no book, and that a sample that cannot be asked for says why. And that
// it is paid for once: kept on the server, played from disk after, made again only when the
// endpoint would sound different — and for a Fish voice, Fish's own recording, free, before any
// sentence is rendered.
import { describe, expect, test } from "bun:test";

import type { Endpoint, RequestRecord } from "@/types";
import { VOICE_SAMPLE } from "@/lib/endpointShapes";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { endpointVoiceLister } from "~/providers/voices";
import { voiceFiles } from "~/voices/files";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import type { SpeechInput, SpeechProvider } from "~/providers/speech";
import { readWavHeader } from "~/providers/wavEncoder";
import { jsonBody, testApi, type TestApi } from "../support/server";

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
  needsKey: false,
  maxChars: 0,
  splitAt: "sentence",
  voices: [{ id: "ash", gender: "m", label: "Ash" }],
  history: [],
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
  ...over,
});

/** The fake, remembering what it was asked. */
function recording(): { provider: SpeechProvider; asked: SpeechInput[] } {
  const fake = fakeSpeechProvider();
  const asked: SpeechInput[] = [];
  return {
    asked,
    provider: { ...fake, speak: (input) => (asked.push(input), fake.speak(input)) },
  };
}

async function saved(api: TestApi, ep: Endpoint = speech()): Promise<void> {
  const { status } = await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [ep], profiles: [], credentials: [] }),
    method: "PUT",
  });
  expect(status).toBe(200);
}

const sample = (api: TestApi, id: string, voice: string) =>
  api.fetch("/api/endpoints/sample", jsonBody({ id, voice }));

describe("a voice sample", () => {
  test("is the saved voice saying the sample, asked for as the endpoint asks for a line", async () => {
    const { provider, asked } = recording();
    const api = testApi({ samples: provider });
    await saved(api, speech({ sampleRate: 24000 }));

    const res = await sample(api, "studio", "ash");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(readWavHeader(bytes).sampleRate).toBe(24000);
    expect(Number(res.headers.get("x-audio-duration"))).toBeGreaterThan(0);

    expect(asked).toHaveLength(1);
    expect(asked[0].text).toBe(VOICE_SAMPLE);
    expect(asked[0].voiceRef).toBe("studio/ash");
    expect(asked[0].speaker).toBe("Ash");
    expect(asked[0].sampleRate).toBe(24000);
    expect(asked[0].encoding).toEqual({ format: "wav" });
    // the endpoint as saved, tried once like a connection test
    expect(asked[0].target).toMatchObject({ id: "studio", model: "studio-tts", maxRetries: 0 });
  });

  test("is a row in the ledger against the endpoint, with no book", async () => {
    const api = testApi({ samples: fakeSpeechProvider() });
    await saved(api);
    expect((await sample(api, "studio", "ash")).status).toBe(200);

    const { body } = await api.request<{ requests: RequestRecord[] }>(
      "/api/endpoints/requests?kind=tts&id=studio&range=1h",
    );
    expect(body.requests).toHaveLength(1);
    const [row] = body.requests;
    expect([row.kind, row.bookId, row.chapterId, row.status]).toEqual(["tts", null, null, "done"]);
    expect(row.label).toBe("Voice sample · Ash");
    expect(row.usage.chars).toBe(VOICE_SAMPLE.length);
    // the fake's rows are marked, so nobody reads them as a bill
    expect(row.simulated).toBe(true);
  });

  test("of an endpoint that is not saved is not found", async () => {
    const api = testApi({ samples: fakeSpeechProvider() });
    const res = await sample(api, "nowhere", "ash");
    expect(res.status).toBe(404);
  });

  test("of an endpoint that needs a key and has none is refused before any request", async () => {
    // the real provider, which refuses before reaching the network
    const api = testApi({ samples: endpointSpeechProvider() });
    await saved(api, speech({ needsKey: true }));
    const res = await sample(api, "studio", "ash");
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { message: string } };
    expect(error.message).toContain("needs an API key");
    const { body } = await api.request<{ requests: RequestRecord[] }>(
      "/api/endpoints/requests?kind=tts&id=studio&range=1h",
    );
    expect(body.requests).toEqual([]);
  });

  test("without a voice is refused by the route", async () => {
    const api = testApi({ samples: fakeSpeechProvider() });
    await saved(api);
    expect((await sample(api, "studio", "")).status).toBe(400);
  });
});

const ledger = async (api: TestApi, id = "studio") =>
  (
    await api.request<{ requests: RequestRecord[] }>(
      `/api/endpoints/requests?kind=tts&id=${id}&range=1h`,
    )
  ).body.requests;

describe("a voice heard before", () => {
  test("is played from what the server kept, and the provider is asked once", async () => {
    const { provider, asked } = recording();
    const api = testApi({ samples: provider });
    await saved(api);

    const first = await sample(api, "studio", "ash");
    expect(first.headers.get("x-sample-source")).toBe("rendered");
    expect(first.headers.get("x-sample-kept")).toBe("0");
    const bytes = new Uint8Array(await first.arrayBuffer());

    const again = await sample(api, "studio", "ash");
    expect(again.status).toBe(200);
    expect(again.headers.get("x-sample-kept")).toBe("1");
    expect(again.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(bytes);

    expect(asked).toHaveLength(1);
    expect(await ledger(api)).toHaveLength(1);
  });

  test("is made again once the endpoint would sound different, in place of the old one", async () => {
    const { provider, asked } = recording();
    const api = testApi({ samples: provider });
    await saved(api);
    await sample(api, "studio", "ash");

    await saved(api, speech({ sampleRate: 16000 }));
    const res = await sample(api, "studio", "ash");
    expect(res.headers.get("x-sample-kept")).toBe("0");
    expect(readWavHeader(new Uint8Array(await res.arrayBuffer())).sampleRate).toBe(16000);
    expect(asked).toHaveLength(2);

    // the one made at the old rate is gone, not kept beside it
    const heard = await voiceFiles(api.voiceDir).heard.read("studio", "ash", [
      JSON.stringify([
        "rendered",
        "http://localhost:8880/v1",
        "studio-tts",
        { format: "wav" },
        null,
        VOICE_SAMPLE,
      ]),
    ]);
    expect(heard).toBeNull();
  });

  test("of a simulated endpoint is never kept: its tone costs nothing to make again", async () => {
    const { provider, asked } = recording();
    const api = testApi({ samples: provider });
    await saved(api, speech({ baseUrl: "simulated://studio" }));
    await sample(api, "studio", "ash");
    const again = await sample(api, "studio", "ash");
    expect(again.headers.get("x-sample-kept")).toBe("0");
    expect(asked).toHaveLength(2);
  });

  test("goes with its endpoint when the endpoint is removed", async () => {
    const api = testApi({ samples: fakeSpeechProvider() });
    await saved(api);
    await sample(api, "studio", "ash");
    const files = voiceFiles(api.voiceDir);
    const kept = () =>
      files.heard.read("studio", "ash", [
        JSON.stringify([
          "rendered",
          "http://localhost:8880/v1",
          "studio-tts",
          { format: "wav" },
          null,
          VOICE_SAMPLE,
        ]),
      ]);
    expect(await kept()).not.toBeNull();

    const { status } = await api.request("/api/endpoints", {
      ...jsonBody({ endpoints: [], profiles: [], credentials: [] }),
      method: "PUT",
    });
    expect(status).toBe(200);
    // removed in the background, after the save has answered
    for (let i = 0; i < 50 && (await kept()); i++) await Bun.sleep(10);
    expect(await kept()).toBeNull();
  });
});

describe("a Fish voice", () => {
  const FISH_VOICE = "a72da0ea93864e718cce0cbaad258c55";
  const RECORDING = "https://platform.r2.fish.audio/task/sample.mp3";
  /** an MP3 as far as its first bytes say: an ID3 tag, and something after it */
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
  const fish = (over: Partial<Endpoint> = {}) =>
    speech({
      id: "fish",
      name: "Fish Audio",
      baseUrl: "https://api.fish.audio/v1",
      model: "s2.1-pro",
      needsKey: true,
      apiKey: "sk-fish",
      voices: [{ id: FISH_VOICE, gender: "m", label: "Eren" }],
      ...over,
    });

  /** Fish, answering the model with `samples` and the recording's file from its CDN. */
  function fishApi(samples: unknown[] | Response) {
    const seen: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url === RECORDING) return new Response(mp3);
      if (samples instanceof Response) return samples;
      return new Response(
        JSON.stringify({ _id: FISH_VOICE, type: "tts", state: "trained", samples }),
      );
    }) as typeof globalThis.fetch;
    const speaking = recording();
    const api = testApi({
      samples: speaking.provider,
      voices: endpointVoiceLister({ fetch, backoffMs: () => 0 }),
    });
    return { api, seen, asked: speaking.asked };
  }

  test("plays Fish's own recording of it, free, and keeps it", async () => {
    const { api, seen, asked } = fishApi([{ title: "s", text: "Hello there.", audio: RECORDING }]);
    await saved(api, fish());

    const res = await sample(api, "fish", FISH_VOICE);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-sample-source")).toBe("recording");
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    // the file says how long it plays; the server does not
    expect(res.headers.get("x-audio-duration")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(mp3);
    expect(seen).toEqual([`https://api.fish.audio/model/${FISH_VOICE}`, RECORDING]);
    // nothing rendered, nothing billed
    expect(asked).toEqual([]);
    expect(await ledger(api, "fish")).toEqual([]);

    const again = await sample(api, "fish", FISH_VOICE);
    expect(again.headers.get("x-sample-kept")).toBe("1");
    expect(again.headers.get("x-sample-source")).toBe("recording");
    expect(seen).toHaveLength(2);
  });

  test("with no recording of its own has the endpoint say the sentence", async () => {
    const { api, asked } = fishApi([]);
    await saved(api, fish());
    const res = await sample(api, "fish", FISH_VOICE);
    expect(res.headers.get("x-sample-source")).toBe("rendered");
    expect(asked).toHaveLength(1);
    expect(asked[0].text).toBe(VOICE_SAMPLE);
  });

  test("that Fish cannot be asked about is rendered instead, not refused", async () => {
    const { api, asked } = fishApi(new Response("down", { status: 503 }));
    await saved(api, fish());
    const res = await sample(api, "fish", FISH_VOICE);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-sample-source")).toBe("rendered");
    expect(asked).toHaveLength(1);
  });

  test("a recording off Fish's own hosts is never fetched", async () => {
    const { api, seen, asked } = fishApi([{ text: "", audio: "https://elsewhere.example/a.mp3" }]);
    await saved(api, fish());
    const res = await sample(api, "fish", FISH_VOICE);
    expect(res.headers.get("x-sample-source")).toBe("rendered");
    expect(seen).toEqual([`https://api.fish.audio/model/${FISH_VOICE}`]);
    expect(asked).toHaveLength(1);
  });
});
