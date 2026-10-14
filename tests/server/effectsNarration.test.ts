// Voice effects as narration applies them, and the two editor routes that run them. A line with
// effects lands as two files (the raw voice, and the processed clip it plays) and records its
// chains' fingerprint as its sound. Without Pedalboard, a thought line gets the ffmpeg thought
// effect and the other effects are left off, said once.
import { describe, expect, test } from "bun:test";

import type { Cast, ChapterScript, Effect, Endpoint, Job, Segment, Step } from "@/types";
import { runnable, soundOf } from "@/lib/effects";
import type { ThoughtEffect } from "~/audio/thoughtEffect";
import { INNER_VOICE } from "~/db/effects";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import type { SpeechProvider } from "~/providers/speech";
import { fakeEffectRunner, PARSED, type FakeEffectRunner } from "../support/effects";
import { story } from "../support/epub";
import {
  jsonBody,
  speechEndpoint,
  testApi,
  voicedBook,
  type TestApi,
  type TestApiOptions,
} from "../support/server";

const endpoint = (over: Partial<Endpoint> = {}): Endpoint =>
  speechEndpoint({ id: "a", concurrency: 1, ...over });

const ECHO: Step[] = [{ plugin: "Delay", params: { delay_seconds: 0.2, mix: 0.3 }, on: true }];
const PHONE: Step[] = [
  { plugin: "HighpassFilter", params: { cutoff_frequency_hz: 400 }, on: true },
];

/** A stand-in ffmpeg thought effect: the bytes back unchanged, its calls counted. */
function stubThought(): { effect: ThoughtEffect; calls: number[] } {
  const calls: number[] = [];
  return { effect: async (bytes) => (calls.push(bytes.length), bytes), calls };
}

/**
 * A scripted one-chapter book, its first spoken line made a thought by hand; the id, and who
 * thinks it. `echo` gives that speaker an effect of their own, `phone` the thought a line effect.
 */
async function bookWithAThought(
  api: TestApi,
  { echo = false, plain = false, phone = false } = {},
): Promise<{ id: string; who: string }> {
  const id = await voicedBook(api, {
    endpoints: [endpoint()],
    paragraphs: [
      "“We are short again,” said Mara.",
      "“Again?” said Mara.",
      "“Always,” said Tom.",
      ...story(2),
    ],
    voiceOf: () => "a/ash",
  });
  const script = (await api.request<ChapterScript>(`/api/books/${id}/chapters/1/script`)).body;
  const first = script.segments.findIndex((s) => s.type === "dialogue");
  const who = script.segments[first].speaker;
  if (phone) await api.request("/api/effects", jsonBody({ name: "Phone", chain: PHONE }));
  const segments = script.segments.map((s, i) =>
    i === first ? { ...s, type: "thought" as const, ...(phone ? { effects: ["phone"] } : {}) } : s,
  );
  await api.request(`/api/books/${id}/chapters/1/script`, {
    ...jsonBody({ segments, ifRevision: script.revision }),
    method: "PUT",
  });
  if (echo) {
    await api.request("/api/effects", jsonBody({ name: "Echo", chain: ECHO }));
    const cast = (await api.request<Cast>(`/api/books/${id}/cast`)).body.characters;
    const c = cast.find((c) => c.name === who)!;
    await api.request(`/api/books/${id}/characters/${encodeURIComponent(who)}`, {
      ...jsonBody({ ...c, effect: "echo" }),
      method: "PUT",
    });
  }
  if (plain)
    await api.request(`/api/books/${id}`, { ...jsonBody({ thoughts: "none" }), method: "PATCH" });
  return { id, who };
}

async function narrate(api: TestApi, id: string): Promise<{ job: Job; lines: Segment[] }> {
  const { jobs } = (
    await api.request<{ jobs: Job[] }>(`/api/books/${id}/chapters/narrate`, jsonBody({ ids: [1] }))
  ).body;
  await api.runner.idle();
  const job = (await api.request<{ job: Job }>(`/api/jobs/${jobs[0].id}`)).body.job;
  const lines = (await api.request<ChapterScript>(`/api/books/${id}/chapters/1/script`)).body
    .segments;
  return { job, lines };
}

/** The bytes a clip's url is served as. */
async function served(api: TestApi, url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await api.fetch(url);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

const withRunner = (over: TestApiOptions = {}): { api: TestApi; fx: FakeEffectRunner } => {
  const fx = fakeEffectRunner();
  return { api: testApi({ effects: fx, ...over }), fx };
};

const spoken = (lines: Segment[]) => lines.filter((s) => s.audio.status === "done");

describe("narration with Pedalboard", () => {
  test("a thought line lands as its raw and the clip its thought effect made, and says which", async () => {
    const { api, fx } = withRunner();
    const { id } = await bookWithAThought(api);
    const { job, lines } = await narrate(api, id);

    expect(job.status).toBe("done");
    const thought = lines.find((s) => s.type === "thought")!;
    expect(thought.audio).toMatchObject({ status: "done", sound: soundOf([INNER_VOICE]) });
    expect(thought.audio.url).toEndWith(".wav");
    expect(thought.audio.raw).toBeString();
    expect(thought.audio.raw).not.toBe(thought.audio.url);
    // both files are there, the processed one made from the raw
    expect(await served(api, thought.audio.url!)).toEqual(await served(api, thought.audio.raw!));
    expect(fx.calls.render).toEqual([{ format: "wav", chains: [runnable(INNER_VOICE.chain)] }]);
    // no other line is touched, nor keeps a second file
    for (const s of spoken(lines).filter((s) => s !== thought)) {
      expect(s.audio.sound).toBeUndefined();
      expect(s.audio.raw).toBeUndefined();
    }
  });

  test("a speaker's own effect goes on every line of theirs, before the thought effect", async () => {
    const { api, fx } = withRunner();
    const { id, who } = await bookWithAThought(api, { echo: true });
    const { job, lines } = await narrate(api, id);
    const echo: Effect = { id: "echo", name: "Echo", chain: ECHO };

    expect(job.status).toBe("done");
    const theirs = spoken(lines).filter((s) => s.speaker === who);
    expect(theirs.length).toBeGreaterThan(1);
    for (const s of theirs) {
      const want = s.type === "thought" ? [echo, INNER_VOICE] : [echo];
      expect(s.audio).toMatchObject({ sound: soundOf(want), raw: expect.any(String) });
    }
    expect(fx.calls.render.map((c) => c.chains.length).sort((a, b) => a - b)).toEqual(
      theirs.map((s) => (s.type === "thought" ? 2 : 1)).sort((a, b) => a - b),
    );
    for (const s of spoken(lines).filter((s) => s.speaker !== who))
      expect(s.audio.raw).toBeUndefined();
  });

  test("a line's own effect runs after the speaker's and before the thought effect", async () => {
    const { api, fx } = withRunner();
    const { id } = await bookWithAThought(api, { echo: true, phone: true });
    const { lines } = await narrate(api, id);
    const echo: Effect = { id: "echo", name: "Echo", chain: ECHO };
    const phone: Effect = { id: "phone", name: "Phone", chain: PHONE };

    const thought = lines.find((s) => s.type === "thought")!;
    expect(thought.effects).toEqual(["phone"]);
    expect(thought.audio).toMatchObject({ sound: soundOf([echo, phone, INNER_VOICE]) });
    expect(fx.calls.render).toContainEqual({
      format: "wav",
      chains: [ECHO, PHONE, INNER_VOICE.chain],
    });
  });

  test("a book whose thoughts are plain runs nothing, and keeps one file a line", async () => {
    const { api, fx } = withRunner();
    const { id } = await bookWithAThought(api, { plain: true });
    const { lines } = await narrate(api, id);

    expect(fx.calls.render).toHaveLength(0);
    const thought = lines.find((s) => s.type === "thought")!;
    expect(thought.audio.status).toBe("done");
    expect(thought.audio).not.toHaveProperty("sound");
    expect(thought.audio).not.toHaveProperty("raw");
  });

  test("effects that fail leave the voice's own clip, and the log says which line", async () => {
    const { api, fx } = withRunner();
    fx.fail = new Error("Pedalboard fell over");
    const { id } = await bookWithAThought(api);
    const { job, lines } = await narrate(api, id);

    expect(job.status).toBe("done");
    const thought = lines.find((s) => s.type === "thought")!;
    expect(thought.audio.status).toBe("done");
    expect(thought.audio.url).toBeString();
    expect(thought.audio).not.toHaveProperty("sound");
    expect(thought.audio).not.toHaveProperty("raw");
    const warned = job.activity?.find((e) => e.message.includes("voice effects were not applied"));
    expect(warned?.message).toContain(`Line ${thought.id}`);
    expect(warned?.message).toContain("Pedalboard fell over");
  });

  test("the endpoint's slot is given back before effects run, so the next line is already out", async () => {
    const inner = fakeSpeechProvider({ delayMs: 5 });
    const starts: number[] = [];
    const speech: SpeechProvider = {
      name: inner.name,
      speak: (input) => (starts.push(Date.now()), inner.speak(input)),
    };
    const fx = fakeEffectRunner();
    const runs: { at: number; done: number }[] = [];
    const slow: FakeEffectRunner = {
      ...fx,
      render: async (...args) => {
        const at = Date.now();
        await Bun.sleep(300);
        const out = await fx.render(...args);
        runs.push({ at, done: Date.now() });
        return out;
      },
    };
    const api = testApi({ speech, effects: slow });
    const { id } = await bookWithAThought(api);
    await narrate(api, id);

    // at a concurrency of one, a line sent while the thought was being processed is a line the
    // slot was free for
    const [{ at, done }] = runs;
    expect(starts.some((s) => s > at && s < done)).toBe(true);
  });
});

describe("narration where Pedalboard cannot run", () => {
  test("a thought line gets the ffmpeg effect and keeps its raw; a speaker's own is left off, said once", async () => {
    const { effect, calls } = stubThought();
    const { api, fx } = withRunner({ thoughtEffect: effect });
    fx.ready = false;
    const { id, who } = await bookWithAThought(api, { echo: true });
    const { job, lines } = await narrate(api, id);

    expect(job.status).toBe("done");
    expect(fx.calls.render).toHaveLength(0);
    expect(calls).toHaveLength(1);
    const thought = lines.find((s) => s.type === "thought")!;
    expect(thought.audio).toMatchObject({ sound: "ffmpeg", raw: expect.any(String) });
    const theirs = spoken(lines).filter((s) => s.speaker === who && s !== thought);
    expect(theirs.length).toBeGreaterThan(0);
    for (const s of theirs) expect(s.audio).not.toHaveProperty("sound");
    const told = job.activity?.filter((e) => e.message.includes("cannot run here")) ?? [];
    expect(told).toHaveLength(1);
    expect(told[0].level).toBe("warning");
  });

  test("a line's own effect is left off too, and the thought still gets the ffmpeg effect", async () => {
    const { effect, calls } = stubThought();
    const { api, fx } = withRunner({ thoughtEffect: effect });
    fx.ready = false;
    const { id } = await bookWithAThought(api, { phone: true });
    const { job, lines } = await narrate(api, id);

    expect(calls).toHaveLength(1);
    expect(lines.find((s) => s.type === "thought")!.audio.sound).toBe("ffmpeg");
    expect(job.activity?.filter((e) => e.message.includes("cannot run here"))).toHaveLength(1);
  });

  test("with no runner at all, the same", async () => {
    const { effect } = stubThought();
    const api = testApi({ thoughtEffect: effect });
    const { id } = await bookWithAThought(api);
    const { job, lines } = await narrate(api, id);

    expect(lines.find((s) => s.type === "thought")!.audio.sound).toBe("ffmpeg");
    // nothing of the speakers' own was there to leave off
    expect(job.activity?.some((e) => e.message.includes("cannot run here"))).toBe(false);
  });
});

describe("POST /api/effects/preview", () => {
  const preview = (api: TestApi, body: unknown) =>
    api.fetch("/api/effects/preview", jsonBody(body));

  test("plays a clip of the library through chains, as a WAV", async () => {
    const { api, fx } = withRunner();
    const { id } = await bookWithAThought(api, { plain: true });
    const { lines } = await narrate(api, id);
    const url = spoken(lines)[0].audio.url!;

    const res = await preview(api, { url, chains: [ECHO, []] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(await served(api, url));
    expect(fx.calls.render.at(-1)).toEqual({ format: "wav", chains: [ECHO, []] });
  });

  test("anything that is not a clip of this library is no such file", async () => {
    const { api, fx } = withRunner();
    const { id } = await bookWithAThought(api, { plain: true });
    const { lines } = await narrate(api, id);
    const url = spoken(lines)[0].audio.url!;
    const file = url.split("/").at(-1)!;

    for (const bad of [
      `/api/audio/${id}/../../../etc/passwd`,
      `/api/audio/${id}/${file}/x`,
      `/api/audio/${id}/missing.wav`,
      `/api/audio/${id}/${file.replace(".wav", ".txt")}`,
      `/demo/api/audio/${id}/${file}`,
      `/etc/passwd`,
      file,
    ])
      expect((await preview(api, { url: bad, chains: [] })).status).toBe(404);
    expect(fx.calls.render).toHaveLength(0);
  });

  test("a chain the editor could not have made is refused before anything runs", async () => {
    const { api, fx } = withRunner();
    const res = await preview(api, {
      url: "/api/audio/x/y.wav",
      chains: [[{ plugin: "os.system", params: {}, on: true }]],
    });
    expect(res.status).toBe(400);
    expect(fx.calls.render).toHaveLength(0);
  });

  test("a chain the runner refuses is a 400 with its reason", async () => {
    const { api, fx } = withRunner();
    const { id } = await bookWithAThought(api, { plain: true });
    const { lines } = await narrate(api, id);
    fx.fail = new Error("Delay has no wobble");
    const res = await preview(api, { url: spoken(lines)[0].audio.url!, chains: [ECHO] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "Delay has no wobble",
    );
  });

  test("is a 503 that says why where the runner cannot run", async () => {
    const { api, fx } = withRunner();
    fx.ready = false;
    for (const app of [api, testApi()]) {
      const res = await preview(app, { url: "/api/audio/x/y.wav", chains: [] });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("unavailable");
      expect(body.error.message).toContain("uv");
    }
  });
});

describe("POST /api/effects/parse", () => {
  const parse = (api: TestApi, code: string) =>
    api.request<{ chain?: Step[]; error?: { message: string } }>(
      "/api/effects/parse",
      jsonBody({ code }),
    );

  test("reads code into a chain", async () => {
    const { api, fx } = withRunner();
    const code = "Pedalboard([Gain(0)])";
    expect(await parse(api, code)).toEqual({ status: 200, body: { chain: PARSED } });
    expect(fx.calls.parse).toEqual([code]);
  });

  test("code it cannot read is a 400 with the parser's reason", async () => {
    const { api, fx } = withRunner();
    fx.fail = new Error("line 1: invalid syntax");
    const { status, body } = await parse(api, "Pedalboard([");
    expect(status).toBe(400);
    expect(body.error?.message).toBe("line 1: invalid syntax");
  });

  test("code past the cap is refused unread", async () => {
    const { api, fx } = withRunner();
    expect((await parse(api, "#".repeat(64 * 1024 + 1))).status).toBe(400);
    expect(fx.calls.parse).toHaveLength(0);
  });

  test("is a 503 where the runner cannot run", async () => {
    const { api, fx } = withRunner();
    fx.ready = false;
    expect((await parse(api, "Gain(0)")).status).toBe(503);
    expect((await parse(testApi(), "Gain(0)")).status).toBe(503);
  });
});
