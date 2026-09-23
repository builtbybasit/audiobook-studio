// The endpoints on the server, and what a line is sent through one.
//
// Until this route the endpoints were the browser's alone: the server had a table for them and
// nothing that wrote it, so a line went out with no tags and at whatever rate the model liked.
// The first half here is the configuration — saved whole, read back as saved, refused whole when a
// part of it could not be kept. The second is the narration job reading it: the tags a line
// carries written in as its endpoint spells them, a line whose tags that endpoint cannot say held
// back with the reason, and the sample rate asked for, heard in the file and recorded on the clip.
// A line longer than the endpoint's `maxChars` goes out as the parts the demo would cut it into,
// one request each, and comes back as one clip holding all of them.
import { describe, expect, test } from "bun:test";

import type {
  Book,
  Chapter,
  Character,
  Endpoint,
  ExportItem,
  ExpressionAnnotation,
  Profile,
  Segment,
} from "@/types";
import { credentials as registry, type Credential } from "@/lib/credentials";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { expressionParts, expressionPlan } from "@/lib/expressions";
import { makeEndpoints } from "@/mock/fixtures/endpoints";
import { makeProfiles } from "@/mock/fixtures/profiles";
import { fakeSpeechProvider, SAMPLE_RATE } from "~/providers/fakeSpeech";
import type { SpeechInput, SpeechProvider } from "~/providers/speech";
import { readWavHeader } from "~/providers/wavEncoder";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

interface Settings {
  endpoints: Endpoint[];
  profiles: Profile[];
  credentials: Credential[];
  saved: boolean;
}
interface Failure {
  error: { code: string; message: string; detail?: string };
}
interface ScriptResult {
  segments: Segment[];
  revision: number;
}

const TELEMETRY = { history: [], failures: 0, rateLimits: 0, backoffUntil: 0 };

/** A speech endpoint with one voice and nothing optional configured. */
const speech = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: "studio",
  name: "Studio speech",
  baseUrl: "http://localhost:8880/v1",
  model: "studio-tts",
  concurrency: 2,
  enabled: true,
  latency: 0,
  failRate: 0,
  price: 0,
  needsKey: false,
  maxChars: 0,
  splitAt: "sentence",
  voices: [{ id: "ash", gender: "m", label: "Ash" }],
  ...TELEMETRY,
  ...over,
});

const LAUGHS = { id: "laughs", label: "Laughs", token: "[laughs]", kind: "sound" } as const;

/** The same endpoint, configured to say `[laughs]`. */
const laughing = (over: Partial<Endpoint> = {}): Endpoint =>
  speech({
    expressions: {
      status: "supported",
      model: "studio-tts",
      baseUrl: "http://localhost:8880/v1",
      tags: [{ ...LAUGHS }],
    },
    ...over,
  });

const read = async (api: TestApi) => (await api.request<Settings>("/api/endpoints")).body;

const save = <T = Settings>(
  api: TestApi,
  config: { endpoints: unknown[]; profiles?: unknown[]; credentials?: unknown[] },
) =>
  api.request<T>("/api/endpoints", {
    ...jsonBody({ profiles: [], credentials: [], ...config }),
    method: "PUT",
  });

describe("the endpoints' configuration", () => {
  test("a server nobody has saved endpoints to says so, and has none", async () => {
    expect(await read(testApi())).toEqual({
      endpoints: [],
      profiles: [],
      credentials: [],
      saved: false,
    });
  });

  test("the seeded configuration is kept as it was sent, and read back without its telemetry", async () => {
    const api = testApi();
    const endpoints = makeEndpoints();
    const profiles = makeProfiles();
    // the seeded endpoints point at the seeded registry, which is saved with them
    const credentials = registry.map((c) => ({ ...c }));
    const { status, body } = await save(api, { endpoints, profiles, credentials });
    expect(status).toBe(200);
    expect(body.saved).toBe(true);
    expect(await read(api)).toEqual(body);

    expect(body.credentials).toEqual(credentials);
    expect(body.profiles).toEqual(profiles);
    expect(body.endpoints.map((e) => e.id)).toEqual(endpoints.map((e) => e.id));
    for (const [i, e] of endpoints.entries()) {
      const got = body.endpoints[i];
      const { history: _h, failures: _f, rateLimits: _r, backoffUntil: _b, ...config } = e;
      const { lastError: _e, fetching: _g, ...configured } = config;
      // Without the operational block a null credential or quota group reads back absent: a
      // column cannot tell "set to none" from "never set", and without the block both mean the
      // endpoint's own key slot and no shared pool.
      if (configured.timeoutSec == null)
        for (const k of ["spendLimit", "credentialId", "quotaGroup"] as const)
          if (configured[k] === null) delete configured[k];
      expect(got).toEqual({ ...configured, ...TELEMETRY });
      // what the session observed stays with the session
      expect(got).not.toHaveProperty("lastError");
    }
  });

  test("a save replaces the whole configuration, and removing every endpoint stays removed", async () => {
    const api = testApi();
    await save(api, { endpoints: [speech(), speech({ id: "other", name: "Other" })] });
    await save(api, { endpoints: [speech({ id: "other", name: "Other", voices: [] })] });
    let back = await read(api);
    expect(back.endpoints.map((e) => [e.id, e.voices.length])).toEqual([["other", 0]]);

    await save(api, { endpoints: [] });
    back = await read(api);
    expect(back).toEqual({ endpoints: [], profiles: [], credentials: [], saved: true });
  });

  test("a speech endpoint's sample rate is kept, and a scripting profile has none", async () => {
    const api = testApi();
    const [profile] = makeProfiles().filter((p) => p.credentialId == null);
    const { body } = await save(api, {
      endpoints: [speech({ sampleRate: 24000 }), speech({ id: "native", name: "Native" })],
      profiles: [{ ...profile, sampleRate: 48000 }],
    });
    expect(body.endpoints.map((e) => e.sampleRate)).toEqual([24000, undefined]);
    expect(body.profiles[0]).not.toHaveProperty("sampleRate");

    // null is the model's own rate, the same as never having set one
    await save(api, { endpoints: [speech({ sampleRate: null })] });
    expect((await read(api)).endpoints[0].sampleRate).toBeUndefined();
  });

  test("a rate outside 16–48 kHz is refused", async () => {
    const api = testApi();
    for (const sampleRate of [8000, 96000, 44000, "44100"]) {
      const { status, body } = await save<Failure>(api, {
        endpoints: [{ ...speech(), sampleRate }],
      });
      expect(status).toBe(400);
      expect(body.error.detail).toContain("sampleRate");
    }
    expect((await read(api)).saved).toBe(false);
  });

  test("what the tables could not keep is refused whole, and nothing is written", async () => {
    const api = testApi();
    await save(api, { endpoints: [speech()] });
    const before = await read(api);
    const refusals: [unknown, string][] = [
      [
        { endpoints: [speech(), speech({ name: "Again" })] },
        "Two speech endpoints are called “studio”",
      ],
      [
        { endpoints: [speech({ credentialId: "nobody" })] },
        "“Studio speech” uses a credential that is not in the list",
      ],
      [
        {
          endpoints: [
            speech({
              voices: [
                { id: "ash", gender: "m", label: "Ash" },
                { id: "ash", gender: "f", label: "Ash again" },
              ],
            }),
          ],
        },
        "“Studio speech” has two of one voice",
      ],
    ];
    for (const [config, message] of refusals) {
      const { status, body } = await save<Failure>(api, config as { endpoints: unknown[] });
      expect(status).toBe(400);
      expect(body.error.message).toBe(message);
    }
    expect(await read(api)).toEqual(before);
  });
});

// ---- a line sent through its endpoint ----

/** A provider that remembers every request it was sent, and renders it with the fake. */
function recording(): SpeechProvider & { sent: SpeechInput[] } {
  const inner = fakeSpeechProvider();
  const sent: SpeechInput[] = [];
  return { name: inner.name, sent, speak: (input) => (sent.push(input), inner.speak(input)) };
}

/** A two-chapter book, scripted, every speaker voiced by `studio/ash`. */
async function voiced(api: TestApi) {
  const { body } = await api.import<{ book: Book }>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: ["One", "Two"].map((title) => ({
        title,
        paragraphs: ["“We are short again,” said Mara.", ...story()],
      })),
    }),
  );
  const id = body.book.id;
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids: [1, 2] }));
  await api.runner.idle();
  const cast = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
  for (const c of cast.body.characters)
    await api.request(`/api/books/${id}/characters/${encodeURIComponent(c.name)}`, {
      ...jsonBody({ ...c, voice: "studio/ash" }),
      method: "PUT",
    });
  return id;
}

const narrate = async (api: TestApi, id: string, ids: number[]) => {
  await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids }));
  await api.runner.idle();
};

const scriptOf = async (api: TestApi, id: string, ch = 1) =>
  (await api.request<ScriptResult>(`/api/books/${id}/chapters/${ch}/script`)).body;

/** The rate a clip's file says it is, read from the file the route serves. */
async function rateOf(api: TestApi, url: string): Promise<number> {
  const res = await api.fetch(url);
  return readWavHeader(new Uint8Array(await res.arrayBuffer())).sampleRate;
}

/** A laugh placed before the first line of chapter 1, or before the line at `index`. */
async function laughFirst(api: TestApi, id: string, index = 0): Promise<Segment> {
  const { segments, revision } = await scriptOf(api, id);
  const laugh: ExpressionAnnotation = { ...LAUGHS, at: 0, annotationId: 1 };
  const edited = segments.map((s, i) => (i === index ? { ...s, expressions: [laugh] } : s));
  const { status } = await api.request(`/api/books/${id}/chapters/1/script`, {
    ...jsonBody({ segments: edited, ifRevision: revision }),
    method: "PUT",
  });
  expect(status).toBe(200);
  return edited[index];
}

describe("a line sent through its endpoint", () => {
  test("is asked for the endpoint's sample rate, and its clip records the rate the file is at", async () => {
    const provider = recording();
    const api = testApi({ speech: provider });
    await save(api, { endpoints: [speech({ sampleRate: 24000 })] });
    const id = await voiced(api);
    await narrate(api, id, [1]);

    expect(provider.sent.length).toBeGreaterThan(0);
    expect(new Set(provider.sent.map((s) => s.sampleRate))).toEqual(new Set([24000]));
    const { segments } = await scriptOf(api, id);
    for (const s of segments) {
      expect(s.audio).toMatchObject({ status: "done", sampleRate: 24000 });
      expect(await rateOf(api, s.audio.url!)).toBe(24000);
    }
  });

  test("with no rate set, the request names none and the clip records the model's own", async () => {
    const provider = recording();
    const api = testApi({ speech: provider });
    await save(api, { endpoints: [speech()] });
    const id = await voiced(api);
    await narrate(api, id, [1]);

    expect(provider.sent.every((s) => s.sampleRate === null)).toBe(true);
    const { segments } = await scriptOf(api, id);
    expect(segments.every((s) => s.audio.sampleRate === SAMPLE_RATE)).toBe(true);
  });

  test("a voice whose endpoint the server does not know is still sent, at the model's rate", async () => {
    const provider = recording();
    const api = testApi({ speech: provider });
    const id = await voiced(api);
    await narrate(api, id, [1]);
    const { segments } = await scriptOf(api, id);
    expect(segments.every((s) => s.audio.status === "done")).toBe(true);
    expect(provider.sent.every((s) => s.sampleRate === null)).toBe(true);
  });

  test("carries its expression tags as the endpoint spells them, and records what it was sent", async () => {
    const provider = recording();
    const api = testApi({ speech: provider });
    const endpoint = laughing();
    await save(api, { endpoints: [endpoint] });
    const id = await voiced(api);
    const line = await laughFirst(api, id);
    await narrate(api, id, [1]);

    const plan = expressionPlan(line, endpoint);
    expect(plan.issues).toEqual([]);
    expect(provider.sent[0].text).toBe(`[laughs] ${line.text}`);
    const { segments } = await scriptOf(api, id);
    expect(segments[0].audio).toMatchObject({
      status: "done",
      text: line.text,
      said: `[laughs] ${line.text}`,
      pronounced: line.text,
      expressions: ["[laughs]"],
      expressionSignature: plan.signature,
    });
    // a line without tags records none, and is sent as written
    expect(segments[1].audio.expressionSignature).toBeUndefined();
    expect(provider.sent[1].text).toBe(segments[1].text);
  });

  test("a line whose tags its endpoint cannot say is held back with the reason, and the rest are sent", async () => {
    const provider = recording();
    const api = testApi({ speech: provider });
    const endpoint = laughing();
    await save(api, {
      endpoints: [
        { ...endpoint, expressions: { ...endpoint.expressions!, status: "unsupported" } },
      ],
    });
    const id = await voiced(api);
    const line = await laughFirst(api, id);
    await narrate(api, id, [1]);

    expect(provider.sent.map((s) => s.text)).not.toContain(line.text);
    const { segments } = await scriptOf(api, id);
    expect(segments[0].audio.status).toBe("failed");
    expect(segments[0].audio.error?.message).toBe(
      "Expression needs attention: This model is configured without expression support.",
    );
    expect(segments.slice(1).every((s) => s.audio.status === "done")).toBe(true);
  });

  test("an audiobook file will not hold two rates, and says which chapter brought the second", async () => {
    const api = testApi();
    await save(api, { endpoints: [speech({ sampleRate: 16000 })] });
    const id = await voiced(api);
    await narrate(api, id, [1]);
    await save(api, { endpoints: [speech({ sampleRate: 48000 })] });
    await narrate(api, id, [2]);

    const settings = { ...DEFAULT_EXPORT_SETTINGS, title: "Moonlight Ledger", filename: "Ledger" };
    await api.request(`/api/books/${id}/exports`, jsonBody({ ids: [1, 2], settings }));
    await api.runner.idle();
    const { body } = await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`);
    expect(body.exports[0].status).toBe("failed");
    const chapters = (await api.request<{ chapters: Chapter[] }>(`/api/books/${id}`)).body.chapters;
    // named by chapter, in the build's own words, rather than by the path of a clip file
    const failed = api.logs.find((l) => l.msg === "job failed" && l.err)!;
    expect((failed.err as { message: string }).message).toMatch(
      new RegExp(
        `^“${chapters[1].title}” has a line rendered at 48 kHz, and Ledger\\.\\w+ already holds 16 kHz audio from “${chapters[0].title}”`,
      ),
    );
  });
});

// ---- a line longer than its endpoint takes ----

/** What a book's lines will be sent as through `endpoint`, one entry per request. */
const partsOf = (segments: Segment[], endpoint: Endpoint) =>
  segments.map((s) => expressionParts(expressionPlan(s, endpoint), endpoint));

/** How long a clip's file plays, from the samples it holds. */
async function secondsOf(api: TestApi, url: string): Promise<number> {
  const bytes = new Uint8Array(await (await api.fetch(url)).arrayBuffer());
  const { length, sampleRate, channels, bits } = readWavHeader(bytes);
  return length / (sampleRate * channels * (bits / 8));
}

describe("a line longer than its endpoint's maxChars", () => {
  test("is sent in the parts the splitter cuts, and comes back as one clip that says so", async () => {
    const provider = recording();
    const api = testApi({ speech: provider });
    const endpoint = speech({ maxChars: 60, splitAt: "sentence" });
    await save(api, { endpoints: [endpoint] });
    const id = await voiced(api);
    const before = (await scriptOf(api, id)).segments;
    const expected = partsOf(before, endpoint);
    await narrate(api, id, [1]);

    // every part its own request, in reading order, without the whitespace a cut keeps
    expect(provider.sent.map((s) => s.text)).toEqual(expected.flat().map((p) => p.text.trim()));
    expect(provider.sent.every((s) => s.text.length <= 60)).toBe(true);

    const { segments } = await scriptOf(api, id);
    const split = segments.filter((_, i) => expected[i].length > 1);
    expect(split.length).toBeGreaterThan(0);
    for (const s of segments) {
      const cuts = expected[segments.indexOf(s)];
      expect(s.audio).toMatchObject({ status: "done", parts: cuts.length, splitAt: "sentence" });
      expect(s.audio.cuts).toEqual(
        cuts.length > 1
          ? cuts.map((c) => ({ from: c.from, to: c.to, at: c.at, fallback: c.fallback }))
          : undefined,
      );
      // one file, every part's audio in it: what it plays for is what the clip says it lasts
      expect(await secondsOf(api, s.audio.url!)).toBeCloseTo(s.audio.duration, 2);
    }
    // a line with no sentence end inside the limit is cut at a clause, and says it fell back
    expect(split.some((s) => s.audio.cuts!.some((c) => c.at === "clause" && c.fallback))).toBe(
      true,
    );
  });

  test("keeps a tag whole, in one part", async () => {
    const provider = recording();
    const api = testApi({ speech: provider });
    const endpoint = laughing({ maxChars: 20, splitAt: "word" });
    await save(api, { endpoints: [endpoint] });
    const id = await voiced(api);
    // the chapter's heading is a word; the laugh goes before a line long enough to be cut
    const index = (await scriptOf(api, id)).segments.findIndex((s) => s.text.length > 40);
    await laughFirst(api, id, index);
    await narrate(api, id, [1]);

    // the line is cut, and the laugh travels in exactly one of its parts, unbroken
    const first = (await scriptOf(api, id)).segments[index].audio;
    expect(first.status).toBe("done");
    expect(first.parts).toBeGreaterThan(1);
    const tagged = provider.sent.filter((s) => s.text.includes("["));
    expect(tagged.length).toBe(1);
    expect(tagged[0].text).toContain("[laughs]");
    expect(tagged[0].text.length).toBeLessThanOrEqual(20);
  });

  test("a part that fails fails the line, and says which part it was", async () => {
    const endpoint = speech({ maxChars: 60, splitAt: "sentence" });
    const inner = recording();
    let second = "";
    const provider: SpeechProvider = {
      name: inner.name,
      speak: (input) =>
        input.text === second
          ? Promise.reject(new Error("The endpoint answered 500"))
          : inner.speak(input),
    };
    const api = testApi({ speech: provider });
    await save(api, { endpoints: [endpoint] });
    const id = await voiced(api);
    const before = (await scriptOf(api, id)).segments;
    const at = partsOf(before, endpoint).findIndex((p) => p.length > 1);
    second = partsOf(before, endpoint)[at][1].text.trim();
    await narrate(api, id, [1]);

    const { segments } = await scriptOf(api, id);
    expect(segments[at].audio).toMatchObject({ status: "failed", parts: expect.any(Number) });
    expect(segments[at].audio.error).toMatchObject({
      message: "The endpoint answered 500",
      part: 2,
    });
    expect(segments[at].audio.url).toBeUndefined();
  });

  test("a line within the limit, or an endpoint with none, is one request as before", async () => {
    const provider = recording();
    const api = testApi({ speech: provider });
    await save(api, { endpoints: [speech({ maxChars: 0 })] });
    const id = await voiced(api);
    await narrate(api, id, [1]);
    const { segments } = await scriptOf(api, id);
    expect(provider.sent.map((s) => s.text)).toEqual(segments.map((s) => s.text));
    for (const s of segments) {
      expect(s.audio).toMatchObject({ parts: 1, splitAt: "sentence" });
      expect(s.audio.cuts).toBeUndefined();
    }
  });
});
