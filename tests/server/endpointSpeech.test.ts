// The real speech provider against an injected `fetch`: what it sends to Fish Audio and to an
// OpenAI-shaped server, what it makes of the answer, and what it refuses before sending anything.
import { describe, expect, test } from "bun:test";

import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { readWavHeader } from "~/providers/wavEncoder";

const fish: ProviderTarget = {
  id: "fish",
  name: "Fish Audio (free)",
  baseUrl: "https://api.fish.audio/v1",
  model: "s2.1-pro-free",
  apiKey: "sk-fish",
  needsKey: true,
  timeoutSec: 5,
  maxRetries: 2,
  cooldownSec: 0,
};
const openai: ProviderTarget = {
  ...fish,
  id: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini-tts",
  apiKey: "sk-openai",
};

const line = (target: ProviderTarget | null, over: Partial<SpeechInput> = {}): SpeechInput => ({
  text: "Come in.",
  speaker: "Mara",
  type: "dialogue",
  direction: "",
  instructions: "",
  voiceRef: `${target?.id ?? "gone"}/voice-1`,
  sampleRate: null,
  target,
  signal: new AbortController().signal,
  ...over,
});

/**
 * A 16-bit mono WAV of `frames` samples with the header a streaming model writes: every size
 * 0xFFFFFFxx, true of nothing — the header Fish Audio really answers with.
 */
function streamingWav(rate: number, frames: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(44 + frames * 2 + extra);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) =>
    [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 0xffffff24, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, 0xffffff00, true);
  return bytes;
}

const audio = (bytes = streamingWav(44100, 44100)) =>
  new Response(bytes, { headers: { "content-type": "audio/wav" } });

/** A fetch that answers from a list in turn, and remembers what it was sent. */
function scripted(...answers: (() => Response)[]) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    const next = answers[Math.min(sent.length, answers.length) - 1];
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch, body: (i = 0) => JSON.parse(String(sent[i].init.body)) };
}

const headersOf = (init: RequestInit) => new Headers(init.headers);
const provider = (fetch: typeof globalThis.fetch) =>
  endpointSpeechProvider({ fetch, backoffMs: () => 0 });

describe("Fish Audio", () => {
  test("is sent the words, the voice and the rate the way its API takes them", async () => {
    const f = scripted(() => audio(streamingWav(24000, 12000)));
    const clip = await provider(f.fetch).speak(line(fish, { sampleRate: 24000, direction: "sly" }));
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].url).toBe("https://api.fish.audio/v1/tts");
    const h = headersOf(f.sent[0].init);
    expect(h.get("model")).toBe("s2.1-pro-free");
    expect(h.get("authorization")).toBe("Bearer sk-fish");
    // the direction is not written in: the job already placed the endpoint's own tags
    expect(f.body()).toEqual({
      text: "Come in.",
      reference_id: "voice-1",
      format: "wav",
      sample_rate: 24000,
      normalize: true,
    });
    expect(clip).toMatchObject({ model: "s2.1-pro-free", voice: "voice-1", mime: "audio/wav" });
    expect(clip.duration).toBeCloseTo(0.5);
  });

  test("a streaming header comes back as a plain one, its sizes counted from what arrived", async () => {
    // one torn byte at the end: half a sample, dropped
    const f = scripted(() => audio(streamingWav(44100, 22050, 1)));
    const clip = await provider(f.fetch).speak(line(fish));
    expect("sample_rate" in f.body()).toBe(false);
    const view = new DataView(clip.bytes.buffer, clip.bytes.byteOffset);
    expect(clip.bytes.byteLength).toBe(44 + 44100);
    expect(view.getUint32(4, true)).toBe(36 + 44100);
    expect(view.getUint32(40, true)).toBe(44100);
    expect(readWavHeader(clip.bytes)).toMatchObject({ sampleRate: 44100, bits: 16, length: 44100 });
    expect(clip.duration).toBeCloseTo(0.5);
  });

  test("a rate Fish does not render WAV at is refused before a request", async () => {
    const f = scripted(audio);
    const speaking = provider(f.fetch).speak(line(fish, { sampleRate: 22050 }));
    await expect(speaking).rejects.toThrow(/cannot render WAV at 22050 Hz.*8000, 16000, 24000/);
    expect(f.sent).toHaveLength(0);
  });
});

describe("an OpenAI-shaped server", () => {
  test("is sent model, input, voice, wav and the line's instructions", async () => {
    const f = scripted(() => audio(streamingWav(24000, 24000)));
    const clip = await provider(f.fetch).speak(
      line(openai, { direction: "whispering", instructions: " Warm, low. Whispering. " }),
    );
    expect(f.sent[0].url).toBe("https://api.openai.com/v1/audio/speech");
    expect(headersOf(f.sent[0].init).get("model")).toBeNull();
    expect(f.body()).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Come in.",
      voice: "voice-1",
      response_format: "wav",
      instructions: "Warm, low. Whispering.",
    });
    expect(clip.duration).toBeCloseTo(1);
  });

  test("a local server without a key is sent none, and tts-1 no instructions", async () => {
    const local = {
      ...openai,
      baseUrl: "http://127.0.0.1:8880/v1",
      model: "tts-1",
      apiKey: null,
      needsKey: false,
    };
    const f = scripted(audio);
    await provider(f.fetch).speak(line(local, { instructions: "Whispering." }));
    expect(f.sent[0].url).toBe("http://127.0.0.1:8880/v1/audio/speech");
    expect(headersOf(f.sent[0].init).get("authorization")).toBeNull();
    expect("instructions" in f.body()).toBe(false);
  });

  test("a sample rate cannot be asked for, so one is refused before a request", async () => {
    const f = scripted(audio);
    const speaking = provider(f.fetch).speak(line(openai, { sampleRate: 24000 }));
    await expect(speaking).rejects.toThrow(/cannot be asked for a sample rate/);
    expect(f.sent).toHaveLength(0);
  });
});

describe("what comes back", () => {
  test("a 200 that is JSON is a failure saying what it said", async () => {
    const f = scripted(() => Response.json({ message: "voice not found" }));
    await expect(provider(f.fetch).speak(line(fish))).rejects.toThrow(
      /answered 200 but sent no audio.*voice not found/,
    );
  });

  test("an empty body, or one that is not a WAV, is a failure", async () => {
    const empty = scripted(() => audio(new Uint8Array()));
    await expect(provider(empty.fetch).speak(line(fish))).rejects.toThrow(/with nothing in it/);
    const mp3 = scripted(() =>
      audio(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    );
    await expect(provider(mp3.fetch).speak(line(fish))).rejects.toThrow(/not a WAV/);
    const headerOnly = scripted(() => audio(streamingWav(44100, 0)));
    await expect(provider(headerOnly.fetch).speak(line(fish))).rejects.toThrow(/no samples/);
  });

  test("a 401 is read out and not tried again; a 429 is", async () => {
    const refused = scripted(() =>
      Response.json({ message: "Invalid token", status: 401 }, { status: 401 }),
    );
    await expect(provider(refused.fetch).speak(line(fish))).rejects.toThrow(
      "Fish Audio (free) answered 401: Invalid token",
    );
    expect(refused.sent).toHaveLength(1);

    const busy = scripted(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      audio,
    );
    const clip = await provider(busy.fetch).speak(line(fish));
    expect(busy.sent).toHaveLength(2);
    expect(clip.duration).toBeCloseTo(1);
  });
});

describe("refused before any request", () => {
  test("no key, no voice, or a voice whose endpoint is gone", async () => {
    const f = scripted(audio);
    const p = provider(f.fetch);
    await expect(p.speak(line({ ...fish, apiKey: null }))).rejects.toThrow(/needs an API key/);
    await expect(p.speak(line(fish, { voiceRef: null }))).rejects.toThrow(/Mara has no voice/);
    await expect(p.speak(line(null))).rejects.toThrow(/no longer configured \(gone\/voice-1\)/);
    expect(f.sent).toHaveLength(0);
  });

  test("a cancel throws the job's own reason", async () => {
    const ctl = new AbortController();
    const reason = new Error("cancelled by you");
    const fetch = ((_: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        ctl.abort(reason);
      })) as unknown as typeof globalThis.fetch;
    await expect(provider(fetch).speak(line(fish, { signal: ctl.signal }))).rejects.toBe(reason);
  });
});

describe("the Test button", () => {
  test("Fish is asked for its voice library, once, with the key", async () => {
    const f = scripted(() => Response.json({ total: 3, items: [] }));
    const found = await provider(f.fetch).probe!(fish, new AbortController().signal);
    expect(f.sent[0].url).toBe("https://api.fish.audio/model?self=true&page_size=100");
    expect(headersOf(f.sent[0].init).get("authorization")).toBe("Bearer sk-fish");
    expect(found).toMatchObject({ ok: true, message: expect.stringMatching(/3 voices/) });
  });

  test("an OpenAI-shaped server is asked for its models, and a refusal is an answer", async () => {
    const listed = scripted(() => Response.json({ data: [{ id: "gpt-4o-mini-tts" }] }));
    expect(await provider(listed.fetch).probe!(openai, new AbortController().signal)).toMatchObject(
      {
        ok: true,
      },
    );
    expect(listed.sent[0].url).toBe("https://api.openai.com/v1/models");

    const missing = scripted(() => Response.json({ data: [{ id: "tts-1" }] }));
    expect(
      await provider(missing.fetch).probe!(openai, new AbortController().signal),
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not among the 1 models/),
    });

    const refused = scripted(() => new Response("bad key", { status: 503 }));
    const found = await provider(refused.fetch).probe!(openai, new AbortController().signal);
    expect(found).toMatchObject({ ok: false, message: "OpenAI answered 503: bad key" });
    // a test is one attempt, even of something another attempt might fix
    expect(refused.sent).toHaveLength(1);
  });
});
