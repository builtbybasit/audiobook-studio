// A voice sample on the Endpoints page: one saved voice saying one sentence.
//
// It is the one speech request no book asks for, and the one that goes to the endpoint itself
// whatever a test narrates through — so what these guard is that it is asked for the way a line of
// narration would be (the endpoint's voice, format and rate, with its saved key), that the audio
// comes back as the file it is with its length beside it, that the request lands in the ledger
// against the endpoint with no book, and that a sample that cannot be asked for says why.
import { describe, expect, test } from "bun:test";

import type { Endpoint, RequestRecord } from "@/types";
import { VOICE_SAMPLE } from "@/lib/endpointShapes";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
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
