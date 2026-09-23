// Clips kept as MP3 and Opus: what the providers ask for and accept, how a line in parts is put
// back together, how a clip is served, and what a build does with a book narrated that way.
//
// The files are built in the test (`support/encoded.ts`) rather than kept as fixtures: MP3 frames
// of silence and Ogg pages of empty Opus packets, both real files of an exact length.
import { describe, expect, test } from "bun:test";

import type { Book, Character, Endpoint, ExportItem, Segment } from "@/types";
import { DEFAULT_EXPORT_SETTINGS } from "@/lib/exports";
import { exportFileToken } from "~/db/exports";
import { expressionParts, expressionPlan } from "@/lib/expressions";
import { formatOfFile } from "~/audio/files";
import { mp3Frames } from "~/audio/mp3";
import { joinClips, probeClip } from "~/audio/probe";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { fakeSpeechProvider, toneWav } from "~/providers/fakeSpeech";
import { ffmpegAvailable, ffmpegEncoders } from "~/providers/ffmpegEncoder";
import type { SpeechInput, SpeechProvider } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { MP3_FRAME, oggOpus, silentMp3 } from "../support/encoded";
import { epubFile, story } from "../support/epub";
import { jsonBody, testApi, type TestApi } from "../support/server";

// ---- what a provider asks for, and what it accepts ----

const fish: ProviderTarget = {
  id: "fish",
  name: "Fish Audio (free)",
  baseUrl: "https://api.fish.audio/v1",
  model: "s2.1-pro-free",
  apiKey: "sk-fish",
  needsKey: true,
  timeoutSec: 5,
  maxRetries: 0,
  cooldownSec: 0,
};
const openai: ProviderTarget = {
  ...fish,
  id: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini-tts",
};

const line = (target: ProviderTarget, over: Partial<SpeechInput> = {}): SpeechInput => ({
  text: "Come in.",
  speaker: "Mara",
  type: "dialogue",
  direction: "",
  instructions: "",
  voiceRef: `${target.id}/voice-1`,
  sampleRate: null,
  encoding: { format: "wav" },
  target,
  signal: new AbortController().signal,
  ...over,
});

/** A fetch that answers every request with `answer`, and remembers what it was sent. */
function answering(answer: () => Response) {
  const sent: RequestInit[] = [];
  const fetch = (async (_: string, init: RequestInit) => {
    sent.push(init);
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch, body: (i = 0) => JSON.parse(String(sent[i].body)) };
}

const served = (bytes: Uint8Array, type: string) => () =>
  new Response(bytes, { headers: { "content-type": type } });
const speaker = (fetch: typeof globalThis.fetch) =>
  endpointSpeechProvider({ fetch, backoffMs: () => 0 });

describe("asking for MP3 and Opus", () => {
  test("Fish is sent the format, its bitrate and the rate, and its MP3 is kept byte for byte", async () => {
    const mp3 = silentMp3(25, { rate: 32000, kbps: 192 });
    const f = answering(served(mp3, "audio/mpeg"));
    const clip = await speaker(f.fetch).speak(
      line(fish, { encoding: { format: "mp3", bitrate: 192 }, sampleRate: 32000 }),
    );
    expect(f.body()).toEqual({
      text: "Come in.",
      reference_id: "voice-1",
      format: "mp3",
      mp3_bitrate: 192,
      sample_rate: 32000,
      normalize: true,
    });
    expect(clip).toMatchObject({ format: "mp3", mime: "audio/mpeg" });
    expect(clip.bytes).toEqual(mp3);
    expect(clip.duration).toBeCloseTo((25 * MP3_FRAME) / 32000, 6);
  });

  test("Fish is sent Opus with its bitrate, and no bitrate when none is chosen", async () => {
    const f = answering(served(oggOpus(40), "audio/opus"));
    const clip = await speaker(f.fetch).speak(
      line(fish, { encoding: { format: "opus", bitrate: -1000 } }),
    );
    expect(f.body()).toMatchObject({ format: "opus", opus_bitrate: -1000 });
    expect(clip).toMatchObject({ format: "opus", mime: "audio/ogg" });
    expect(clip.duration).toBeCloseTo(0.8, 6);

    const plain = answering(served(silentMp3(10), "audio/mpeg"));
    await speaker(plain.fetch).speak(line(fish, { encoding: { format: "mp3" } }));
    expect(plain.body()).toMatchObject({ format: "mp3" });
    expect(Object.keys(plain.body()).some((k) => k.endsWith("_bitrate"))).toBe(false);
  });

  test("an OpenAI-shaped server is sent the format as `response_format`, and nothing else new", async () => {
    const f = answering(served(silentMp3(10), "audio/mpeg"));
    const clip = await speaker(f.fetch).speak(line(openai, { encoding: { format: "mp3" } }));
    expect(f.body()).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Come in.",
      voice: "voice-1",
      response_format: "mp3",
    });
    expect(clip.format).toBe("mp3");
  });

  test("a format, bitrate and rate the API cannot be asked for together are refused before a request", async () => {
    const f = answering(served(silentMp3(10), "audio/mpeg"));
    const p = speaker(f.fetch);
    const refused: [SpeechInput, string][] = [
      [line(fish, { encoding: { format: "opus" }, sampleRate: 44100 }), "Opus here is 48 kHz"],
      [line(fish, { encoding: { format: "mp3", bitrate: 96 } }), "MP3 here is 64 kbps, 128 kbps"],
      [
        line(fish, { encoding: { format: "mp3" }, sampleRate: 24000 }),
        "MP3 here is 32 kHz, 44.1 kHz",
      ],
      [line(openai, { encoding: { format: "mp3", bitrate: 128 } }), "MP3 takes no bitrate here"],
      [
        line(openai, { encoding: { format: "opus" }, sampleRate: 48000 }),
        "cannot be asked for one",
      ],
    ];
    for (const [input, why] of refused) await expect(p.speak(input)).rejects.toThrow(why);
    expect(f.sent).toHaveLength(0);
  });

  test("an answer that is not the MP3 or Opus asked for is a failure saying so, not a clip", async () => {
    const mp3 = { encoding: { format: "mp3" as const } };
    const cases: [() => Response, RegExp][] = [
      [() => Response.json({ message: "voice not found" }), /sent no audio: .*voice not found/],
      [served(new Uint8Array(), "audio/mpeg"), /with nothing in it/],
      // a local server that ignored `response_format` and sent WAV anyway
      [served(toneWav(300, 0.5), "audio/mpeg"), /not an MP3 file/],
      [served(oggOpus(10), "audio/mpeg"), /not an MP3 file.*not MP3/],
    ];
    for (const [answer, why] of cases)
      await expect(speaker(answering(answer).fetch).speak(line(fish, mp3))).rejects.toThrow(why);
    await expect(
      speaker(answering(served(silentMp3(10), "audio/ogg")).fetch).speak(
        line(fish, { encoding: { format: "opus" } }),
      ),
    ).rejects.toThrow(/not an Opus file.*not Opus/);
  });
});

// ---- an MP3's length, and one made of parts ----

describe("an MP3 clip", () => {
  test("plays for its audio frames, not its Info frame or its tags", async () => {
    const bytes = silentMp3(40, { info: true, id3: true, id3v1: true });
    const info = await probeClip(bytes, "mp3");
    expect(info).toEqual({
      format: "mp3",
      sampleRate: 44100,
      channels: 1,
      duration: (40 * MP3_FRAME) / 44100,
    });
    expect(mp3Frames(bytes).frames).toHaveLength(40);
  });

  test("in parts is joined frame after frame, every part's tags and Info frame dropped", async () => {
    const parts = [
      silentMp3(30, { info: true, id3: true }),
      silentMp3(12, { info: true, id3: true, id3v1: true }),
      silentMp3(7),
    ];
    const joined = joinClips("mp3", parts);
    const text = new TextDecoder("latin1").decode(joined);
    expect(text).not.toContain("ID3");
    expect(text).not.toContain("Info");
    expect(text).not.toContain("TAG");
    const info = await probeClip(joined, "mp3");
    expect(info.duration).toBeCloseTo((49 * MP3_FRAME) / 44100, 9);
    expect(joined.byteLength).toBe(49 * 417);
  });

  test("parts at two rates are not joined, and the one that differs is named", () => {
    expect(() => joinClips("mp3", [silentMp3(3), silentMp3(3, { rate: 32000 })])).toThrow(
      "part 2 came back as 32000 Hz in 1 channels and part 1 as 44100 Hz in 1",
    );
  });
});

// ---- the narration job, the files and the route ----

/**
 * The fake, answering in the format it is asked for: MP3 frames or Opus packets of silence as long
 * as the fake's reading of the line, rounded to a whole frame. What a real endpoint does, without one.
 */
/**
 * Four seconds per line of a quiet tone with a sharp peak each second, as a real 44.1 kHz MP3 —
 * for what silence cannot show. The peaks are the point: speech has them, and they are what makes
 * `loudnorm` give up on linear gain for its dynamic mode, which is the one that resamples.
 */
function toneMp3(): SpeechProvider {
  return {
    name: "Tone MP3 (ffmpeg)",
    async speak() {
      const proc = Bun.spawn(
        [
          "ffmpeg",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=0.01*sin(2*PI*330*t)+if(lt(mod(t\\,1)\\,0.002)\\,0.9\\,0):s=44100:d=4",
          "-c:a",
          "libmp3lame",
          "-f",
          "mp3",
          "-",
        ],
        { stdout: "pipe" },
      );
      const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
      const { duration } = await probeClip(bytes, "mp3");
      return {
        bytes,
        format: "mp3",
        mime: "audio/mpeg",
        duration,
        ms: 1,
        model: "tone",
        voice: null,
      };
    },
  };
}

function encodingFake(): SpeechProvider & { sent: SpeechInput[] } {
  const inner = fakeSpeechProvider();
  const sent: SpeechInput[] = [];
  return {
    name: "Encoding fake",
    sent,
    async speak(input) {
      sent.push(input);
      const clip = await inner.speak(input);
      const { format } = input.encoding;
      if (format === "mp3") {
        const frames = Math.max(1, Math.round((clip.duration * 44100) / MP3_FRAME));
        return {
          ...clip,
          format,
          mime: "audio/mpeg",
          bytes: silentMp3(frames, { info: true }),
          duration: (frames * MP3_FRAME) / 44100,
        };
      }
      if (format === "opus") {
        const packets = Math.max(1, Math.round(clip.duration * 50));
        return {
          ...clip,
          format,
          mime: "audio/ogg",
          bytes: oggOpus(packets),
          duration: packets / 50,
        };
      }
      return clip;
    },
  };
}

const TELEMETRY = { history: [], failures: 0, rateLimits: 0, backoffUntil: 0 };
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

const saveEndpoint = (api: TestApi, endpoint: Endpoint) =>
  api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [endpoint], profiles: [], credentials: [] }),
    method: "PUT",
  });

/** A one-chapter book, scripted, every speaker voiced by `studio/ash`. */
async function voiced(api: TestApi, chapters = ["One"]): Promise<string> {
  const { body } = await api.import<{ book: Book }>(
    await epubFile({
      title: "Moonlight Ledger",
      chapters: chapters.map((title) => ({
        title,
        paragraphs: ["“We are short again,” said Mara.", ...story(1)],
      })),
    }),
  );
  const id = body.book.id;
  const ids = chapters.map((_, i) => i + 1);
  await api.request(`/api/books/${id}/confirm`, { method: "POST" });
  await api.request(`/api/books/${id}/chapters/script`, jsonBody({ ids }));
  await api.runner.idle();
  const cast = await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`);
  for (const c of cast.body.characters)
    await api.request(`/api/books/${id}/characters/${encodeURIComponent(c.name)}`, {
      ...jsonBody({ ...c, voice: "studio/ash" }),
      method: "PUT",
    });
  return id;
}

const narrate = async (api: TestApi, id: string, ids = [1]) => {
  await api.request(`/api/books/${id}/chapters/narrate`, jsonBody({ ids }));
  await api.runner.idle();
};

const linesOf = async (api: TestApi, id: string, ch = 1) =>
  (await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/${ch}/script`)).body
    .segments;

const bytesAt = async (api: TestApi, url: string) =>
  new Uint8Array(await (await api.fetch(url)).arrayBuffer());

describe("a book narrated in MP3", () => {
  test("is asked for MP3, kept as .mp3 at the rate it came back at, and served as audio/mpeg in parts", async () => {
    const provider = encodingFake();
    const api = testApi({ speech: provider });
    await saveEndpoint(api, speech({ encoding: { format: "mp3" } }));
    const id = await voiced(api);
    await narrate(api, id);

    expect(provider.sent.every((s) => s.encoding.format === "mp3")).toBe(true);
    const segments = await linesOf(api, id);
    for (const s of segments) {
      expect(s.audio).toMatchObject({ status: "done", sampleRate: 44100 });
      expect(s.audio.url).toEndWith(".mp3");
    }
    const url = segments[0].audio.url!;
    const whole = await api.fetch(url);
    expect(whole.headers.get("content-type")).toBe("audio/mpeg");
    const bytes = new Uint8Array(await whole.arrayBuffer());
    const part = await api.fetch(url, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-type")).toBe("audio/mpeg");
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${bytes.byteLength}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(100, 200));
  });

  test("a line longer than its endpoint takes is one MP3 that plays for as long as its parts", async () => {
    const provider = encodingFake();
    const api = testApi({ speech: provider });
    const endpoint = speech({ encoding: { format: "mp3" }, maxChars: 60 });
    await saveEndpoint(api, endpoint);
    const id = await voiced(api);
    const before = await linesOf(api, id);
    const parts = before.map((s) => expressionParts(expressionPlan(s, endpoint), endpoint));
    expect(parts.some((p) => p.length > 1)).toBe(true);
    await narrate(api, id);

    expect(provider.sent).toHaveLength(parts.flat().length);
    for (const [i, s] of (await linesOf(api, id)).entries()) {
      expect(s.audio).toMatchObject({ status: "done", parts: parts[i].length });
      const file = await probeClip(await bytesAt(api, s.audio.url!), "mp3");
      expect(file.duration).toBeCloseTo(s.audio.duration, 9);
    }
  });

  test("moving the endpoint to another format leaves the clips already in the book as they were", async () => {
    const api = testApi({ speech: encodingFake() });
    await saveEndpoint(api, speech({ sampleRate: 44100 }));
    const id = await voiced(api);
    await narrate(api, id);
    const wav = await linesOf(api, id);
    expect(wav.every((s) => s.audio.status === "done" && s.audio.url!.endsWith(".wav"))).toBe(true);

    await saveEndpoint(api, speech({ sampleRate: 44100, encoding: { format: "mp3" } }));
    expect(await linesOf(api, id)).toEqual(wav);
    // and a run over what needs doing finds nothing: the format is not drift
    const { body } = await api.request<{ skipped: { id: number; why: string }[] }>(
      `/api/books/${id}/chapters/narrate`,
      jsonBody({ ids: [1], scope: "fill" }),
    );
    expect(body.skipped).toEqual([{ id: 1, why: "nothing" }]);
  });
});

describe("a book narrated in Opus", () => {
  test("is kept as .opus and served as Ogg; a line that would need parts fails before it is sent", async () => {
    const provider = encodingFake();
    const api = testApi({ speech: provider });
    const endpoint = speech({ encoding: { format: "opus" }, maxChars: 60 });
    await saveEndpoint(api, endpoint);
    const id = await voiced(api);
    const before = await linesOf(api, id);
    const parts = before.map((s) => expressionParts(expressionPlan(s, endpoint), endpoint));
    await narrate(api, id);

    const segments = await linesOf(api, id);
    const whole = segments.filter((_, i) => parts[i].length === 1);
    const split = segments.filter((_, i) => parts[i].length > 1);
    expect(whole.length).toBeGreaterThan(0);
    expect(split.length).toBeGreaterThan(0);
    // only the lines that fit in one request were sent
    expect(provider.sent.map((s) => s.text)).toEqual(whole.map((s) => s.text));
    for (const s of split) {
      expect(s.audio.status).toBe("failed");
      expect(s.audio.error?.message).toMatch(
        /an Opus line cannot be split into parts; raise this endpoint's max characters or choose MP3 or WAV$/,
      );
    }
    for (const s of whole) {
      expect(s.audio).toMatchObject({ status: "done", sampleRate: 48000 });
      expect(formatOfFile(s.audio.url!)).toBe("opus");
      expect((await api.fetch(s.audio.url!)).headers.get("content-type")).toBe("audio/ogg");
    }
  });
});

// ---- building an audiobook from them ----

/** Whether the ffmpeg build can be checked here; skipped, as the other ffmpeg builds are, where not. */
const ffmpeg = await ffmpegAvailable();

const settings = { ...DEFAULT_EXPORT_SETTINGS, title: "Moonlight Ledger", filename: "Ledger" };
const exportsOf = async (api: TestApi, id: string) =>
  (await api.request<{ exports: ExportItem[] }>(`/api/books/${id}/exports`)).body.exports;

describe("building a book narrated in MP3", () => {
  test("the WAV stitcher refuses, naming the chapter and the way out, before it writes anything", async () => {
    const api = testApi({ speech: encodingFake() });
    await saveEndpoint(api, speech({ encoding: { format: "mp3" } }));
    const id = await voiced(api);
    await narrate(api, id);
    await api.request(`/api/books/${id}/exports`, jsonBody({ ids: [1], settings }));
    await api.runner.idle();

    const [built] = await exportsOf(api, id);
    expect(built.status).toBe("failed");
    expect(built.error).toStartWith(
      "“One” was narrated in MP3, and this server builds with the WAV stitcher, which joins WAV clips only. Restart the server with EXPORT_ENCODER=ffmpeg",
    );
    const written = [...new Bun.Glob("**/*").scanSync(api.exportDir)];
    expect(written).toEqual([]);
  });

  test.skipIf(!ffmpeg)(
    "ffmpeg decodes each clip and builds from a mix of MP3 and WAV",
    async () => {
      const api = testApi({ speech: encodingFake(), encoder: ffmpegEncoders() });
      await saveEndpoint(api, speech({ sampleRate: 44100 }));
      const id = await voiced(api, ["One", "Two"]);
      await narrate(api, id, [1]);
      await saveEndpoint(api, speech({ sampleRate: 44100, encoding: { format: "mp3" } }));
      await narrate(api, id, [2]);
      expect((await linesOf(api, id, 2)).every((s) => s.audio.url!.endsWith(".mp3"))).toBe(true);

      await api.request(
        `/api/books/${id}/exports`,
        jsonBody({ ids: [1, 2], settings: { ...settings, normalize: false } }),
      );
      await api.runner.idle();
      const [built] = await exportsOf(api, id);
      expect(built.status).toBe("done");
      const clips = [...(await linesOf(api, id, 1)), ...(await linesOf(api, id, 2))];
      // every clip is in it: the file is at least as long as the clips, silence on top
      const audio = clips.reduce((n, s) => n + s.audio.duration, 0);
      expect(built.duration).toBeGreaterThan(audio - 0.1);
      // and the file plays for what the build says it does
      const path = api.exports.files.path(id, exportFileToken(api.db, built.id, 0)!)!;
      const probe = Bun.spawn(
        [
          "ffprobe",
          "-v",
          "quiet",
          "-select_streams",
          "a",
          "-show_entries",
          "format=duration:stream=sample_rate",
          "-of",
          "json",
          path,
        ],
        { stdout: "pipe" },
      );
      const read = JSON.parse(await new Response(probe.stdout).text()) as {
        format: { duration: string };
        streams: { sample_rate: string }[];
      };
      expect(Number(read.format.duration)).toBeCloseTo(built.duration, 0);
      expect(Number(read.streams[0].sample_rate)).toBe(44100);
    },
    30_000,
  );

  test.skipIf(!ffmpeg)(
    "a silent book builds levelled, rather than failing on a loudness of -inf",
    async () => {
      const api = testApi({ speech: encodingFake(), encoder: ffmpegEncoders() });
      await saveEndpoint(api, speech({ sampleRate: 44100, encoding: { format: "mp3" } }));
      const id = await voiced(api, ["One"]);
      await narrate(api, id, [1]);
      await api.request(`/api/books/${id}/exports`, jsonBody({ ids: [1], settings }));
      await api.runner.idle();
      const [built] = await exportsOf(api, id);
      expect(built).toMatchObject({ status: "done" });
    },
    30_000,
  );

  test.skipIf(!ffmpeg)(
    "a levelled build stays at the clips' rate, though loudnorm resamples inside",
    async () => {
      // Audible and 16-bit, as every real clip decodes: ffmpeg keeps an 8-bit source's rate by
      // accident, and takes a 16-bit one to 96 kHz AAC unless the output names a rate.
      const api = testApi({ speech: toneMp3(), encoder: ffmpegEncoders() });
      await saveEndpoint(api, speech({ sampleRate: 44100, encoding: { format: "mp3" } }));
      const id = await voiced(api, ["One"]);
      await narrate(api, id, [1]);
      await api.request(`/api/books/${id}/exports`, jsonBody({ ids: [1], settings }));
      await api.runner.idle();
      const [built] = await exportsOf(api, id);
      expect(built.status).toBe("done");
      const path = api.exports.files.path(id, exportFileToken(api.db, built.id, 0)!)!;
      const probe = Bun.spawn(
        [
          "ffprobe",
          "-v",
          "quiet",
          "-select_streams",
          "a",
          "-show_entries",
          "stream=sample_rate",
          "-of",
          "csv=p=0",
          path,
        ],
        { stdout: "pipe" },
      );
      expect(Number(await new Response(probe.stdout).text())).toBe(44100);
    },
    30_000,
  );
});
