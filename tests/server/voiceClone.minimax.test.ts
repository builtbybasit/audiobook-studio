// Making a voice with MiniMax: an upload, then a clone from the uploaded file.
//
// Against a `fetch` that answers from memory: the two requests as MiniMax's docs give them
// (https://platform.minimax.io/docs/guides/speech-voice-clone), the `voice_id` chosen under its
// rules, that each request goes out once whatever fails and a failed upload never reaches the
// clone, and how a refusal — MiniMax's often comes inside a 200 — reaches the page. And the route,
// which holds a MiniMax clone to its one sample and its three formats before anything is sent.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import type { ClonedVoice, Endpoint } from "@/types";
import { minimax } from "@/lib/providers/minimax";
import { clonedVoices } from "~/db/schema";
import {
  endpointVoiceCloner,
  type CloneRequest,
  type VoiceCloner,
  type VoiceClonerOptions,
} from "~/providers/clone";
import { miniMaxVoiceId } from "~/providers/speech/minimax";
import type { ProviderTarget } from "~/providers/target";
import { jsonBody, testApi, type TestApi } from "../support/server";

const target: ProviderTarget = {
  id: "minimax",
  name: "MiniMax",
  // its regional host, with the path it was saved with: the requests go to its own `/v1`
  baseUrl: "https://api.minimax.chat/v1/t2a_v2",
  model: "speech-2.8-hd",
  apiKey: "sk-minimax",
  needsKey: true,
  timeoutSec: 5,
  // what a narration endpoint is saved with: a clone must not take them
  maxRetries: 2,
  cooldownSec: 0,
};

const request: CloneRequest = {
  title: "Narrator — Mara",
  samples: [
    {
      name: "mara.m4a",
      format: "m4a",
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }),
    },
  ],
};

const signal = () => new AbortController().signal;

const ok = { base_resp: { status_code: 0, status_msg: "success" } };
const uploaded = (fileId: number | string = 223409877880882) =>
  Response.json({
    file: {
      file_id: fileId,
      bytes: 3,
      created_at: 1700469398,
      filename: "mara.m4a",
      purpose: "voice_clone",
    },
    ...ok,
  });
const cloned = () => Response.json({ input_sensitive: { type: 0 }, demo_audio: "", ...ok });

/**
 * A `fetch` that remembers each request and answers the upload with `upload` and the clone with
 * `clone`, and a cloner over it.
 */
function miniMaxAnswering(
  upload: () => Response | Promise<Response>,
  clone: (init: RequestInit) => Response | Promise<Response> = cloned,
  options: VoiceClonerOptions = {},
) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return String(url).endsWith("/files/upload") ? upload() : clone(init);
  }) as unknown as typeof globalThis.fetch;
  return { sent, cloner: endpointVoiceCloner({ fetch, backoffMs: () => 0, ...options }) };
}

/** MiniMax's rules for a `voice_id` it is asked to make a voice under. */
const VOICE_ID = /^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/;

describe("the voice id a MiniMax clone is made under", () => {
  test("is the title in plain letters, then random hex, within MiniMax's rules", () => {
    const hex = () => "0a1b2c3d4e";
    expect(miniMaxVoiceId("Narrator — Mara", hex)).toBe("Narrator-Mara-0a1b2c3d4e");
    expect(miniMaxVoiceId("Élodie d'Arc", hex)).toBe("Elodie-d-Arc-0a1b2c3d4e");
    // it must start with a letter, and never ends in `-` or `_`
    expect(miniMaxVoiceId("2nd narrator!", hex)).toBe("voice-2nd-narrator-0a1b2c3d4e");
    expect(miniMaxVoiceId("玛拉", hex)).toBe("voice-0a1b2c3d4e");
    expect(miniMaxVoiceId("A".repeat(300), hex)).toBe(`${"A".repeat(40)}-0a1b2c3d4e`);
    for (const title of ["Narrator — Mara", "Élodie", "2nd", "玛拉", "--", "a", "x".repeat(300)])
      expect(miniMaxVoiceId(title)).toMatch(VOICE_ID);
  });

  test("differs between two clones with the same title", () => {
    expect(miniMaxVoiceId("Mara")).not.toBe(miniMaxVoiceId("Mara"));
  });
});

describe("the MiniMax cloner", () => {
  test("uploads the sample for voice_clone, then clones from its file id", async () => {
    const f = miniMaxAnswering(() => uploaded());
    const voice = await f.cloner.clone(target, request, signal());
    expect(f.sent.map((s) => [s.url, s.init.method])).toEqual([
      ["https://api.minimax.chat/v1/files/upload", "POST"],
      ["https://api.minimax.chat/v1/voice_clone", "POST"],
    ]);

    // the upload: multipart, with the boundary the form's own
    const upload = new Headers(f.sent[0].init.headers);
    expect(upload.get("authorization")).toBe("Bearer sk-minimax");
    expect(upload.has("content-type")).toBe(false);
    const form = f.sent[0].init.body as FormData;
    expect([...form.keys()].sort()).toEqual(["file", "purpose"]);
    expect(form.get("purpose")).toBe("voice_clone");
    const file = form.get("file") as File;
    expect([file.name, file.size, file.type]).toEqual(["mara.m4a", 3, "audio/mp4"]);

    // the clone: JSON, the two required fields and nothing billed
    const clone = new Headers(f.sent[1].init.headers);
    expect(clone.get("authorization")).toBe("Bearer sk-minimax");
    expect(clone.get("content-type")).toBe("application/json");
    const body = JSON.parse(f.sent[1].init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["file_id", "voice_id"]);
    expect(body.file_id).toBe(223409877880882);
    expect(body.voice_id).toMatch(/^Narrator-Mara-[0-9a-f]{10}$/);

    // MiniMax answers with no id: the voice is the one it was asked to make
    expect(voice).toEqual({ id: body.voice_id as string, label: "Narrator — Mara", gender: "?" });
  });

  test("a file id past what a JavaScript number holds is sent as MiniMax wrote it", async () => {
    const big = "9223372036854775807";
    const f = miniMaxAnswering(
      () =>
        new Response(
          `{"file":{"file_id":${big},"purpose":"voice_clone"},"base_resp":{"status_code":0}}`,
          {
            headers: { "content-type": "application/json" },
          },
        ),
    );
    await f.cloner.clone(target, request, signal());
    expect(f.sent[1].init.body as string).toStartWith(`{"file_id":${big},`);
  });

  test("each request goes out once: a 5xx, a rate limit or no answer is not sent again", async () => {
    const failures: [() => Response | Promise<Response>, string][] = [
      [() => new Response("busy", { status: 503 }), "MiniMax answered 503: busy"],
      [() => new Response("slow down", { status: 429 }), "MiniMax answered 429"],
      [
        () => Promise.reject(new TypeError("connection reset")),
        "MiniMax could not be reached: connection reset",
      ],
      // a limit said inside a 200, which a line would be retried after
      [
        () => Response.json({ base_resp: { status_code: 1002, status_msg: "rate limit" } }),
        "MiniMax refused the request (1002: rate limit)",
      ],
    ];
    for (const [answer, said] of failures) {
      // the upload fails: said so, once, and the clone is never asked for
      const up = miniMaxAnswering(answer);
      await expect(up.cloner.clone(target, request, signal())).rejects.toThrow(
        `Uploading mara.m4a to MiniMax failed: ${said}`,
      );
      expect(up.sent.map((s) => s.url)).toEqual(["https://api.minimax.chat/v1/files/upload"]);

      // the clone fails: said so, and neither request goes again
      const on = miniMaxAnswering(() => uploaded(), answer);
      await expect(on.cloner.clone(target, request, signal())).rejects.toThrow(
        `mara.m4a was uploaded, but making the voice from it failed: ${said}`,
      );
      expect(on.sent.map((s) => s.url)).toEqual([
        "https://api.minimax.chat/v1/files/upload",
        "https://api.minimax.chat/v1/voice_clone",
      ]);
    }
  });

  test("a clone that outlasts its clock is not sent again", async () => {
    const f = miniMaxAnswering(
      () => uploaded(),
      (init) =>
        new Promise<Response>((_, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
        ),
      { timeoutSec: 0.05 },
    );
    await expect(f.cloner.clone(target, request, signal())).rejects.toThrow(
      "making the voice from it failed: MiniMax did not answer within 0.05 s",
    );
    expect(f.sent).toHaveLength(2);
  });

  test("a refusal inside a 200 is read out in MiniMax's own words", async () => {
    const upload = miniMaxAnswering(() =>
      Response.json({ base_resp: { status_code: 1004, status_msg: "login fail" } }),
    );
    await expect(upload.cloner.clone(target, request, signal())).rejects.toThrow(
      "Uploading mara.m4a to MiniMax failed: MiniMax refused the request (1004: login fail)",
    );
    expect(upload.sent).toHaveLength(1);

    const clone = miniMaxAnswering(
      () => uploaded(),
      () =>
        Response.json({
          base_resp: { status_code: 2038, status_msg: "no cloning permission" },
        }),
    );
    await expect(clone.cloner.clone(target, request, signal())).rejects.toThrow(
      "making the voice from it failed: MiniMax refused the request (2038: no cloning permission)",
    );
  });

  test("an answer that does not say what it should is a failure", async () => {
    const noFile = miniMaxAnswering(() => Response.json(ok));
    await expect(noFile.cloner.clone(target, request, signal())).rejects.toThrow(
      "Uploading mara.m4a to MiniMax failed: MiniMax answered without the file's id",
    );
    expect(noFile.sent).toHaveLength(1);

    const silent = miniMaxAnswering(
      () => uploaded(),
      () => new Response("", { status: 200 }),
    );
    await expect(silent.cloner.clone(target, request, signal())).rejects.toThrow(
      "without saying the voice was made",
    );
  });

  test("more than one sample is refused before any request", async () => {
    const f = miniMaxAnswering(() => uploaded());
    await expect(
      f.cloner.clone(
        target,
        { ...request, samples: [...request.samples, ...request.samples] },
        signal(),
      ),
    ).rejects.toThrow("MiniMax makes a voice from exactly one sample");
    expect(f.sent).toEqual([]);
  });
});

// ---------- the route ----------

const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
const bytes = (...parts: (string | number[])[]): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? ascii(p) : p)));

const HEADS = {
  wav: bytes("RIFF", [36, 0, 0, 0], "WAVEfmt "),
  mp3: bytes("ID3", [4, 0, 0, 0, 0, 0, 0]),
  m4a: bytes([0, 0, 0, 32], "ftypM4A ", [0, 0, 0, 0]),
  opus: bytes("OggS", [0, 2, ...Array<number>(20).fill(0), 1, 19], "OpusHead"),
  flac: bytes("fLaC", [0, 0, 0, 34]),
};

/** A file whose first bytes are `head`, padded to `size`. */
const clip = (name: string, head: Uint8Array, size = 1024) => {
  const body = new Uint8Array(Math.max(size, head.length)).fill(7);
  body.set(head);
  return new File([body], name, { type: "application/octet-stream" });
};

function form(fields: Record<string, string>, samples: File[]): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const c of samples) f.append("samples", c, c.name);
  return f;
}

const miniMaxEndpoint: Endpoint = {
  id: "minimax",
  name: "MiniMax",
  baseUrl: "https://api.minimax.io/v1",
  model: "speech-2.8-hd",
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
  apiKey: "sk-minimax",
};

async function routeWith(cloner: VoiceCloner): Promise<TestApi> {
  const api = testApi({ cloner });
  const { status } = await api.request("/api/endpoints", {
    ...jsonBody({ endpoints: [miniMaxEndpoint], profiles: [], credentials: [] }),
    method: "PUT",
  });
  expect(status).toBe(200);
  return api;
}

const post = (api: TestApi, samples: File[]) =>
  api.request<ClonedVoice & { error?: { message: string } }>("/api/endpoints/voices/clone", {
    method: "POST",
    body: form({ id: "minimax", title: "Mara", consent: "yes" }, samples),
  });

describe("a MiniMax clone, through the route", () => {
  test("MiniMax's limits are its docs': one sample of MP3, M4A or WAV, up to 20 MB", () => {
    expect(minimax.cloning).toMatchObject({
      maxSamples: 1,
      maxSampleBytes: 20 * 1024 * 1024,
      formats: ["wav", "mp3", "m4a"],
    });
  });

  test("one sample is sent, and the voice comes back", async () => {
    const f = miniMaxAnswering(() => uploaded());
    const api = await routeWith(f.cloner);
    const { status, body } = await post(api, [clip("mara.mp3", HEADS.mp3)]);
    expect(status).toBe(201);
    expect(body).toMatchObject({ label: "Mara", gender: "?", samplesKept: true });
    expect(body.id).toMatch(/^Mara-[0-9a-f]{10}$/);
    expect(f.sent).toHaveLength(2);
  });

  test("a second sample, or a format MiniMax does not take, is refused before anything is sent", async () => {
    const f = miniMaxAnswering(() => uploaded());
    const api = await routeWith(f.cloner);

    const two = await post(api, [clip("a.wav", HEADS.wav), clip("b.wav", HEADS.wav)]);
    expect([two.status, two.body.error?.message]).toEqual([
      400,
      "Use one sample: this provider makes a voice from a single file",
    ]);
    for (const [name, head, said] of [
      ["take.opus", HEADS.opus, "Opus"],
      ["take.flac", HEADS.flac, "FLAC"],
    ] as const) {
      const { status, body } = await post(api, [clip(name, head)]);
      expect([status, body.error?.message]).toEqual([
        415,
        `${name} is ${said} audio, which this provider does not make a voice from`,
      ]);
    }
    expect(f.sent).toEqual([]);
  });

  test("a refusal inside a 200 reaches the page in MiniMax's words, and nothing is kept", async () => {
    const f = miniMaxAnswering(
      () => uploaded(),
      () => Response.json({ base_resp: { status_code: 2013, status_msg: "invalid params" } }),
    );
    const api = await routeWith(f.cloner);
    const { body } = await post(api, [clip("mara.m4a", HEADS.m4a)]);
    expect(body.error?.message).toBe(
      "mara.m4a was uploaded, but making the voice from it failed: " +
        "MiniMax refused the request (2013: invalid params)",
    );
    expect(f.sent).toHaveLength(2);
    expect(readdirSync(api.voiceDir)).toEqual([]);
    expect(api.db.select().from(clonedVoices).all()).toEqual([]);
    // the key it was sent with is in neither the answer nor the log
    expect(JSON.stringify(api.logs)).not.toContain("sk-minimax");
  });
});
