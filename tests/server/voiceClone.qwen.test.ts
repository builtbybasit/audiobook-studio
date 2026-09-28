// Making a voice from a recording through Alibaba's Model Studio: the one JSON request its voice
// cloning reference gives for the Qwen-TTS family (`qwen-voice-enrollment`, the file as a base64
// data URL), sent once whatever fails; the Qwen-Audio models, which take a recording only as a
// public link, refused before anything is sent; what the route refuses first — a second file, a
// format Model Studio does not list, a file over its 10 MB — and how a voice made this way is then
// spoken with and listed.
import { describe, expect, test } from "bun:test";

import type { ClonedVoice, Endpoint } from "@/types";
import { qwen } from "@/lib/providers/qwen";
import { endpointVoiceCloner, type CloneRequest, type VoiceClonerOptions } from "~/providers/clone";
import type { SpeechInput } from "~/providers/speech";
import { qwenPreferredName, qwenWire } from "~/providers/speech/qwen";
import type { ProviderTarget } from "~/providers/target";
import { jsonBody, testApi, type TestApi } from "../support/server";

const CLONE_MODEL = "qwen3-tts-vc-2026-01-22";

const target: ProviderTarget = {
  id: "qwen",
  name: "Qwen VC",
  baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1",
  model: CLONE_MODEL,
  apiKey: "sk-qwen",
  needsKey: true,
  timeoutSec: 5,
  // what a narration endpoint is saved with: the clone must not take them
  maxRetries: 2,
  cooldownSec: 0,
};

/** A `fetch` that remembers each request and answers it with `answer`, and a cloner over it. */
function qwenAnswering(
  answer: (init: RequestInit) => Response | Promise<Response>,
  options: VoiceClonerOptions = {},
) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return answer(init);
  }) as unknown as typeof globalThis.fetch;
  return {
    sent,
    fetch,
    cloner: endpointVoiceCloner({ fetch, backoffMs: () => 0, ...options }),
    body: (i = 0) => JSON.parse(sent[i].init.body as string) as Record<string, unknown>,
  };
}

const signal = () => new AbortController().signal;

const recording = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 250]);
const request: CloneRequest = {
  title: "Narrator — Mara",
  samples: [
    { name: "mara.wav", format: "wav", blob: new Blob([recording], { type: "audio/wav" }) },
  ],
};

describe("the Model Studio cloner", () => {
  test("posts the create request the docs give, the recording as a base64 data URL", async () => {
    const q = qwenAnswering(() =>
      Response.json({
        output: { voice: "qwen-tts-vc-Narrator_Mara-voice-2026", target_model: CLONE_MODEL },
        usage: { count: 1 },
        request_id: "r-1",
      }),
    );
    const voice = await q.cloner.clone(target, request, signal());
    expect(voice).toEqual({
      id: "qwen-tts-vc-Narrator_Mara-voice-2026",
      label: "Narrator — Mara",
      gender: "?",
    });
    expect(q.sent).toHaveLength(1);
    expect(q.sent[0].url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization",
    );
    expect(q.sent[0].init.method).toBe("POST");
    const headers = new Headers(q.sent[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-qwen");
    expect(headers.get("content-type")).toBe("application/json");
    expect(q.body()).toEqual({
      model: "qwen-voice-enrollment",
      input: {
        action: "create",
        target_model: CLONE_MODEL,
        preferred_name: "Narrator_Mara",
        audio: { data: `data:audio/wav;base64,${Buffer.from(recording).toString("base64")}` },
        language: "en",
      },
    });
  });

  test("goes to the endpoint's own host, a workspace's among them", async () => {
    const q = qwenAnswering(() => Response.json({ output: { voice: "v1" } }));
    await q.cloner.clone(
      { ...target, baseUrl: "https://ws123.ap-southeast-1.maas.aliyuncs.com/api/v1" },
      request,
      signal(),
    );
    expect(q.sent[0].url).toBe(
      "https://ws123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/customization",
    );
  });

  test("the name asked for keeps to letters, digits and underscores, 16 at most", () => {
    expect(qwenPreferredName("Mara")).toBe("Mara");
    expect(qwenPreferredName(" Narrator — Mara ")).toBe("Narrator_Mara");
    expect(qwenPreferredName("Zoë the café owner")).toBe("Zoe_the_cafe_own");
    expect(qwenPreferredName("A very long name_")).toBe("A_very_long_name");
    expect(qwenPreferredName("abcdefghijklmno pq")).toBe("abcdefghijklmno");
    expect(qwenPreferredName("小明")).toBe("voice");
  });

  test("a clone goes out once: a 5xx, a rate limit or no answer is not sent again", async () => {
    const failures: [() => Response | Promise<Response>, string][] = [
      [() => new Response("busy", { status: 503 }), "Qwen VC answered 503: busy"],
      [
        () => Response.json({ code: "Throttling", message: "Requests throttled" }, { status: 429 }),
        "Qwen VC answered 429: Requests throttled",
      ],
      [
        () => Promise.reject(new TypeError("connection reset")),
        "Qwen VC could not be reached: connection reset",
      ],
    ];
    for (const [answer, said] of failures) {
      const q = qwenAnswering(answer);
      await expect(q.cloner.clone(target, request, signal())).rejects.toThrow(said);
      expect(q.sent).toHaveLength(1);
    }
  });

  test("a refusal is read out in Model Studio's words", async () => {
    const q = qwenAnswering(() =>
      Response.json(
        {
          code: "InvalidParameter",
          message: "Audio duration exceeds the limit",
          request_id: "r-2",
        },
        { status: 400 },
      ),
    );
    await expect(q.cloner.clone(target, request, signal())).rejects.toThrow(
      "Qwen VC answered 400: Audio duration exceeds the limit",
    );
  });

  test("an answer without the new voice is a failure, saying what came back instead", async () => {
    const empty = qwenAnswering(() => Response.json({ output: {}, request_id: "r-3" }));
    await expect(empty.cloner.clone(target, request, signal())).rejects.toThrow(
      "Qwen VC answered 200 without the new voice's id",
    );
    const said = qwenAnswering(() =>
      Response.json({ code: "Audio.Invalid", message: "no valid speech" }),
    );
    await expect(said.cloner.clone(target, request, signal())).rejects.toThrow(
      "without the new voice's id: Audio.Invalid, no valid speech",
    );
    expect(said.sent).toHaveLength(1);
  });

  test("a model Model Studio cannot clone for from a file is refused before anything is sent", async () => {
    for (const model of [
      "qwen-audio-3.0-tts-flash",
      "qwen-audio-3.0-tts-plus",
      "qwen3-tts-vc-realtime-2026-01-15",
      "qwen3-tts-flash",
    ]) {
      const q = qwenAnswering(() => Response.json({ output: { voice: "v" } }));
      await expect(q.cloner.clone({ ...target, model }, request, signal())).rejects.toThrow(
        `Qwen VC cannot make a voice from a file for “${model}”`,
      );
      expect(q.sent).toEqual([]);
    }
  });
});

// ---------- speaking with the voice, and finding it again ----------

describe("a voice-cloning model", () => {
  test("is spoken at the Qwen-TTS path, with only the words and the voice", () => {
    expect(qwen.requestPath(CLONE_MODEL)).toBe("/services/aigc/multimodal-generation/generation");
    expect(qwen.requestPath("qwen-audio-3.0-tts-flash")).toBe(
      "/services/audio/tts/SpeechSynthesizer",
    );
    const sent = qwenWire.request(
      { text: "Come in.", sampleRate: 24000 } as SpeechInput,
      target,
      "qwen-tts-vc-Mara-voice-1",
    );
    expect(sent.url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(JSON.parse(sent.init.body as string)).toEqual({
      model: CLONE_MODEL,
      input: { text: "Come in.", voice: "qwen-tts-vc-Mara-voice-1" },
    });
  });

  test("lists the voices made for it, a page at a time, and none made for another model", async () => {
    const pages = [
      {
        page_index: 0,
        page_size: 10,
        total_count: 12,
        voice_list: [
          ...Array.from({ length: 9 }, (_, i) => ({
            voice: `mine-${i}`,
            target_model: CLONE_MODEL,
          })),
          { voice: "realtime-one", target_model: "qwen3-tts-vc-realtime-2026-01-15" },
        ],
      },
      {
        page_index: 1,
        page_size: 10,
        total_count: 12,
        voice_list: [
          { voice: "mine-9", target_model: CLONE_MODEL },
          { voice: "mine-10", target_model: CLONE_MODEL },
        ],
      },
    ];
    const q = qwenAnswering(() => Response.json({ output: pages[q.sent.length - 1] }));
    const page = await qwenWire.voices(target, signal(), { fetch: q.fetch });
    expect(q.sent.map((_, i) => q.body(i))).toEqual(
      [0, 1].map((page_index) => ({
        model: "qwen-voice-enrollment",
        input: { action: "list", page_size: 10, page_index },
      })),
    );
    expect(q.sent[0].url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization",
    );
    expect(page.voices.map((v) => v.id)).toEqual(Array.from({ length: 11 }, (_, i) => `mine-${i}`));
    expect(page.voices[0]).toEqual({ id: "mine-0", label: "mine-0", gender: "?" });
    expect(page.hasMore).toBe(false);
  });
});

// ---------- the route, before anything leaves ----------

const qwenEndpoint = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: "qwen",
  name: "Qwen VC",
  baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1",
  model: CLONE_MODEL,
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
  apiKey: "sk-qwen",
  ...over,
});

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
const bytes = (...parts: (string | number[])[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? ascii(p) : p)));

const HEADS = {
  wav: bytes("RIFF", [36, 0, 0, 0], "WAVEfmt "),
  opus: bytes("OggS", [0, 2, ...Array<number>(20).fill(0), 1, 19], "OpusHead"),
  flac: bytes("fLaC", [0, 0, 0, 34]),
};

/** A file whose first bytes are `head`, padded to `size`. */
const clip = (
  name = "take-1.wav",
  head: Uint8Array = HEADS.wav,
  type = "audio/wav",
  size = 1024,
) => {
  const body = new Uint8Array(Math.max(size, head.length)).fill(7);
  body.set(head);
  return new File([body], name, { type });
};

function form(fields: Record<string, string>, samples: File[]): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const c of samples) f.append("samples", c, c.name);
  return f;
}

async function saved(api: TestApi, ep: Endpoint): Promise<void> {
  const { status } = await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [ep], profiles: [], credentials: [] }),
    method: "PUT",
  });
  expect(status).toBe(200);
}

const post = (api: TestApi, body: FormData) =>
  api.request<ClonedVoice & { error?: { message: string } }>("/api/endpoints/voices/clone", {
    method: "POST",
    body,
  });

const agreed = { id: "qwen", title: "Mara", consent: "yes" };

describe("the clone route, for Model Studio", () => {
  test("makes the voice from one recording, sent once to Model Studio", async () => {
    const q = qwenAnswering(() => Response.json({ output: { voice: "qwen-tts-vc-Mara-1" } }));
    const api = testApi({ cloner: q.cloner });
    await saved(api, qwenEndpoint());
    const { status, body } = await post(api, form(agreed, [clip()]));
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: "qwen-tts-vc-Mara-1", label: "Mara", gender: "?" });
    expect(q.sent).toHaveLength(1);
  });

  test("refuses a second file, a format Model Studio does not list, and a file over 10 MB", async () => {
    const q = qwenAnswering(() => Response.json({ output: { voice: "v" } }));
    const api = testApi({ cloner: q.cloner });
    await saved(api, qwenEndpoint());
    const refused = async (samples: File[]) => {
      const { status, body } = await post(api, form(agreed, samples));
      return [status, body.error?.message];
    };
    expect(await refused([clip("a.wav"), clip("b.wav")])).toEqual([
      400,
      "Use one sample: this provider makes a voice from a single file",
    ]);
    expect(await refused([clip("note.opus", HEADS.opus, "audio/ogg")])).toEqual([
      415,
      "note.opus is Opus audio, which this provider does not make a voice from",
    ]);
    expect(await refused([clip("master.flac", HEADS.flac, "audio/flac")])).toEqual([
      415,
      "master.flac is FLAC audio, which this provider does not make a voice from",
    ]);
    expect(await refused([clip("long.wav", HEADS.wav, "audio/wav", 10 * 1024 * 1024 + 1)])).toEqual(
      [413, "long.wav is larger than 10 MB, the most this provider takes for one sample"],
    );
    expect(q.sent).toEqual([]);
  });

  test("an endpoint on a Qwen-Audio model is refused as a 400, and nothing is sent", async () => {
    const q = qwenAnswering(() => Response.json({ output: { voice: "v" } }));
    const api = testApi({ cloner: q.cloner });
    await saved(api, qwenEndpoint({ model: "qwen-audio-3.0-tts-flash" }));
    const { status, body } = await post(api, form(agreed, [clip()]));
    expect(status).toBe(400);
    expect(body.error?.message).toBe(
      "Qwen VC cannot make a voice with the model qwen-audio-3.0-tts-flash; change its model to qwen3-tts-vc-2026-01-22 first",
    );
    expect(q.sent).toEqual([]);
  });
});
