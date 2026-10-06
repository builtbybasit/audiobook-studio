// The thought effect as narration applies it: a `thought` line's clip is given it as it lands and
// says so, every other line is left alone, a book can switch it off, an effect that fails keeps the
// clip the voice made, and the endpoint's slot is given back before the effect runs — so a thought
// line never holds up the line after it. Then the real thing, where this machine has an ffmpeg.
//
// The speech is the tone-rendering fake; the effect is a stand-in that counts what it was given,
// except in the last block.
import { describe, expect, test } from "bun:test";

import type { Book, ChapterScript, Endpoint, Job, Segment } from "@/types";
import { probeClip } from "~/audio/probe";
import { ffmpegThoughtEffect, type ThoughtEffect } from "~/audio/thoughtEffect";
import { fakeSpeechProvider } from "~/providers/fakeSpeech";
import { ffmpegAvailable } from "~/providers/ffmpegEncoder";
import type { SpeechProvider } from "~/providers/speech";
import { story } from "../support/epub";
import { jsonBody, speechEndpoint, testApi, voicedBook, type TestApi } from "../support/server";

const endpoint = (over: Partial<Endpoint> = {}): Endpoint =>
  speechEndpoint({ id: "a", concurrency: 1, ...over });

/** A stand-in effect: what it was given, and the bytes back unchanged after `delayMs`. */
function stubEffect(delayMs = 0, fail?: Error) {
  const calls: { text: number; at: number; done?: number }[] = [];
  const effect: ThoughtEffect = async (bytes) => {
    const call = { text: bytes.length, at: Date.now() } as (typeof calls)[number];
    calls.push(call);
    if (delayMs) await Bun.sleep(delayMs);
    call.done = Date.now();
    if (fail) throw fail;
    return bytes;
  };
  return { effect, calls };
}

/** A scripted one-chapter book, its first spoken line made a thought by hand. */
async function bookWithAThought(api: TestApi, plain = false): Promise<string> {
  const id = await voicedBook(api, {
    endpoints: [endpoint()],
    paragraphs: ["“We are short again,” said Mara.", ...story(2)],
    voiceOf: () => "a/ash",
  });
  const script = (await api.request<ChapterScript>(`/api/books/${id}/chapters/1/script`)).body;
  const first = script.segments.findIndex((s) => s.type === "dialogue");
  const segments = script.segments.map((s, i) =>
    i === first ? { ...s, type: "thought" as const } : s,
  );
  await api.request(`/api/books/${id}/chapters/1/script`, {
    ...jsonBody({ segments, ifRevision: script.revision }),
    method: "PUT",
  });
  if (plain)
    await api.request(`/api/books/${id}`, {
      ...jsonBody({ plainThoughts: true }),
      method: "PATCH",
    });
  return id;
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

describe("the book's switch", () => {
  test("is on until switched off, and off is the only thing kept", async () => {
    const api = testApi();
    const id = await bookWithAThought(api);
    const patch = async (plainThoughts: boolean | null) =>
      (
        await api.request<{ book: Book }>(`/api/books/${id}`, {
          ...jsonBody({ plainThoughts }),
          method: "PATCH",
        })
      ).body.book;
    const read = async () => (await api.request<{ book: Book }>(`/api/books/${id}`)).body.book;

    expect(await read()).not.toHaveProperty("plainThoughts");
    expect((await patch(true)).plainThoughts).toBe(true);
    expect((await read()).plainThoughts).toBe(true);
    expect(await patch(false)).not.toHaveProperty("plainThoughts");
    await patch(true);
    expect(await patch(null)).not.toHaveProperty("plainThoughts");
  });
});

describe("the thought effect in narration", () => {
  test("a thought line is given it as it lands and says so; no other line is", async () => {
    const { effect, calls } = stubEffect();
    const api = testApi({ thoughtEffect: effect });
    const id = await bookWithAThought(api);
    const { job, lines } = await narrate(api, id);

    expect(job.status).toBe("done");
    const thought = lines.find((s) => s.type === "thought")!;
    expect(thought.audio).toMatchObject({ status: "done", effect: "thought" });
    expect(thought.audio.url).toEndWith(".wav");
    expect(calls).toHaveLength(1);
    for (const s of lines.filter((s) => s.type !== "thought" && s.audio.status === "done"))
      expect(s.audio.effect).toBeUndefined();
  });

  test("a book that narrates its thoughts plain never calls it", async () => {
    const { effect, calls } = stubEffect();
    const api = testApi({ thoughtEffect: effect });
    const id = await bookWithAThought(api, true);
    const { lines } = await narrate(api, id);

    expect(calls).toHaveLength(0);
    const thought = lines.find((s) => s.type === "thought")!;
    expect(thought.audio.status).toBe("done");
    expect(thought.audio.effect).toBeUndefined();
  });

  test("one that fails keeps the clip the voice made, and the log says which line", async () => {
    const { effect } = stubEffect(0, new Error("no ffmpeg here"));
    const api = testApi({ thoughtEffect: effect });
    const id = await bookWithAThought(api);
    const { job, lines } = await narrate(api, id);

    expect(job.status).toBe("done");
    const thought = lines.find((s) => s.type === "thought")!;
    expect(thought.audio.status).toBe("done");
    expect(thought.audio.effect).toBeUndefined();
    const warned = job.activity?.find((e) => e.message.includes("thought effect was not applied"));
    expect(warned?.message).toContain(`Line ${thought.id}`);
    expect(warned?.message).toContain("no ffmpeg here");
  });

  test("the endpoint's slot is given back before it runs, so the next line is already out", async () => {
    const inner = fakeSpeechProvider({ delayMs: 5 });
    const starts: number[] = [];
    const speech: SpeechProvider = {
      name: inner.name,
      speak: (input) => (starts.push(Date.now()), inner.speak(input)),
    };
    const { effect, calls } = stubEffect(300);
    const api = testApi({ speech, thoughtEffect: effect });
    const id = await bookWithAThought(api);
    await narrate(api, id);

    // at a concurrency of one, a line sent while the thought was still being processed is a line
    // the slot was free for
    const [{ at, done }] = calls;
    expect(starts.some((s) => s > at && s < done!)).toBe(true);
  });
});

const ffmpeg = await ffmpegAvailable();

describe.skipIf(!ffmpeg)("ffmpeg's thought effect", () => {
  test("gives back a WAV at the clip's own rate, with its sizes written", async () => {
    const tone = await fakeSpeechProvider().speak({
      text: "I should not have come back here.",
      speaker: "Mara",
      type: "thought",
      encoding: { format: "wav" },
      signal: new AbortController().signal,
    } as Parameters<SpeechProvider["speak"]>[0]);
    const before = await probeClip(tone.bytes, "wav");
    const out = await ffmpegThoughtEffect()(tone.bytes, "wav", new AbortController().signal);
    const after = await probeClip(out, "wav");

    expect(after.sampleRate).toBe(before.sampleRate);
    // the room rings on a little past the last sample, never much
    expect(after.duration).toBeGreaterThanOrEqual(before.duration);
    expect(after.duration - before.duration).toBeLessThan(0.1);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(4, true)).toBe(out.byteLength - 8);
    expect(out).not.toEqual(tone.bytes);
  });
});
