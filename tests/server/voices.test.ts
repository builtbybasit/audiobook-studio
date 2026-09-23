// Listing a saved endpoint's voices: `POST /api/endpoints/voices`.
//
// The real lister runs here, against a `fetch` that answers from memory, so what is checked is what
// goes on the wire — the query Fish is sent, the key, the pages — and what comes back of it: only
// voices that can narrate, labelled to pick from, and a refusal said in words.
import { describe, expect, test } from "bun:test";

import type { Endpoint } from "@/types";
import { endpointVoiceLister, OPENAI_VOICES, type VoicePage } from "~/providers/voices";
import { jsonBody, testApi, type TestApi } from "../support/server";

const speech = (over: Partial<Endpoint> = {}): Endpoint => ({
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

const model = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  type: "tts",
  state: "trained",
  title: `Voice ${id}`,
  languages: ["en"],
  tags: ["female", "calm", "narration", "deep"],
  visibility: "public",
  ...over,
});

interface Seen {
  url: URL;
  auth: string | null;
}

/** An API whose voice lister's `fetch` is `answer`, recording every request. */
async function api(
  answer: (url: URL) => Response,
  endpoint = speech(),
): Promise<{ api: TestApi; seen: Seen[] }> {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return answer(url);
  }) as typeof globalThis.fetch;
  const t = testApi({ voices: endpointVoiceLister({ fetch, backoffMs: () => 0 }) });
  await t.request("/api/endpoints", {
    ...jsonBody({ endpoints: [endpoint], profiles: [], credentials: [] }),
    method: "PUT",
  });
  return { api: t, seen };
}

const list = (t: TestApi, body: Record<string, unknown>) =>
  t.request<VoicePage & { error?: { code: string; message: string } }>(
    "/api/endpoints/voices",
    jsonBody({ id: "fish", ...body }),
  );

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("a Fish library", () => {
  test("is read page by page with the saved key, and only its voices come back", async () => {
    const { api: t, seen } = await api((url) => {
      const page = Number(url.searchParams.get("page_number"));
      return page === 1
        ? json({
            total: 101,
            has_more: true,
            items: [
              ...Array.from({ length: 99 }, (_, i) => model(`a${i}`)),
              model("svc", { type: "svc" }),
            ],
          })
        : json({ total: 101, has_more: false, items: [model("last", { state: "training" })] });
    });
    const { status, body } = await list(t, { source: "library" });
    expect(status).toBe(200);
    expect(seen.map((s) => s.url.origin + s.url.pathname)).toEqual([
      "https://api.fish.audio/model",
      "https://api.fish.audio/model",
    ]);
    expect(seen.map((s) => s.url.searchParams.get("page_number"))).toEqual(["1", "2"]);
    expect(seen[0].url.searchParams.get("self")).toBe("true");
    expect(seen[0].url.searchParams.get("page_size")).toBe("100");
    expect(seen[0].auth).toBe("Bearer sk-fish");
    // the voice-conversion model and the one still training are not voices
    expect(body).toMatchObject({ total: 99, page: 1, hasMore: false });
    expect(body.voices[0]).toEqual({
      id: "a0",
      label: "Voice a0 (EN · calm, narration)",
      gender: "f",
    });
    expect(JSON.stringify(t.logs)).not.toContain("sk-fish");
  });

  test("an empty library is an empty list", async () => {
    const { api: t } = await api(() => json({ total: 0, has_more: false, items: [] }));
    expect((await list(t, { source: "library" })).body).toEqual({
      voices: [],
      total: 0,
      page: 1,
      hasMore: false,
    });
  });
});

describe("a Fish public search", () => {
  test("asks for one page by title and language, best first, and keeps only TTS voices", async () => {
    const { api: t, seen } = await api(() =>
      json({
        total: 200,
        has_more: true,
        items: [model("n1", { title: "Narrator", tags: ["male"] }), model("x", { type: "svc" })],
      }),
    );
    const { body } = await list(t, {
      source: "public",
      query: " narrator ",
      language: "en",
      page: 2,
    });
    const q = seen[0].url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      page_size: "30",
      page_number: "2",
      sort_by: "score",
      title: "narrator",
      language: "en",
    });
    expect(q.has("self")).toBe(false);
    expect(body).toEqual({
      voices: [{ id: "n1", label: "Narrator (EN)", gender: "m" }],
      total: 200,
      page: 2,
      hasMore: true,
    });
  });

  test("a pasted id asks for that one model, and an unknown one finds nothing", async () => {
    const id = "933563129e564b19a115bedd57b7406a";
    const { api: t, seen } = await api((url) =>
      url.pathname.endsWith(id) ? json(model(id, { title: "Sarah" })) : json({}, 404),
    );
    const found = await list(t, { source: "public", query: id.toUpperCase() });
    expect(seen[0].url.pathname).toBe(`/model/${id}`);
    expect(found.body.voices.map((v) => v.id)).toEqual([id]);
    const missing = await list(t, { source: "public", query: "0".repeat(32) });
    expect(missing.body).toMatchObject({ voices: [], total: 0 });
  });
});

describe("listing refusals", () => {
  test("an endpoint that was never saved is a 404, and no request goes out", async () => {
    const { api: t, seen } = await api(() => json({ items: [] }));
    const { status, body } = await t.request<{ error: { code: string } }>(
      "/api/endpoints/voices",
      jsonBody({ id: "nowhere", source: "library" }),
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(seen).toEqual([]);
  });

  test("an endpoint that needs a key and has none is refused before any request", async () => {
    const { api: t, seen } = await api(() => json({ items: [] }), speech({ apiKey: undefined }));
    const { status, body } = await list(t, { source: "library" });
    expect(status).toBe(400);
    expect(body.error?.message).toContain("needs an API key");
    expect(seen).toEqual([]);
  });

  test("what the provider said is passed on", async () => {
    const { api: t } = await api(() => json({ message: "Invalid token" }, 401));
    const { status, body } = await list(t, { source: "library" });
    expect(status).toBe(502);
    expect(body.error?.message).toBe("Fish Audio answered 401: Invalid token");
  });

  test("an OpenAI-shaped endpoint has no public catalogue", async () => {
    const { api: t, seen } = await api(
      () => json({}),
      speech({ baseUrl: "http://localhost:8880/v1", needsKey: false }),
    );
    const { status, body } = await list(t, { source: "public", query: "bella" });
    expect(status).toBe(400);
    expect(body.error?.message).toContain("only Fish Audio");
    expect(seen).toEqual([]);
  });
});

describe("an OpenAI-shaped endpoint's list", () => {
  test("OpenAI's own is its documented voices, asked of nobody", async () => {
    const { api: t, seen } = await api(
      () => json({}),
      speech({ baseUrl: "https://api.openai.com/v1" }),
    );
    const { body } = await list(t, { source: "library" });
    expect(body.voices.map((v) => v.id)).toEqual([...OPENAI_VOICES]);
    expect(body.voices[0]).toEqual({ id: "alloy", label: "Alloy", gender: "?" });
    expect(seen).toEqual([]);
  });

  test("a local server is asked GET /audio/voices, and Kokoro's names give a gender", async () => {
    const { api: t, seen } = await api(
      () => json({ voices: ["af_bella", "am_adam", "narrator"] }),
      speech({ baseUrl: "http://localhost:8880/v1", needsKey: false, apiKey: undefined }),
    );
    const { body } = await list(t, { source: "library" });
    expect(seen[0].url.href).toBe("http://localhost:8880/v1/audio/voices");
    expect(body.voices).toEqual([
      { id: "af_bella", label: "af_bella", gender: "f" },
      { id: "am_adam", label: "am_adam", gender: "m" },
      { id: "narrator", label: "narrator", gender: "?" },
    ]);
  });

  test("a server with no list says so", async () => {
    const { api: t } = await api(
      () => json({ detail: "Not Found" }, 404),
      speech({ baseUrl: "http://localhost:8880/v1", needsKey: false }),
    );
    const { status, body } = await list(t, { source: "library" });
    expect(status).toBe(502);
    expect(body.error?.message).toBe(
      "Fish Audio has no voice list: GET http://localhost:8880/v1/audio/voices answered 404. " +
        "Add its voices by id instead.",
    );
  });
});
