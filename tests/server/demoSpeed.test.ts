// How fast the demo's simulated work runs, and what it sets going on its own (`server/demo/pace.ts`).
//
// The Demo drawer sets one speed for the demo library, and every simulated wait there — a line on
// a simulated endpoint, a chunk on a simulated profile, a chapter of a build — is divided by it. The
// real library is never paced, whatever the demo is set to. The libraries are the ones the server
// boots, over private databases; their providers' `fetch` fails the test. The tests that only set
// the speed and time a request share one demo, put back to 1× after each; the world it holds is
// none of their business.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { Job } from "@/types";
import { SIMULATED_BASE_URL } from "@/lib/providers";
import { newPace, pacedEncoders } from "~/demo/pace";
import { DEMO_BASE, openLibrary, REAL_BASE, type Library } from "~/libraries";
import type { AudiobookEncoder, EncodeInput } from "~/providers/encoder";
import { endpointScriptingProvider } from "~/providers/endpointScripting";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import type { ScriptTarget } from "~/providers/scripting";
import { ffmpegEncoders } from "~/providers/ffmpegEncoder";
import {
  collectingLogger,
  jsonBody,
  tempAudioDir,
  tempExportDir,
  tempVoiceDir,
} from "../support/server";

const noNetwork = (async (url: string) => {
  throw new Error(`a library made a request: ${String(url)}`);
}) as unknown as typeof globalThis.fetch;

const opened: Library[] = [];
afterEach(async () => {
  // a library left running would go on narrating into the next test's time
  await Promise.all(opened.splice(0).map((l) => l.runner.stop()));
});

/** A library of the test's own, stopped when the test is done. */
async function open(demo: boolean, { still = true } = {}): Promise<Library> {
  const library = await started(demo, still);
  opened.push(library);
  return library;
}

async function started(demo: boolean, still = true): Promise<Library> {
  const library = openLibrary({
    name: demo ? "demo" : "real",
    base: demo ? DEMO_BASE : REAL_BASE,
    databaseUrl: ":memory:",
    audioDir: tempAudioDir(),
    exportDir: tempExportDir(),
    voiceDir: tempVoiceDir(),
    encoders: ffmpegEncoders(),
    log: collectingLogger().log,
    providers: {
      scripting: endpointScriptingProvider({ fetch: noNetwork, random: () => 1 }),
      speech: endpointSpeechProvider({ fetch: noNetwork, random: () => 1 }),
    },
    demo,
    still,
  });
  await library.start();
  return library;
}

const request = async <T>(library: Library, path: string, init?: RequestInit) => {
  const res = await library.app.request(`http://api.test${library.base}${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
};

const setSpeed = (library: Library, speed: unknown) =>
  request<{ speed: number }>(library, "/demo/speed", { ...jsonBody({ speed }), method: "PUT" });

/** A simulated endpoint or profile that takes `latencyMs` to answer and never fails. */
const simulated = (latencyMs: number): ScriptTarget => ({
  id: "simulated",
  name: "Simulated",
  baseUrl: SIMULATED_BASE_URL,
  model: "simulated",
  apiKey: null,
  needsKey: false,
  timeoutSec: 30,
  maxRetries: 0,
  cooldownSec: 0,
  maxOutputTokens: 0,
  simulation: { latencyMs, failRate: 0 },
});

/** How long it takes `library` to say one line and script one paragraph on a simulated target. */
async function timed(library: Library, latencyMs: number): Promise<[number, number]> {
  const signal = new AbortController().signal;
  let started = performance.now();
  await library.providers.speech.speak({
    text: "Come in.",
    speaker: "Mara",
    type: "dialogue",
    direction: "",
    instructions: "",
    voiceRef: "simulated/ash",
    sampleRate: null,
    encoding: { format: "wav" },
    target: simulated(latencyMs),
    signal,
  });
  const line = performance.now() - started;
  started = performance.now();
  await library.providers.scripting.script({
    title: "One",
    text: "“Come in,” said Mara.",
    signal,
    target: simulated(latencyMs),
    cast: [],
  });
  return [line, performance.now() - started];
}

describe("the demo's speed", () => {
  test("starts at 1× and takes only the speeds the drawer offers", async () => {
    const demo = await open(true);
    expect((await request<{ speed: number }>(demo, "/demo/speed")).body.speed).toBe(1);
    expect(await setSpeed(demo, 16)).toEqual({ status: 200, body: { speed: 16 } });
    for (const refused of [3, 0, -4, "16", null])
      expect((await setSpeed(demo, refused)).status).toBe(400);
    expect((await request<{ speed: number }>(demo, "/demo/speed")).body.speed).toBe(16);
  });

  test("divides the wait for each chapter of a build, told in order", async () => {
    const pace = newPace();
    const told: number[] = [];
    const inner: AudiobookEncoder = {
      ...ffmpegEncoders().for({} as never),
      async encode(input: EncodeInput) {
        input.chapters.forEach((c, i) =>
          input.onChapter?.({ id: c.id, start: 0, length: 0, seconds: 1 }, i),
        );
        return { bytes: 1, seconds: 3, chapters: [] };
      },
    };
    const paced = pacedEncoders({ name: "inner", for: () => inner }, pace, 200).for({} as never);
    const build = async () => {
      const started = performance.now();
      await paced.encode({
        chapters: [1, 2, 3].map((id) => ({ id, title: `${id}`, parts: [] })),
        gap: 0,
        out: "",
        signal: new AbortController().signal,
        onChapter: (c) => void told.push(c.id),
      });
      return performance.now() - started;
    };
    const slow = await build();
    expect(slow).toBeGreaterThanOrEqual(585);
    expect(told).toEqual([1, 2, 3]);
    pace.speed = 10;
    const quick = await build();
    expect(quick).toBeGreaterThanOrEqual(55);
    // against the same build at 1x rather than a fixed figure: a machine busy enough to fire timers
    // late fires both builds' late, and a speed that was not applied would take as long as the first
    expect(quick).toBeLessThan(slow / 2);
  });
});

describe("the demo's speed, once set", () => {
  let demo: Library;
  beforeAll(async () => {
    demo = await started(true);
  });
  afterEach(async () => {
    expect((await setSpeed(demo, 1)).status).toBe(200);
  });
  afterAll(() => demo.runner.stop());

  test("divides a simulated line's wait and a simulated chunk's", async () => {
    const [line, chunk] = await timed(demo, 320);
    expect(line).toBeGreaterThanOrEqual(300);
    expect(chunk).toBeGreaterThanOrEqual(300);
    await setSpeed(demo, 16);
    const [quickLine, quickChunk] = await timed(demo, 320);
    // against the same request at 1x, which a loaded machine slows as much
    expect(quickLine).toBeLessThan(line / 2);
    expect(quickChunk).toBeLessThan(chunk / 2);
  });

  test("is the demo's alone: the real library has no such route and is never paced", async () => {
    const real = await open(false);
    await setSpeed(demo, 16);
    expect((await request(real, "/demo/speed")).status).toBe(404);
    expect((await setSpeed(real, 16)).status).toBe(404);
    const [line, chunk] = await timed(real, 200);
    expect(line).toBeGreaterThanOrEqual(190);
    expect(chunk).toBeGreaterThanOrEqual(190);
  });

  test("outlasts a reset and a situation, being the tester's rather than the world's", async () => {
    await setSpeed(demo, 4);
    await request(demo, "/demo/reset", { method: "POST" });
    await request(demo, "/demo/situations/fresh-book", { method: "POST" });
    expect((await request<{ speed: number }>(demo, "/demo/speed")).body.speed).toBe(4);
  });
});

describe("the demo's startup runs", () => {
  /** The runs the demo's queue holds that have not finished, as `kind book:chapter`. */
  const live = async (library: Library) =>
    (await request<{ jobs: Job[] }>(library, "/jobs")).body.jobs
      .filter((j) => j.status === "queued" || j.status === "running")
      .map((j) => `${j.kind} ${j.bookId}:${j.chapterId}`)
      .sort();

  const STARTUP = [
    "narration cliche:5",
    "narration cliche:6",
    "scripting drowned:3",
    "scripting drowned:4",
    "scripting drowned:5",
  ];

  test("are set going on the first seed and on a reset, and not on a situation", async () => {
    const demo = await open(true, { still: false });
    expect(await live(demo)).toEqual(STARTUP);
    await request(demo, "/demo/situations/fresh-book", { method: "POST" });
    expect(await live(demo)).toEqual([]);
    await request(demo, "/demo/reset", { method: "POST" });
    expect(await live(demo)).toEqual(STARTUP);
  });
});
