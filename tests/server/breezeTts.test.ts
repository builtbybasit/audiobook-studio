// Breeze-TTS-2.cpp's `breeze-server` (https://github.com/HoppouAI/Breeze-TTS-2.cpp/blob/main/docs/server.md),
// named by its endpoint rather than known by its address, against a `fetch` that answers as its
// source does (`apps/server/server.cpp`, `voices.cpp`): its voice list as the Test, a busy 409 while
// it renders, a streamed WAV whose sizes are placeholders, and voices saved at `/voices`.
import { describe, expect, test } from "bun:test";

import { speechProviderOf } from "@/lib/providers";
import { endpointSpeechProvider } from "~/providers/endpointSpeech";
import { breezeVoiceName } from "~/providers/speech/breezecpp";
import type { SpeechInput } from "~/providers/speech";
import type { ProviderTarget } from "~/providers/target";
import { endpointVoiceLister } from "~/providers/voices";
import { readWavHeader } from "~/providers/wav";
import { toneWav } from "~/providers/fakeSpeech";
import { answering, cloneEndpoint, saved } from "../support/cloning";
import { silentMp3 } from "../support/encoded";
import { testApi } from "../support/server";

const breeze: ProviderTarget = {
  id: "breeze",
  name: "Breeze",
  baseUrl: "http://127.0.0.1:8137/v1",
  server: "breezecpp",
  model: "breeze-tts-2",
  apiKey: null,
  needsKey: false,
  timeoutSec: 5,
  maxRetries: 2,
  cooldownSec: 0,
};

/** A fetch that answers by `answer`, and remembers what it was sent. */
function server(answer: (url: string, init: RequestInit, n: number) => Response) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return answer(String(url), init, sent.length);
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

const error = (status: number, message: string) => Response.json({ error: message }, { status });
const signal = () => new AbortController().signal;
const line = (over: Partial<SpeechInput> = {}): SpeechInput => ({
  text: "Come in.",
  speaker: "Mara",
  type: "dialogue",
  direction: "",
  instructions: "Quietly.",
  voiceRef: "breeze/harbour",
  sampleRate: null,
  encoding: { format: "wav" },
  target: breeze,
  signal: signal(),
  ...over,
});
const harbour = { id: "harbour", frames: 67, seconds: 5.36, encode_ms: 0, saved: true };

describe("a Breeze-TTS-2.cpp endpoint", () => {
  test("is the server it names, whatever its address", () => {
    expect(speechProviderOf(breeze).id).toBe("breezecpp");
    expect(speechProviderOf({ baseUrl: breeze.baseUrl }).id).toBe("compatible");
    // a hosted API is known by its host only when nothing is named
    expect(speechProviderOf({ baseUrl: "https://api.fish.audio/v1", server: null }).id).toBe(
      "fish",
    );
  });

  test("is tested by listing its voices, which renders nothing", async () => {
    const s = server(() => Response.json([harbour]));
    const probe = await endpointSpeechProvider({ fetch: s.fetch }).probe!(breeze, signal());
    expect(probe.ok).toBe(true);
    expect(probe.message).toContain("holds 1 voice");
    expect(s.sent.map((r) => [r.init.method, r.url])).toEqual([
      ["GET", "http://127.0.0.1:8137/v1/voices"],
    ]);

    const wrong = server(() => error(404, "Not Found"));
    const failed = await endpointSpeechProvider({ fetch: wrong.fetch }).probe!(breeze, signal());
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("404");
  });

  test("a line refused as busy is tried again, and its streamed WAV cut to what arrived", async () => {
    const clip = toneWav(440, 0.5, 24000);
    // the sizes a stream writes before it knows them
    const view = new DataView(clip.buffer, clip.byteOffset, clip.byteLength);
    view.setUint32(4, 0xffffffff, true);
    view.setUint32(40, 0xffffffff, true);
    const s = server((_url, _init, n) =>
      n === 1
        ? Response.json(
            { error: { message: "busy, another generation is running", type: "server_error" } },
            { status: 409 },
          )
        : new Response(clip, { headers: { "content-type": "audio/wav" } }),
    );
    const spoken = await endpointSpeechProvider({ fetch: s.fetch, backoffMs: () => 0 }).speak(
      line(),
    );
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1].url).toBe("http://127.0.0.1:8137/v1/audio/speech");
    expect(JSON.parse(String(s.sent[1].init.body))).toEqual({
      model: "breeze-tts-2",
      input: "Come in.",
      voice: "harbour",
      instructions: "Quietly.",
      response_format: "wav",
    });
    expect(spoken.duration).toBeCloseTo(0.5, 3);
    expect(readWavHeader(spoken.bytes).length).toBe(clip.byteLength - 44);
  });

  test("lists the voices saved and cached on the server", async () => {
    const s = server(() => Response.json([harbour, { ...harbour, id: "a1b2c3", saved: false }]));
    const page = await endpointVoiceLister({ fetch: s.fetch }).list(
      breeze,
      { source: "library" },
      signal(),
    );
    expect(page.voices).toEqual([
      { id: "harbour", label: "harbour", gender: "?" },
      { id: "a1b2c3", label: "a1b2c3", gender: "?" },
    ]);
  });

  test("saves a voice from the recording as WAV, its transcript, and a name it takes", async () => {
    const f = answering(() =>
      Response.json({ id: "Mara_warm", frames: 40, seconds: 3.2, saved: true, ref_text: "Hi." }),
    );
    const voice = await f.cloner.clone(
      breeze,
      {
        title: "Mara (warm)",
        samples: [
          {
            name: "take-1.mp3",
            format: "mp3",
            blob: new Blob([silentMp3(40)], { type: "audio/mpeg" }),
            transcript: "Hi.",
          },
        ],
      },
      signal(),
    );
    expect(voice).toEqual({ id: "Mara_warm", label: "Mara (warm)", gender: "?" });
    expect(f.sent.map((s) => [s.init.method, s.url])).toEqual([
      ["POST", "http://127.0.0.1:8137/v1/voices"],
    ]);
    const form = f.sent[0].init.body as FormData;
    expect([...form.keys()].sort()).toEqual(["name", "ref_audio", "ref_text"]);
    expect(form.get("name")).toBe("Mara_warm");
    expect(form.get("ref_text")).toBe("Hi.");
    const audio = new Uint8Array(await (form.get("ref_audio") as File).arrayBuffer());
    expect(readWavHeader(audio).bits).toBe(16);
  });

  test("a voice name keeps to letters, digits, - and _", () => {
    expect(breezeVoiceName("Mara (warm)")).toBe("Mara_warm");
    expect(breezeVoiceName("Zoë-2")).toBe("Zoe_-2");
    expect(breezeVoiceName("¡¿")).toBe("voice");
    expect(breezeVoiceName("x".repeat(80))).toHaveLength(64);
  });

  test("its server is saved with the endpoint, and no other name is taken", async () => {
    const api = testApi();
    const ep = cloneEndpoint({
      id: "breeze",
      name: "Breeze",
      baseUrl: "http://127.0.0.1:8137/v1",
      needsKey: false,
      apiKey: undefined,
      server: "breezecpp",
    });
    await saved(api, ep);
    const read = await api.request<{ endpoints: { id: string; server?: string }[] }>(
      "/api/endpoints",
    );
    expect(read.body.endpoints.find((e) => e.id === "breeze")?.server).toBe("breezecpp");

    const bad = await api.request("/api/endpoints", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoints: [{ ...ep, server: "kokoro" }],
        profiles: [],
        credentials: [],
      }),
    });
    expect(bad.status).toBe(400);
  });
});
