// Making a voice from recordings: `POST /api/endpoints/voices/clone`, and keeping the recordings
// it was made from under `/api/endpoints/:id/voices/:voice/samples`.
//
// Four parts. What counts as a recording, read from a file's first bytes. The route, with a cloner
// that answers from memory: what it refuses before anything leaves — no consent, no recordings,
// something that is not a recording — what it hands the cloner, and what it logs. And the real
// cloner, against a `fetch` that answers from memory: the multipart request Fish Audio's docs give,
// that it goes out once whatever fails, and how Fish's refusals reach the page. And the recordings
// kept after a clone: byte for byte, beside the consent, and gone with the voice they made.
import { describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import type { ClonedVoice, Endpoint, KeptVoiceSamples, Voice } from "@/types";
import { CLONE_CONSENT } from "@/lib/endpointShapes";
import { clonedVoices } from "~/db/schema";
import {
  endpointVoiceCloner,
  sniffRecording,
  type CloneRequest,
  type VoiceCloner,
  type VoiceClonerOptions,
} from "~/providers/clone";
import type { ProviderTarget } from "~/providers/target";
import { jsonBody, tempVoiceDir, testApi, type TestApi } from "../support/server";

const fishEndpoint = (over: Partial<Endpoint> = {}): Endpoint => ({
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

// ---------- the first bytes of each kind of file ----------

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
const bytes = (...parts: (string | number[])[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? ascii(p) : p)));

/** An Ogg stream's first page, one segment long, whose packet starts with `packet`. */
const oggPage = (packet: string | number[]) =>
  bytes("OggS", [0, 2, ...Array<number>(20).fill(0), 1, 19], packet);

const HEADS = {
  wav: bytes("RIFF", [36, 0, 0, 0], "WAVEfmt "),
  mp3Tagged: bytes("ID3", [4, 0, 0, 0, 0, 0, 0]),
  mp3Frame: bytes([0xff, 0xfb, 0x90, 0x64]),
  m4a: bytes([0, 0, 0, 32], "ftypM4A ", [0, 0, 0, 0]),
  m4aAndroid: bytes([0, 0, 0, 24], "ftypisom", [0, 0, 2, 0]),
  opus: oggPage("OpusHead"),
  flac: bytes("fLaC", [0, 0, 0, 34]),
  // and what is none of those
  vorbis: oggPage([1, ...ascii("vorbis")]),
  aac: bytes([0xff, 0xf1, 0x50, 0x80]),
  webm: bytes([0x1a, 0x45, 0xdf, 0xa3]),
  heic: bytes([0, 0, 0, 24], "ftypheic", [0, 0, 0, 0]),
  text: bytes("Hello, this is not audio."),
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

describe("what counts as a recording", () => {
  test("the formats Fish documents are known by their first bytes", () => {
    expect(sniffRecording(HEADS.wav)).toBe("wav");
    expect(sniffRecording(HEADS.mp3Tagged)).toBe("mp3");
    expect(sniffRecording(HEADS.mp3Frame)).toBe("mp3");
    expect(sniffRecording(HEADS.m4a)).toBe("m4a");
    expect(sniffRecording(HEADS.m4aAndroid)).toBe("m4a");
    expect(sniffRecording(HEADS.opus)).toBe("opus");
    expect(sniffRecording(HEADS.flac)).toBe("flac");
  });

  test("audio Fish does not document, a picture in an MP4 box, and text are none of them", () => {
    for (const head of [HEADS.vorbis, HEADS.aac, HEADS.webm, HEADS.heic, HEADS.text])
      expect(sniffRecording(head)).toBeNull();
    expect(sniffRecording(new Uint8Array())).toBeNull();
  });
});

// ---------- the route ----------

/** A cloner that remembers what it was asked and answers with a voice. */
function remembering(): { cloner: VoiceCloner; asked: CloneRequest[] } {
  const asked: CloneRequest[] = [];
  return {
    asked,
    cloner: {
      async clone(_target, request) {
        asked.push(request);
        return { id: "new-voice-id", label: request.title, gender: "?" };
      },
    },
  };
}

async function saved(api: TestApi, ep: Endpoint): Promise<void> {
  const { status } = await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [ep], profiles: [], credentials: [] }),
    method: "PUT",
  });
  expect(status).toBe(200);
}

function form(fields: Record<string, string>, clips: File[]): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const c of clips) f.append("clips", c, c.name);
  return f;
}

const post = (api: TestApi, body: FormData) =>
  api.request<ClonedVoice & { error?: { message: string } }>("/api/endpoints/voices/clone", {
    method: "POST",
    body,
  });

const agreed = { id: "fish", title: "Mara", consent: "yes" };

describe("the clone route", () => {
  test("hands the recordings and the name to the cloner, and answers with the new voice", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    await saved(api, fishEndpoint());
    const { status, body } = await post(
      api,
      form({ ...agreed, title: " Narrator — Mara " }, [
        clip("a.wav"),
        clip("b.mp3", HEADS.mp3Frame, "audio/mpeg", 2048),
      ]),
    );
    expect(status).toBe(201);
    expect(body).toEqual({
      id: "new-voice-id",
      label: "Narrator — Mara",
      gender: "?",
      samplesKept: true,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].title).toBe("Narrator — Mara");
    // the files as sent, typed by what their bytes say
    expect(asked[0].clips.map((c) => [c.name, c.blob.size, c.blob.type])).toEqual([
      ["a.wav", 1024, "audio/wav"],
      ["b.mp3", 2048, "audio/mpeg"],
    ]);
    expect(new Uint8Array(await asked[0].clips[1].blob.arrayBuffer()).subarray(0, 2)).toEqual(
      new Uint8Array([0xff, 0xfb]),
    );
  });

  test("the log line is the record that consent was given", async () => {
    const { cloner } = remembering();
    const api = testApi({ cloner });
    await saved(api, fishEndpoint());
    expect((await post(api, form(agreed, [clip()]))).status).toBe(201);
    const line = api.logs.find((l) => l.msg === "voice cloned");
    expect(line).toMatchObject({
      id: "fish",
      voice: "new-voice-id",
      title: "Mara",
      clips: 1,
      consent: true,
    });
  });

  test("refuses, before anything leaves, what it cannot or should not send", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    await saved(api, fishEndpoint());
    const refused = async (fields: Record<string, string>, clips: File[]) => {
      const { status, body } = await post(api, form(fields, clips));
      return [status, body.error?.message];
    };
    // consent is the person's say-so, and nothing goes without it
    expect(await refused({ id: "fish", title: "Mara" }, [clip()])).toEqual([
      400,
      "Confirm you have the right to clone this voice",
    ]);
    expect(await refused(agreed, [])).toEqual([400, "Add at least one recording of the voice"]);
    expect(await refused({ ...agreed, title: "" }, [clip()])).toEqual([
      400,
      "Give the voice a name of up to 100 characters",
    ]);
    expect(
      await refused(
        agreed,
        Array.from({ length: 21 }, (_, i) => clip(`t${i}.wav`)),
      ),
    ).toEqual([400, "Use at most 20 recordings"]);
    // Bun's form parser drops an empty file's name
    expect(await refused(agreed, [clip("silence.wav", new Uint8Array(), "audio/wav", 0)])).toEqual([
      400,
      "One of the recordings is empty",
    ]);
    expect(asked).toEqual([]);
  });

  test("a recording is known by its bytes, not by its name or the type the browser gave it", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    await saved(api, fishEndpoint());
    const accepted = await post(
      api,
      form(agreed, [
        clip("memo", HEADS.m4a, "application/octet-stream"),
        clip("note.opus", HEADS.opus, ""),
        clip("master.flac", HEADS.flac, "audio/x-flac"),
      ]),
    );
    expect(accepted.status).toBe(201);
    expect(asked[0].clips.map((c) => c.blob.type)).toEqual([
      "audio/mp4",
      "audio/ogg",
      "audio/flac",
    ]);

    for (const [name, head, type] of [
      ["take.wav", HEADS.text, "audio/wav"],
      ["take.ogg", HEADS.vorbis, "audio/ogg"],
      ["take.aac", HEADS.aac, "audio/aac"],
      ["take.webm", HEADS.webm, "audio/webm"],
    ] as const) {
      const { status, body } = await post(api, form(agreed, [clip(name, head, type)]));
      expect([status, body.error?.message]).toEqual([
        415,
        `${name} is not a recording Fish can make a voice from`,
      ]);
    }
    expect(asked).toHaveLength(1);
  });

  test("an endpoint that was never saved is not found", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    const missing = await post(api, form(agreed, [clip()]));
    expect(missing.status).toBe(404);
    expect(asked).toEqual([]);
  });
});

// ---------- the Fish Audio cloner ----------

const target: ProviderTarget = {
  id: "fish",
  name: "Fish Audio",
  baseUrl: "https://api.fish.audio/v1",
  model: "s2.1-pro",
  apiKey: "sk-fish",
  needsKey: true,
  timeoutSec: 5,
  // what a narration endpoint is saved with: the upload must not take them
  maxRetries: 2,
  cooldownSec: 0,
};

/** A `fetch` that remembers each request and answers it with `answer`, and a cloner over it. */
function fishAnswering(
  answer: (init: RequestInit) => Response | Promise<Response>,
  options: VoiceClonerOptions = {},
) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return answer(init);
  }) as unknown as typeof globalThis.fetch;
  return { sent, cloner: endpointVoiceCloner({ fetch, backoffMs: () => 0, ...options }) };
}

describe("the Fish Audio cloner", () => {
  const request: CloneRequest = {
    title: "Mara",
    clips: [
      { name: "a.wav", blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }) },
      { name: "b.mp3", blob: new Blob([new Uint8Array([4, 5])], { type: "audio/mpeg" }) },
    ],
  };
  const signal = () => new AbortController().signal;

  test("posts the multipart form Fish's docs give, private and ready at once", async () => {
    const f = fishAnswering(() =>
      Response.json({ _id: "a1b2c3", title: "Mara", type: "tts" }, { status: 201 }),
    );
    const voice = await f.cloner.clone(target, request, signal());
    expect(voice).toEqual({ id: "a1b2c3", label: "Mara", gender: "?" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].url).toBe("https://api.fish.audio/model");
    const headers = new Headers(f.sent[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-fish");
    // the boundary is the form's own: no JSON content type is forced onto it
    expect(headers.has("content-type")).toBe(false);
    const body = f.sent[0].init.body as FormData;
    expect([
      body.get("type"),
      body.get("title"),
      body.get("train_mode"),
      body.get("visibility"),
    ]).toEqual(["tts", "Mara", "fast", "private"]);
    const voices = body.getAll("voices") as File[];
    expect(voices.map((v) => [v.name, v.size, v.type])).toEqual([
      ["a.wav", 3, "audio/wav"],
      ["b.mp3", 2, "audio/mpeg"],
    ]);
  });

  test("an upload goes out once: a 5xx, a rate limit or no answer is not sent again", async () => {
    const failures: [string, () => Response | Promise<Response>, string][] = [
      ["503", () => new Response("busy", { status: 503 }), "Fish Audio answered 503: busy"],
      ["429", () => new Response("slow down", { status: 429 }), "Fish Audio answered 429"],
      [
        "unreachable",
        () => Promise.reject(new TypeError("connection reset")),
        "Fish Audio could not be reached: connection reset",
      ],
    ];
    for (const [, answer, said] of failures) {
      const f = fishAnswering(answer);
      await expect(f.cloner.clone(target, request, signal())).rejects.toThrow(said);
      expect(f.sent).toHaveLength(1);
    }
  });

  test("an upload that outlasts its clock is not sent again", async () => {
    const f = fishAnswering(
      (init) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
        ),
      { timeoutSec: 0.05 },
    );
    await expect(f.cloner.clone(target, request, signal())).rejects.toThrow(
      "Fish Audio did not answer within 0.05 s",
    );
    expect(f.sent).toHaveLength(1);
  });

  test("an answer without the new voice's id is a failure, and a refusal is read out", async () => {
    const noId = fishAnswering(() => Response.json({ title: "Mara" }));
    await expect(noId.cloner.clone(target, request, signal())).rejects.toThrow(
      "without the new voice's id",
    );
    const refused = fishAnswering(() =>
      Response.json({ message: "Invalid token" }, { status: 401 }),
    );
    await expect(refused.cloner.clone(target, request, signal())).rejects.toThrow(
      "Fish Audio answered 401: Invalid token",
    );
  });

  test("a provider that keeps no clone is refused before any request", async () => {
    const f = fishAnswering(() => Response.json({}));
    await expect(
      f.cloner.clone(
        { ...target, name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
        request,
        signal(),
      ),
    ).rejects.toThrow("only Fish Audio can");
    expect(f.sent).toEqual([]);
  });
});

// ---------- Fish's answers, as the page hears them ----------

describe("a failure to clone, through the route", () => {
  /** The route with the real cloner in it, over a `fetch` that answers with `answer`. */
  async function cloningAgainst(
    answer: () => Response | Promise<Response>,
    ep: Endpoint = fishEndpoint(),
  ) {
    const f = fishAnswering(answer);
    const api = testApi({ cloner: f.cloner });
    await saved(api, ep);
    const { status, body } = await post(api, form({ ...agreed, id: ep.id }, [clip()]));
    return { status, message: body.error?.message ?? "", sent: f.sent, api };
  }
  /** A failed clone keeps nothing: no row, and not a byte on disk. */
  const keptNothing = async (api: TestApi) => {
    expect(readdirSync(api.voiceDir)).toEqual([]);
    expect(api.db.select().from(clonedVoices).all()).toEqual([]);
  };

  test("what Fish refuses as the request's is a 400 carrying Fish's own words", async () => {
    const bad = await cloningAgainst(() =>
      Response.json({ message: "Audio too short" }, { status: 400 }),
    );
    expect([bad.status, bad.message]).toEqual([400, "Fish Audio answered 400: Audio too short"]);
    const key = await cloningAgainst(() =>
      Response.json({ message: "Invalid token" }, { status: 401 }),
    );
    expect([key.status, key.message]).toEqual([400, "Fish Audio answered 401: Invalid token"]);
    // and the key it was sent with is in neither the answer nor the log
    expect(key.message).not.toContain("sk-fish");
    expect(JSON.stringify(key.api.logs)).not.toContain("sk-fish");
  });

  test("a rate limit, a fault on Fish's side or no answer at all is Fish's, a 502", async () => {
    for (const answer of [
      () => new Response("slow down", { status: 429 }),
      () => new Response("timeout", { status: 408 }),
      () => new Response("oops", { status: 500 }),
      () => Promise.reject(new TypeError("connection reset")),
      () => Response.json({ title: "no id" }),
    ]) {
      const { status, sent, api } = await cloningAgainst(answer);
      expect(status).toBe(502);
      expect(sent).toHaveLength(1);
      await keptNothing(api);
    }
  });

  test("what cannot be asked at all is a 400, and nothing is sent", async () => {
    const openai = await cloningAgainst(
      () => Response.json({}),
      fishEndpoint({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" }),
    );
    expect([openai.status, openai.message]).toEqual([
      400,
      "OpenAI cannot make a voice from recordings; only Fish Audio can, so far",
    ]);
    expect(openai.sent).toEqual([]);
    const keyless = await cloningAgainst(
      () => Response.json({}),
      fishEndpoint({ apiKey: undefined }),
    );
    expect(keyless.status).toBe(400);
    expect(keyless.message).toContain("needs an API key");
    expect(keyless.sent).toEqual([]);
  });
});

// ---------- the recordings, kept ----------

const samplesOf = (api: TestApi, voice = "new-voice-id", ep = "fish") =>
  api.request<KeptVoiceSamples & { error?: { message: string } }>(
    `/api/endpoints/${ep}/voices/${voice}/samples`,
  );

const configWith = (voices: Voice[]) => ({
  ...jsonBody({ endpoints: [fishEndpoint({ voices })], profiles: [], credentials: [] }),
  method: "PUT",
});

const made: Voice = { id: "new-voice-id", label: "Mara", gender: "?" };

/** Let the removals a save starts in the background reach the disk. */
const settled = () => new Promise((r) => setTimeout(r, 20));

describe("the recordings a voice was made from", () => {
  test("are kept byte for byte, typed by their bytes, beside the consent that was given", async () => {
    const { cloner } = remembering();
    const api = testApi({ cloner });
    await saved(api, fishEndpoint());
    const memo = clip("memo", HEADS.m4a, "application/octet-stream", 3000);
    const sent = new Uint8Array(await memo.arrayBuffer());
    const said = "Mara agreed on the phone, 12 September.";
    const { body: voice } = await post(api, form({ ...agreed, consentText: said }, [memo, clip()]));
    expect(voice.samplesKept).toBe(true);

    const { status, body: kept } = await samplesOf(api);
    expect(status).toBe(200);
    expect(kept).toMatchObject({ voiceId: "new-voice-id", title: "Mara", consentText: said });
    expect(kept.consentAt).toBeGreaterThan(0);
    expect(kept.samples.map((s) => [s.name, s.format, s.bytes])).toEqual([
      ["memo", "m4a", 3000],
      ["take-1.wav", "wav", 1024],
    ]);

    const res = await api.fetch(
      `/api/endpoints/fish/voices/new-voice-id/samples/${kept.samples[0].file}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mp4");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(sent);

    // a form that sends no sentence is held to the one the Voices tab shows
    await post(api, form(agreed, [clip()]));
    expect((await samplesOf(api)).body.consentText).toBe(CLONE_CONSENT);
  });

  test("a voice made but not kept is still made, and the answer says so", async () => {
    const { cloner, asked } = remembering();
    // a file where the directory should be: nothing can be written under it
    const blocked = join(tempVoiceDir(), "not-a-directory");
    writeFileSync(blocked, "");
    const api = testApi({ cloner, voiceDir: blocked });
    await saved(api, fishEndpoint());
    const { status, body } = await post(api, form(agreed, [clip()]));
    expect([status, body.samplesKept]).toEqual([201, false]);
    expect(asked).toHaveLength(1);
    expect((await samplesOf(api)).status).toBe(404);
    expect(api.logs.some((l) => l.msg === "cloned, but the recordings were not kept")).toBe(true);
  });

  test("go with the voice when a save leaves it out, but not before the page has saved it", async () => {
    const { cloner } = remembering();
    const api = testApi({ cloner });
    await saved(api, fishEndpoint());
    await post(api, form(agreed, [clip()]));

    // a save in the moment between the clone and the page adding its voice is not a removal
    expect((await api.request("/api/endpoints", configWith([]))).status).toBe(200);
    expect((await samplesOf(api)).status).toBe(200);
    // once a save has held the voice, a save without it takes the recordings too
    await api.request("/api/endpoints", configWith([made]));
    await api.request("/api/endpoints", configWith([]));
    expect((await samplesOf(api)).status).toBe(404);
    await settled();
    expect(readdirSync(api.voiceDir)).toEqual([]);

    // a clone the page never saved is dropped by the first save after a day
    await post(api, form(agreed, [clip()]));
    api.db
      .update(clonedVoices)
      .set({ madeAt: Date.now() - 25 * 60 * 60 * 1000 })
      .where(eq(clonedVoices.voiceId, "new-voice-id"))
      .run();
    await api.request("/api/endpoints", configWith([]));
    expect((await samplesOf(api)).status).toBe(404);
  });

  test("an older voice can be given its recordings, under the same consent and limits", async () => {
    const api = testApi();
    const old: Voice = { id: "old-voice", label: "Old Tomas", gender: "m" };
    await saved(api, fishEndpoint({ voices: [old] }));
    const keep = (fields: Record<string, string>, clips: File[], voice = "old-voice") =>
      api.request<KeptVoiceSamples & { error?: { message: string } }>(
        `/api/endpoints/fish/voices/${voice}/samples`,
        { method: "POST", body: form(fields, clips) },
      );

    expect((await keep({}, [clip()])).body.error?.message).toBe(
      "Confirm you have the right to clone this voice",
    );
    const tooMany = Array.from({ length: 21 }, (_, i) => clip(`t${i}.wav`));
    expect((await keep({ consent: "yes" }, tooMany)).body.error?.message).toBe(
      "Use at most 20 recordings",
    );
    expect((await keep({ consent: "yes" }, [clip()], "nobody")).status).toBe(404);

    const first = await keep({ consent: "yes" }, [clip("a.wav", HEADS.wav, "audio/wav", 1500)]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ voiceId: "old-voice", title: "Old Tomas" });
    // kept for a voice already saved: the next save without it takes them
    const replaced = await keep({ consent: "yes" }, [clip("b.mp3", HEADS.mp3Frame, "audio/mpeg")]);
    expect(replaced.body.samples.map((s) => s.name)).toEqual(["b.mp3"]);
    await settled();
    expect(readdirSync(join(api.voiceDir, readdirSync(api.voiceDir)[0]))).toEqual([
      replaced.body.samples[0].file,
    ]);

    for (const bad of ["..%2F..%2Fsecret.wav", "abc.wav", `${"0".repeat(32)}.exe`])
      expect((await api.fetch(`/api/endpoints/fish/voices/old-voice/samples/${bad}`)).status).toBe(
        404,
      );

    expect(
      (await api.fetch("/api/endpoints/fish/voices/old-voice/samples", { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect((await samplesOf(api, "old-voice")).status).toBe(404);
    await settled();
    expect(readdirSync(api.voiceDir)).toEqual([]);
    // and the voice itself stays
    expect(
      (await api.request<{ endpoints: Endpoint[] }>("/api/endpoints")).body.endpoints[0].voices,
    ).toEqual([old]);
  });
});
