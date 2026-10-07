// The real speech provider against an injected `fetch`: what it sends to Fish Audio and to an
// OpenAI-shaped server, what it makes of the answer, what it refuses before sending anything, and
// what it reports to the ledger about each request that went out — billed or not.
import { describe, expect, test } from "bun:test";

import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import type { SentSpeech } from "~/providers/sent";
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
  encoding: { format: "wav" },
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

/** Collects what a provider reports through `sent`, to hand in as the line's own. */
function reports() {
  const got: SentSpeech[] = [];
  return { got, sent: (r: SentSpeech) => void got.push(r) };
}

const headersOf = (init: RequestInit) => new Headers(init.headers);
const provider = (fetch: typeof globalThis.fetch) =>
  endpointSpeechProvider({ fetch, backoffMs: () => 0 });

describe("Fish Audio", () => {
  test("is sent the words, the voice and the rate the way its API takes them", async () => {
    const f = scripted(() => audio(streamingWav(24000, 12000)));
    const r = reports();
    const clip = await provider(f.fetch).speak(
      line(fish, { sampleRate: 24000, direction: "sly", instructions: "Sly.", sent: r.sent }),
    );
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
    // one request, reported as it went: Fish was sent no instructions, so none are billed
    expect(r.got).toEqual([
      expect.objectContaining({
        status: "done",
        text: "Come in.",
        instructions: "",
        audioSeconds: clip.duration,
        attempts: 1,
        simulated: false,
        reported: null,
      }),
    ]);
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

  test("a model Fish does not document is refused before a request, since Fish would bill it as s2.1-pro", async () => {
    const f = scripted(audio);
    const r = reports();
    await expect(
      provider(f.fetch).speak(line({ ...fish, model: "s2.1-pro-fre" }, { sent: r.sent })),
    ).rejects.toThrow("“s2.1-pro-fre” is not a model Fish Audio documents");
    expect(f.sent).toHaveLength(0);
    expect(r.got).toEqual([]);
  });

  test("a rate Fish does not render WAV at is refused before a request", async () => {
    const f = scripted(audio);
    const speaking = provider(f.fetch).speak(line(fish, { sampleRate: 22050 }));
    await expect(speaking).rejects.toThrow(
      "Fish Audio (free) cannot be asked for this line's audio as it is set up: WAV here is 16 kHz, 24 kHz, 32 kHz, 44.1 kHz. Change it on the Endpoints page.",
    );
    expect(f.sent).toHaveLength(0);
  });
});

describe("an OpenAI-shaped server", () => {
  test("is sent model, input, voice, wav and the line's instructions", async () => {
    const f = scripted(() => audio(streamingWav(24000, 24000)));
    const r = reports();
    const clip = await provider(f.fetch).speak(
      line(openai, {
        direction: "whispering",
        instructions: " Warm, low. Whispering. ",
        sent: r.sent,
      }),
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
    expect(r.got).toEqual([
      expect.objectContaining({
        status: "done",
        text: "Come in.",
        instructions: "Warm, low. Whispering.",
        audioSeconds: clip.duration,
      }),
    ]);
  });

  test("a voice made from the account's own recording is sent as the object OpenAI asks for", async () => {
    const f = scripted(audio);
    await provider(f.fetch).speak(line(openai, { voiceRef: "openai/voice_123abc" }));
    expect(f.body().voice).toEqual({ id: "voice_123abc" });
  });

  test("a local server without a key is sent none, and tts-1 no instructions", async () => {
    const local = {
      ...openai,
      baseUrl: "http://127.0.0.1:8880/v1",
      // however it was typed
      model: " TTS-1 ",
      apiKey: null,
      needsKey: false,
    };
    const f = scripted(audio);
    const r = reports();
    await provider(f.fetch).speak(line(local, { instructions: "Whispering.", sent: r.sent }));
    expect(f.sent[0].url).toBe("http://127.0.0.1:8880/v1/audio/speech");
    expect(headersOf(f.sent[0].init).get("authorization")).toBeNull();
    expect("instructions" in f.body()).toBe(false);
    // and what was not sent is not billed
    expect(r.got.map((x) => x.instructions)).toEqual([""]);
  });

  test("a sample rate cannot be asked for, so one is refused before a request", async () => {
    const f = scripted(audio);
    const speaking = provider(f.fetch).speak(line(openai, { sampleRate: 24000 }));
    await expect(speaking).rejects.toThrow(/cannot be asked for one; clear it/);
    expect(f.sent).toHaveLength(0);
  });
});

describe("what comes back", () => {
  test("a 200 that is JSON is a failure saying what it said", async () => {
    const f = scripted(() => Response.json({ message: "voice not found" }));
    const r = reports();
    await expect(provider(f.fetch).speak(line(fish, { sent: r.sent }))).rejects.toThrow(
      /answered 200 but sent no audio.*voice not found/,
    );
    // it was asked, and answered with a 200, so it was billed and the ledger keeps it
    expect(r.got).toEqual([
      expect.objectContaining({
        status: "failed",
        billed: true,
        audioSeconds: 0,
        error: { code: 200, message: expect.stringMatching(/voice not found/) },
      }),
    ]);
  });

  test("a body the clock cuts off says it timed out", async () => {
    const stalled = new ReadableStream({
      pull(controller) {
        controller.error(new DOMException("The operation timed out.", "TimeoutError"));
      },
    });
    const f = scripted(() => new Response(stalled, { headers: { "content-type": "audio/wav" } }));
    await expect(provider(f.fetch).speak(line(fish))).rejects.toThrow(
      "Fish Audio (free) answered 200 but did not finish sending the audio within 5 s",
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
    const r = reports();
    await expect(provider(refused.fetch).speak(line(fish, { sent: r.sent }))).rejects.toThrow(
      "Fish Audio (free) answered 401: Invalid token",
    );
    expect(refused.sent).toHaveLength(1);
    // refused, so nothing was generated and nothing billed
    expect(r.got).toEqual([expect.objectContaining({ status: "failed", billed: false })]);

    const busy = scripted(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      audio,
    );
    const clip = await provider(busy.fetch).speak(line(fish));
    expect(busy.sent).toHaveLength(2);
    expect(clip.duration).toBeCloseTo(1);
  });

  test("a 500 that outlasts the retries is one failed request, reporting every attempt", async () => {
    const f = scripted(() => new Response("upstream fell over", { status: 500 }));
    const r = reports();
    await expect(provider(f.fetch).speak(line(openai, { sent: r.sent }))).rejects.toThrow(
      "OpenAI answered 500: upstream fell over",
    );
    expect(f.sent).toHaveLength(1 + openai.maxRetries);
    expect(r.got).toEqual([
      expect.objectContaining({
        status: "failed",
        attempts: 1 + openai.maxRetries,
        rateLimited: false,
        audioSeconds: 0,
        billed: false,
        error: { code: 500, message: "OpenAI answered 500: upstream fell over" },
      }),
    ]);
  });

  test("a 409 is not tried again: a conflict is the same the second time", async () => {
    const f = scripted(() => new Response("busy with another", { status: 409 }));
    await expect(provider(f.fetch).speak(line(openai))).rejects.toThrow("answered 409");
    expect(f.sent).toHaveLength(1);
  });

  test("no answer at all is reported failed, and not billed", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const r = reports();
    await expect(provider(fetch).speak(line(fish, { sent: r.sent }))).rejects.toThrow(
      "could not be reached: fetch failed",
    );
    expect(r.got).toEqual([
      expect.objectContaining({
        status: "failed",
        billed: false,
        error: expect.objectContaining({ code: 0 }),
      }),
    ]);
  });
});

describe("a rate limit, told to the line", () => {
  /**
   * What reached the wire and what the line was told, in the order they happened — the line is
   * told before the wait, so the gate holds the other lines for the same stretch this one waits.
   */
  function timeline(...answers: (() => Response)[]) {
    const events: string[] = [];
    const f = scripted(
      ...answers.map((answer) => () => {
        events.push("sent");
        return answer();
      }),
    );
    return { ...f, events, rateLimited: (ms: number) => void events.push(`told ${ms}`) };
  }

  test("a 429 tells how long its Retry-After asks for, before the attempt after it", async () => {
    const t = timeline(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "0.02" } }),
      audio,
    );
    await provider(t.fetch).speak(line(fish, { rateLimited: t.rateLimited }));
    expect(t.events).toEqual(["sent", "told 20", "sent"]);
  });

  test("a 429 with no Retry-After tells the endpoint's cooldown", async () => {
    const t = timeline(() => new Response("slow down", { status: 429 }), audio);
    await provider(t.fetch).speak(
      line({ ...fish, cooldownSec: 0.02 }, { rateLimited: t.rateLimited }),
    );
    expect(t.events).toEqual(["sent", "told 20", "sent"]);
  });

  test("the last attempt's 429 is told too: the endpoint is limited whether or not this line waits", async () => {
    const t = timeline(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    );
    await expect(
      provider(t.fetch).speak(line({ ...fish, maxRetries: 0 }, { rateLimited: t.rateLimited })),
    ).rejects.toThrow("answered 429: slow down");
    expect(t.events).toEqual(["sent", "told 30000"]);
  });

  test("a 500 is a fault, not a rate limit, and tells nothing", async () => {
    const t = timeline(
      () => new Response("upstream fell over", { status: 500, headers: { "retry-after": "0" } }),
    );
    await expect(
      provider(t.fetch).speak(line(openai, { rateLimited: t.rateLimited })),
    ).rejects.toThrow("answered 500");
    expect(t.events).toEqual(["sent", "sent", "sent"]);
  });
});

describe("refused before any request", () => {
  test("no key, no voice, or a voice whose endpoint is gone", async () => {
    const f = scripted(audio);
    const p = provider(f.fetch);
    const r = reports();
    const { sent } = r;
    await expect(p.speak(line({ ...fish, apiKey: null }, { sent }))).rejects.toThrow(
      /needs an API key/,
    );
    await expect(p.speak(line(fish, { voiceRef: null, sent }))).rejects.toThrow(
      /Mara has no voice/,
    );
    await expect(p.speak(line(null, { sent }))).rejects.toThrow(
      /no longer configured \(gone\/voice-1\)/,
    );
    await expect(p.speak(line(fish, { sampleRate: 22050, sent }))).rejects.toThrow(
      /cannot be asked for/,
    );
    expect(f.sent).toHaveLength(0);
    // nothing happened on the wire, so there is nothing for the ledger
    expect(r.got).toEqual([]);
  });

  test("a cancel throws the job's own reason, reported cancelled once the request went out", async () => {
    const ctl = new AbortController();
    const reason = new Error("cancelled by you");
    const fetch = ((_: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        ctl.abort(reason);
      })) as unknown as typeof globalThis.fetch;
    const r = reports();
    await expect(
      provider(fetch).speak(line(fish, { signal: ctl.signal, sent: r.sent })),
    ).rejects.toBe(reason);
    // what the provider did with a request it was mid-way through is not knowable: billed or not,
    // nobody here can say
    expect(r.got).toEqual([
      expect.objectContaining({ status: "cancelled", billed: null, audioSeconds: 0 }),
    ]);
  });

  test("a cancel before the request went out reports nothing", async () => {
    const ctl = new AbortController();
    ctl.abort(new Error("cancelled by you"));
    const fetch = (() => {
      throw new Error("nothing should be sent");
    }) as unknown as typeof globalThis.fetch;
    const r = reports();
    await expect(
      provider(fetch).speak(line(fish, { signal: ctl.signal, sent: r.sent })),
    ).rejects.toThrow("cancelled by you");
    expect(r.got).toEqual([]);
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

  test("Fish's answer says so when the model is not one Fish documents", async () => {
    const f = scripted(() => Response.json({ total: 3, items: [] }));
    const found = await provider(f.fetch).probe!(
      { ...fish, model: "s2-free" },
      new AbortController().signal,
    );
    expect(found).toMatchObject({
      ok: false,
      message: expect.stringMatching(
        /key was accepted, but “s2-free” is not a model Fish Audio documents/,
      ),
    });
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
