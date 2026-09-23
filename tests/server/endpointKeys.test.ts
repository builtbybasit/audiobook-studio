// An endpoint's key on the server, and the Test button that uses it.
//
// The key is the one secret the database holds, so what matters is where it does *not* go: never
// back over HTTP, never into a log line, and never lost by a save that did not mention it — the
// page cannot send back a key it was never given, so "absent" has to mean "keep". The Test route
// asks the saved endpoint, with the saved key, through whichever provider the server runs.
import { describe, expect, test } from "bun:test";

import type { Endpoint, Profile } from "@/types";
import { readEndpointKey } from "~/db/endpoints";
import type { ScriptingProvider } from "~/providers/scripting";
import type { SpeechProvider } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { jsonBody, testApi, type TestApi } from "../support/server";

const speech = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: "fish",
  name: "Fish Audio (free)",
  baseUrl: "https://api.fish.audio/v1",
  model: "s2.1-pro-free",
  concurrency: 1,
  enabled: true,
  latency: 0,
  failRate: 0,
  price: 0,
  needsKey: true,
  maxChars: 0,
  splitAt: "sentence",
  voices: [],
  history: [],
  failures: 0,
  rateLimits: 0,
  backoffUntil: 0,
  ...over,
});

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: "fish",
  name: "Gateway",
  model: "chat-model",
  inPrice: 0,
  outPrice: 0,
  baseUrl: "http://localhost:9092/v1",
  enabled: true,
  concurrency: 1,
  maxChars: 0,
  splitAt: "sentence",
  maxOutputTokens: 0,
  secPerChunk: 0,
  needsKey: true,
  ...over,
});

const save = (api: TestApi, endpoints: Endpoint[], profiles: Profile[] = []) =>
  api.request<{ endpoints: Endpoint[]; profiles: Profile[] }>("/api/endpoints", {
    ...jsonBody({ endpoints, profiles, credentials: [] }),
    method: "PUT",
  });

describe("an endpoint's key", () => {
  test("is kept, said to be there, and never sent back", async () => {
    const api = testApi();
    const { body } = await save(
      api,
      [speech({ apiKey: "sk-speech" })],
      [profile({ apiKey: "sk-chat" })],
    );
    expect(body.endpoints[0]).toMatchObject({ hasKey: true });
    expect(body.profiles[0]).toMatchObject({ hasKey: true });
    const read = await api.fetch("/api/endpoints");
    const text = await read.text();
    expect(text).not.toContain("sk-speech");
    expect(text).not.toContain("sk-chat");
    // a speech endpoint and a profile under one id keep separate keys
    expect(readEndpointKey(api.db, "tts", "fish")).toBe("sk-speech");
    expect(readEndpointKey(api.db, "scripting", "fish")).toBe("sk-chat");
    expect(JSON.stringify(api.logs)).not.toContain("sk-");
  });

  test("survives a save that does not mention it, and goes when sent empty", async () => {
    const api = testApi();
    await save(api, [speech({ apiKey: "sk-speech" })]);
    // what the page sends back after a read: `hasKey`, and no key
    const { body } = await save(api, [speech({ name: "Renamed", hasKey: true })]);
    expect(body.endpoints[0]).toMatchObject({ name: "Renamed", hasKey: true });
    expect(readEndpointKey(api.db, "tts", "fish")).toBe("sk-speech");

    const cleared = await save(api, [speech({ apiKey: "" })]);
    expect(cleared.body.endpoints[0]).not.toHaveProperty("hasKey");
    expect(readEndpointKey(api.db, "tts", "fish")).toBeNull();
  });

  test("is replaced by a new one, and goes with its endpoint", async () => {
    const api = testApi();
    await save(api, [speech({ apiKey: "sk-old" })]);
    await save(api, [speech({ apiKey: "sk-new" })]);
    expect(readEndpointKey(api.db, "tts", "fish")).toBe("sk-new");
    await save(api, []);
    await save(api, [speech()]);
    expect(readEndpointKey(api.db, "tts", "fish")).toBeNull();
  });
});

describe("testing a saved endpoint", () => {
  const recording = () => {
    const seen: ProviderTarget[] = [];
    const speechProvider: SpeechProvider = {
      name: "Recording speech",
      speak: () => Promise.reject(new Error("not in this test")),
      probe: async (target) => {
        seen.push(target);
        return { ok: true, message: "Answered", ms: 12 };
      },
    };
    const scripting: ScriptingProvider = {
      name: "Recording scripting",
      script: () => Promise.reject(new Error("not in this test")),
      probe: async (target) => {
        seen.push(target);
        return { ok: false, message: "401: key refused", ms: 30 };
      },
    };
    return { seen, speechProvider, scripting };
  };

  test("asks the provider with the saved configuration and key, and answers what it found", async () => {
    const { seen, speechProvider, scripting } = recording();
    const api = testApi({ speech: speechProvider, scripting });
    await save(
      api,
      [speech({ apiKey: "sk-speech", baseUrl: "https://api.fish.audio/v1/", timeoutSec: 9 })],
      [profile({ apiKey: "sk-chat", maxOutputTokens: 4000 })],
    );
    const tts = await api.request("/api/endpoints/test", jsonBody({ kind: "tts", id: "fish" }));
    expect(tts).toEqual({ status: 200, body: { ok: true, message: "Answered", ms: 12 } });
    const chat = await api.request(
      "/api/endpoints/test",
      jsonBody({ kind: "scripting", id: "fish" }),
    );
    expect(chat.body).toEqual({ ok: false, message: "401: key refused", ms: 30 });

    expect(seen[0]).toMatchObject({
      baseUrl: "https://api.fish.audio/v1",
      model: "s2.1-pro-free",
      apiKey: "sk-speech",
      timeoutSec: 9,
    });
    // a profile saved with no operational block takes the page's defaults for its kind
    expect(seen[1]).toMatchObject({
      apiKey: "sk-chat",
      maxOutputTokens: 4000,
      timeoutSec: 120,
      maxRetries: 3,
    });
    expect(JSON.stringify(api.logs)).not.toContain("sk-");
  });

  test("an endpoint that was never saved is a 404, and the fakes answer without a request", async () => {
    const api = testApi();
    const missing = await api.request<{ error: { code: string } }>(
      "/api/endpoints/test",
      jsonBody({ kind: "tts", id: "fish" }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");

    await save(api, [speech()]);
    const fake = await api.request<{ ok: boolean; message: string }>(
      "/api/endpoints/test",
      jsonBody({ kind: "tts", id: "fish" }),
    );
    expect(fake.body.ok).toBe(true);
    expect(fake.body.message).toContain("SPEECH_PROVIDER=fake");
  });
});

describe("an endpoint's format", () => {
  test("is kept with its bitrate, read back as sent, and absent reads back as none", async () => {
    const api = testApi();
    const { body } = await save(api, [
      speech({ encoding: { format: "mp3", bitrate: 128 }, sampleRate: 44100 }),
      speech({ id: "plain", name: "Plain" }),
    ]);
    expect(body.endpoints[0]).toMatchObject({
      encoding: { format: "mp3", bitrate: 128 },
      sampleRate: 44100,
    });
    expect(body.endpoints[1]).not.toHaveProperty("encoding");
    const opus = await save(api, [speech({ encoding: { format: "opus" } })]);
    expect(opus.body.endpoints[0].encoding).toEqual({ format: "opus" });
  });

  test("a format the app does not keep clips in is refused", async () => {
    const api = testApi();
    const { status } = await save(api, [speech({ encoding: { format: "flac" as "wav" } })]);
    expect(status).toBe(400);
  });
});
