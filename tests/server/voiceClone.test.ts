// Making a voice from recordings: `POST /api/endpoints/voices/clone`.
//
// Two halves. The route, with a cloner that answers from memory: what it refuses before anything
// leaves — no consent, no recordings, something that is not a recording, an endpoint whose
// provider keeps no cloned voice — and what it hands the cloner. And the real cloner, against a
// `fetch` that answers from memory: the multipart request Fish Audio's docs give, and what is made
// of the answer.
import { describe, expect, test } from "bun:test";

import type { Endpoint, Voice } from "@/types";
import { endpointVoiceCloner, type CloneRequest, type VoiceCloner } from "~/providers/clone";
import type { ProviderTarget } from "~/providers/target";
import { jsonBody, testApi, type TestApi } from "../support/server";

const fishEndpoint = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: "fish",
  name: "Fish Audio",
  baseUrl: "https://api.fish.audio/v1",
  model: "s2.1-pro",
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
  apiKey: "sk-fish",
  ...over,
});

/** A cloner that remembers what it was asked and answers with a voice. */
function remembering(): { cloner: VoiceCloner; asked: CloneRequest[] } {
  const asked: CloneRequest[] = [];
  return {
    asked,
    cloner: {
      async clone(_target, request) {
        asked.push(request);
        return { id: "new-voice-id", label: request.title, gender: "?" };
      },
    },
  };
}

async function saved(api: TestApi, ep: Endpoint): Promise<void> {
  const { status } = await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [ep], profiles: [], credentials: [] }),
    method: "PUT",
  });
  expect(status).toBe(200);
}

const clip = (name = "take-1.wav", type = "audio/wav", size = 1024) =>
  new File([new Uint8Array(size).fill(7)], name, { type });

function form(fields: Record<string, string>, clips: File[]): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const c of clips) f.append("clips", c, c.name);
  return f;
}

const post = (api: TestApi, body: FormData) =>
  api.request<Voice & { error?: { message: string } }>("/api/endpoints/voices/clone", {
    method: "POST",
    body,
  });

describe("the clone route", () => {
  test("hands the recordings and the name to the cloner, and answers with the new voice", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    await saved(api, fishEndpoint());
    const { status, body } = await post(
      api,
      form({ id: "fish", title: " Narrator — Mara ", consent: "yes" }, [
        clip("a.wav"),
        clip("b.mp3", "audio/mpeg", 2048),
      ]),
    );
    expect(status).toBe(201);
    expect(body).toEqual({ id: "new-voice-id", label: "Narrator — Mara", gender: "?" });
    expect(asked).toHaveLength(1);
    expect(asked[0].title).toBe("Narrator — Mara");
    // names and bytes as sent; the type as the form parser reads it (a WAV may come back audio/x-wav)
    expect(asked[0].clips.map((c) => [c.name, c.bytes.byteLength])).toEqual([
      ["a.wav", 1024],
      ["b.mp3", 2048],
    ]);
    expect(asked[0].clips.every((c) => c.type.startsWith("audio/"))).toBe(true);
  });

  test("refuses, before anything leaves, what it cannot or should not send", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    await saved(api, fishEndpoint());
    const refused = async (fields: Record<string, string>, clips: File[]) => {
      const { status, body } = await post(api, form(fields, clips));
      return [status, body.error?.message];
    };
    // consent is the person's say-so, and nothing goes without it
    expect(await refused({ id: "fish", title: "Mara" }, [clip()])).toEqual([
      400,
      "Confirm you have the right to clone this voice",
    ]);
    expect(await refused({ id: "fish", title: "Mara", consent: "yes" }, [])).toEqual([
      400,
      "Add at least one recording of the voice",
    ]);
    expect(
      await refused({ id: "fish", title: "Mara", consent: "yes" }, [
        clip("notes.txt", "text/plain"),
      ]),
    ).toEqual([400, "notes.txt is not a recording"]);
    expect(await refused({ id: "fish", title: "", consent: "yes" }, [clip()])).toEqual([
      400,
      "Give the voice a name of up to 100 characters",
    ]);
    expect(
      await refused(
        { id: "fish", title: "Mara", consent: "yes" },
        Array.from({ length: 21 }, (_, i) => clip(`t${i}.wav`)),
      ),
    ).toEqual([400, "Use at most 20 recordings"]);
    expect(asked).toEqual([]);
  });

  test("an endpoint that was never saved is not found, and one that keeps no clone is refused", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    await saved(
      api,
      fishEndpoint({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" }),
    );
    const missing = await post(api, form({ id: "fish", title: "Mara", consent: "yes" }, [clip()]));
    expect(missing.status).toBe(404);
    const openai = await post(api, form({ id: "openai", title: "Mara", consent: "yes" }, [clip()]));
    expect(openai.status).toBe(400);
    expect(openai.body.error?.message).toContain("only Fish Audio can");
    expect(asked).toEqual([]);
  });
});

describe("the Fish Audio cloner", () => {
  const target: ProviderTarget = {
    id: "fish",
    name: "Fish Audio",
    baseUrl: "https://api.fish.audio/v1",
    model: "s2.1-pro",
    apiKey: "sk-fish",
    needsKey: true,
    timeoutSec: 5,
    maxRetries: 0,
    cooldownSec: 0,
  };
  const request: CloneRequest = {
    title: "Mara",
    clips: [
      { name: "a.wav", type: "audio/wav", bytes: new Uint8Array([1, 2, 3]) },
      { name: "b.wav", type: "audio/wav", bytes: new Uint8Array([4, 5]) },
    ],
  };

  function fishAnswering(answer: () => Response) {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), init });
      return answer();
    }) as unknown as typeof globalThis.fetch;
    return { sent, cloner: endpointVoiceCloner({ fetch, backoffMs: () => 0 }) };
  }

  test("posts the multipart form Fish's docs give, private and ready at once", async () => {
    const f = fishAnswering(() =>
      Response.json({ _id: "a1b2c3", title: "Mara", type: "tts" }, { status: 201 }),
    );
    const voice = await f.cloner.clone(target, request, new AbortController().signal);
    expect(voice).toEqual({ id: "a1b2c3", label: "Mara", gender: "?" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].url).toBe("https://api.fish.audio/model");
    const headers = new Headers(f.sent[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-fish");
    // the boundary is the form's own: no JSON content type is forced onto it
    expect(headers.has("content-type")).toBe(false);
    const body = f.sent[0].init.body as FormData;
    expect([
      body.get("type"),
      body.get("title"),
      body.get("train_mode"),
      body.get("visibility"),
    ]).toEqual(["tts", "Mara", "fast", "private"]);
    const voices = body.getAll("voices") as File[];
    expect(voices.map((v) => [v.name, v.size])).toEqual([
      ["a.wav", 3],
      ["b.wav", 2],
    ]);
  });

  test("an answer without the new voice's id is a failure, and a refusal is read out", async () => {
    const noId = fishAnswering(() => Response.json({ title: "Mara" }));
    await expect(noId.cloner.clone(target, request, new AbortController().signal)).rejects.toThrow(
      "without the new voice's id",
    );
    const refused = fishAnswering(() =>
      Response.json({ message: "Invalid token" }, { status: 401 }),
    );
    await expect(
      refused.cloner.clone(target, request, new AbortController().signal),
    ).rejects.toThrow("Fish Audio answered 401: Invalid token");
  });

  test("a provider that keeps no clone is refused before any request", async () => {
    const f = fishAnswering(() => Response.json({}));
    await expect(
      f.cloner.clone(
        { ...target, name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow("only Fish Audio can");
    expect(f.sent).toEqual([]);
  });
});
