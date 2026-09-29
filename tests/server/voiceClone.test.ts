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

import type { Endpoint, KeptVoiceSamples, Voice } from "@/types";
import { CLONE_CONSENT } from "@/lib/endpointShapes";
import { MAX_SAMPLE_BYTES, MAX_VOICE_SAMPLES } from "@/lib/voiceSamples";
import { SPEECH_PROVIDERS } from "@/lib/providers";
import { clonedVoices } from "~/db/schema";
import { sniffSample, type CloneRequest } from "~/providers/clone";
import { SPEECH_WIRES } from "~/providers/speech/registry";
import type { ProviderTarget } from "~/providers/target";
import { keepSampleFiles } from "~/voices/ops";
import { voiceFiles, type VoiceFiles } from "~/voices/files";
import {
  agreed,
  answering,
  cloneForm,
  HEADS,
  postClone,
  remembering,
  sampleFile,
  saved,
  speechEndpoint,
} from "../support/cloning";
import { jsonBody, tempVoiceDir, testApi, type TestApi } from "../support/server";

describe("which providers clone", () => {
  test("a provider described with cloning has a clone in its wire module, and only those", () => {
    for (const p of SPEECH_PROVIDERS)
      expect([p.id, !!p.cloning]).toEqual([
        p.id,
        p.id !== "simulated" && typeof SPEECH_WIRES[p.id].clone === "function",
      ]);
  });

  test("no provider's limits reach past the server's own", () => {
    for (const p of SPEECH_PROVIDERS) {
      if (!p.cloning) continue;
      const { maxSamples, maxSampleBytes, formats, advice } = p.cloning;
      expect([p.id, maxSamples >= 1 && maxSamples <= MAX_VOICE_SAMPLES]).toEqual([p.id, true]);
      expect([p.id, maxSampleBytes > 0 && maxSampleBytes <= MAX_SAMPLE_BYTES]).toEqual([
        p.id,
        true,
      ]);
      expect([p.id, formats.length > 0, advice.trim().length > 0]).toEqual([p.id, true, true]);
    }
  });
});

describe("what counts as a recording", () => {
  test("the formats Fish documents are known by their first bytes", () => {
    expect(sniffSample(HEADS.wav)).toBe("wav");
    expect(sniffSample(HEADS.mp3Tagged)).toBe("mp3");
    expect(sniffSample(HEADS.mp3Frame)).toBe("mp3");
    expect(sniffSample(HEADS.m4a)).toBe("m4a");
    expect(sniffSample(HEADS.m4aAndroid)).toBe("m4a");
    expect(sniffSample(HEADS.opus)).toBe("opus");
    expect(sniffSample(HEADS.flac)).toBe("flac");
  });

  test("audio Fish does not document, a picture in an MP4 box, and text are none of them", () => {
    for (const head of [HEADS.vorbis, HEADS.aac, HEADS.webm, HEADS.heic, HEADS.text])
      expect(sniffSample(head)).toBeNull();
    expect(sniffSample(new Uint8Array())).toBeNull();
  });
});

// ---------- the route ----------

describe("the clone route", () => {
  test("hands the recordings and the name to the cloner, and answers with the new voice", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    await saved(api, speechEndpoint());
    const { status, body } = await postClone(
      api,
      cloneForm({ ...agreed(), title: " Narrator — Mara " }, [
        sampleFile("a.wav"),
        sampleFile("b.mp3", HEADS.mp3Frame, "audio/mpeg", 2048),
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
    expect(asked[0].samples.map((c) => [c.name, c.blob.size, c.blob.type])).toEqual([
      ["a.wav", 1024, "audio/wav"],
      ["b.mp3", 2048, "audio/mpeg"],
    ]);
    expect(new Uint8Array(await asked[0].samples[1].blob.arrayBuffer()).subarray(0, 2)).toEqual(
      new Uint8Array([0xff, 0xfb]),
    );
  });

  test("the log line is the record that consent was given", async () => {
    const { cloner } = remembering();
    const api = testApi({ cloner });
    await saved(api, speechEndpoint());
    expect((await postClone(api, cloneForm(agreed(), [sampleFile()]))).status).toBe(201);
    const line = api.logs.find((l) => l.msg === "voice cloned");
    expect(line).toMatchObject({
      id: "fish",
      voice: "new-voice-id",
      title: "Mara",
      samples: 1,
      consent: true,
    });
  });

  test("refuses, before anything leaves, what it cannot or should not send", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    await saved(api, speechEndpoint());
    const refused = async (fields: Record<string, string>, samples: File[]) => {
      const { status, body } = await postClone(api, cloneForm(fields, samples));
      return [status, body.error?.message];
    };
    // consent is the person's say-so, and nothing goes without it
    expect(await refused({ id: "fish", title: "Mara" }, [sampleFile()])).toEqual([
      400,
      "Confirm you have the right to clone this voice",
    ]);
    expect(await refused(agreed(), [])).toEqual([400, "Add at least one sample of the voice"]);
    expect(await refused({ ...agreed(), title: "" }, [sampleFile()])).toEqual([
      400,
      "Give the voice a name of up to 100 characters",
    ]);
    expect(
      await refused(
        agreed(),
        Array.from({ length: 21 }, (_, i) => sampleFile(`t${i}.wav`)),
      ),
    ).toEqual([400, "Use at most 20 samples"]);
    expect(
      await refused(agreed(), [sampleFile("silence.wav", new Uint8Array(), "audio/wav", 0)]),
    ).toEqual([400, "silence.wav is empty"]);
    expect(asked).toEqual([]);
  });

  test("a recording is known by its bytes, not by its name or the type the browser gave it", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    await saved(api, speechEndpoint());
    const accepted = await postClone(
      api,
      cloneForm(agreed(), [
        sampleFile("memo", HEADS.m4a, "application/octet-stream"),
        sampleFile("note.opus", HEADS.opus, ""),
        sampleFile("master.flac", HEADS.flac, "audio/x-flac"),
      ]),
    );
    expect(accepted.status).toBe(201);
    expect(asked[0].samples.map((c) => c.blob.type)).toEqual([
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
      const { status, body } = await postClone(
        api,
        cloneForm(agreed(), [sampleFile(name, head, type)]),
      );
      expect([status, body.error?.message]).toEqual([
        415,
        `${name} is not audio a voice can be made from`,
      ]);
    }
    expect(asked).toHaveLength(1);
  });

  test("an endpoint that was never saved is not found", async () => {
    const { cloner, asked } = remembering();
    const api = testApi({ cloner });
    const missing = await postClone(api, cloneForm(agreed(), [sampleFile()]));
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

describe("the Fish Audio cloner", () => {
  const request: CloneRequest = {
    title: "Mara",
    samples: [
      {
        name: "a.wav",
        format: "wav",
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      },
      {
        name: "b.mp3",
        format: "mp3",
        blob: new Blob([new Uint8Array([4, 5])], { type: "audio/mpeg" }),
      },
    ],
  };
  const signal = () => new AbortController().signal;

  test("posts the multipart form Fish's docs give, private and ready at once", async () => {
    const f = answering(() =>
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
      const f = answering(answer);
      await expect(f.cloner.clone(target, request, signal())).rejects.toThrow(said);
      expect(f.sent).toHaveLength(1);
    }
  });

  test("an upload that outlasts its clock is not sent again", async () => {
    const f = answering(
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
    const noId = answering(() => Response.json({ title: "Mara" }));
    await expect(noId.cloner.clone(target, request, signal())).rejects.toThrow(
      "without the new voice's id",
    );
    const refused = answering(() => Response.json({ message: "Invalid token" }, { status: 401 }));
    await expect(refused.cloner.clone(target, request, signal())).rejects.toThrow(
      "Fish Audio answered 401: Invalid token",
    );
  });

  test("a provider that keeps no clone is refused before any request", async () => {
    const f = answering(() => Response.json({}));
    await expect(
      f.cloner.clone(
        { ...target, name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
        request,
        signal(),
      ),
    ).rejects.toThrow("OpenAI cannot make a voice from samples");
    expect(f.sent).toEqual([]);
  });
});

// ---------- Fish's answers, as the page hears them ----------

describe("a failure to clone, through the route", () => {
  /** The route with the real cloner in it, over a `fetch` that answers with `answer`. */
  async function cloningAgainst(
    answer: () => Response | Promise<Response>,
    ep: Endpoint = speechEndpoint(),
  ) {
    const f = answering(answer);
    const api = testApi({ cloner: f.cloner });
    await saved(api, ep);
    const { status, body } = await postClone(api, cloneForm(agreed(ep.id), [sampleFile()]));
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
      speechEndpoint({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" }),
    );
    expect([openai.status, openai.message]).toEqual([
      400,
      "OpenAI cannot make a voice from samples",
    ]);
    expect(openai.sent).toEqual([]);
    const keyless = await cloningAgainst(
      () => Response.json({}),
      speechEndpoint({ apiKey: undefined }),
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
  ...jsonBody({ endpoints: [speechEndpoint({ voices })], profiles: [], credentials: [] }),
  method: "PUT",
});

const made: Voice = { id: "new-voice-id", label: "Mara", gender: "?" };

/** Let the removals a save starts in the background reach the disk. */
const settled = () => new Promise((r) => setTimeout(r, 20));

describe("the recordings a voice was made from", () => {
  test("are kept byte for byte, typed by their bytes, beside the consent that was given", async () => {
    const { cloner } = remembering();
    const api = testApi({ cloner });
    await saved(api, speechEndpoint());
    const memo = sampleFile("memo", HEADS.m4a, "application/octet-stream", 3000);
    const sent = new Uint8Array(await memo.arrayBuffer());
    const said = "Mara agreed on the phone, 12 September.";
    const { body: voice } = await postClone(
      api,
      cloneForm({ ...agreed(), consentText: said }, [memo, sampleFile()]),
    );
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
    await postClone(api, cloneForm(agreed(), [sampleFile()]));
    expect((await samplesOf(api)).body.consentText).toBe(CLONE_CONSENT);
  });

  test("a voice made but not kept is still made, and the answer says so", async () => {
    const { cloner, asked } = remembering();
    // a file where the directory should be: nothing can be written under it
    const blocked = join(tempVoiceDir(), "not-a-directory");
    writeFileSync(blocked, "");
    const api = testApi({ cloner, voiceDir: blocked });
    await saved(api, speechEndpoint());
    const { status, body } = await postClone(api, cloneForm(agreed(), [sampleFile()]));
    expect([status, body.samplesKept]).toEqual([201, false]);
    expect(asked).toHaveLength(1);
    expect((await samplesOf(api)).status).toBe(404);
    expect(api.logs.some((l) => l.msg === "cloned, but the samples were not kept")).toBe(true);
  });

  test("outlast a removal the page can still undo, and go with the voice once it is final", async () => {
    const { cloner } = remembering();
    const api = testApi({ cloner });
    await saved(api, speechEndpoint());
    await postClone(api, cloneForm(agreed(), [sampleFile()]));
    const save = (voices: Voice[]) => api.request("/api/endpoints", configWith(voices));
    const aged = (set: Partial<typeof clonedVoices.$inferInsert>) =>
      api.db.update(clonedVoices).set(set).where(eq(clonedVoices.voiceId, "new-voice-id")).run();
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;

    // a save in the moment between the clone and the page adding its voice is not a removal
    expect((await save([])).status).toBe(200);
    expect((await samplesOf(api)).status).toBe(200);
    // once a save has held the voice, a save without it only marks it missing: the removal's
    // Undo, or a settings import that brings it back, finds its recordings where they were
    await save([made]);
    await save([]);
    expect((await samplesOf(api)).status).toBe(200);
    await save([made]);
    await save([]);
    await settled();
    expect(readdirSync(api.voiceDir)).toHaveLength(1);
    // a save after the grace period makes the removal final, recordings and all
    aged({ missingSince: dayAgo });
    await save([]);
    expect((await samplesOf(api)).status).toBe(404);
    await settled();
    expect(readdirSync(api.voiceDir)).toEqual([]);

    // a clone the page never saved is dropped by the first save after a day
    await postClone(api, cloneForm(agreed(), [sampleFile()]));
    aged({ madeAt: dayAgo });
    await save([]);
    expect((await samplesOf(api)).status).toBe(404);
  });

  test("a keep that fails part way takes back only the files it wrote", async () => {
    const api = testApi();
    const real = voiceFiles(api.voiceDir);
    let writes = 0;
    const failing = (at: number): VoiceFiles => ({
      ...real,
      write: (...args) => {
        if (++writes === at) return Promise.reject(new Error("disk full"));
        return real.write(...args);
      },
    });
    const keep = (files: VoiceFiles, samples: File[]) =>
      keepSampleFiles(api.db, files, {
        endpointId: "fish",
        voiceId: "v",
        title: "Mara",
        consentText: CLONE_CONSENT,
        attached: true,
        samples: samples.map((c) => ({ name: c.name, blob: c, format: "wav" as const })),
      });
    const a = sampleFile("a.wav", HEADS.wav, "audio/wav", 1500);
    const b = sampleFile("b.wav", HEADS.wav, "audio/wav", 1600);
    const c = sampleFile("c.wav", HEADS.wav, "audio/wav", 1700);
    await keep(real, [a]);
    const onDisk = () => readdirSync(join(api.voiceDir, readdirSync(api.voiceDir)[0])).sort();
    const kept = onDisk();

    // a is written again (its row already names it, so it stays), b is written, c fails
    writes = 0;
    await expect(keep(failing(3), [a, b, c])).rejects.toThrow("disk full");
    await settled();
    expect(onDisk()).toEqual(kept);
    expect((await samplesOf(api, "v")).body.samples.map((s) => s.name)).toEqual(["a.wav"]);
  });

  test("an older voice can be given its recordings, under the same consent and limits", async () => {
    const api = testApi();
    const old: Voice = { id: "old-voice", label: "Old Tomas", gender: "m" };
    await saved(api, speechEndpoint({ voices: [old] }));
    const keep = (fields: Record<string, string>, samples: File[], voice = "old-voice") =>
      api.request<KeptVoiceSamples & { error?: { message: string } }>(
        `/api/endpoints/fish/voices/${voice}/samples`,
        { method: "POST", body: cloneForm(fields, samples) },
      );

    expect((await keep({}, [sampleFile()])).body.error?.message).toBe(
      "Confirm you have the right to clone this voice",
    );
    const tooMany = Array.from({ length: 21 }, (_, i) => sampleFile(`t${i}.wav`));
    expect((await keep({ consent: "yes" }, tooMany)).body.error?.message).toBe(
      "Use at most 20 samples",
    );
    expect((await keep({ consent: "yes" }, [sampleFile()], "nobody")).status).toBe(404);

    const first = await keep({ consent: "yes" }, [
      sampleFile("a.wav", HEADS.wav, "audio/wav", 1500),
    ]);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ voiceId: "old-voice", title: "Old Tomas" });
    // kept for a voice already saved: the next save without it takes them
    const replaced = await keep({ consent: "yes" }, [
      sampleFile("b.mp3", HEADS.mp3Frame, "audio/mpeg"),
    ]);
    expect(replaced.body.samples.map((s) => s.name)).toEqual(["b.mp3"]);
    await settled();
    expect(readdirSync(join(api.voiceDir, readdirSync(api.voiceDir)[0]))).toEqual([
      replaced.body.samples[0].file,
    ]);

    for (const bad of ["..%2F..%2Fsecret.wav", "abc.wav", `${"0".repeat(32)}.exe`])
      expect((await api.fetch(`/api/endpoints/fish/voices/old-voice/samples/${bad}`)).status).toBe(
        404,
      );

    const forget = () =>
      api.request("/api/endpoints/fish/voices/old-voice/samples", { method: "DELETE" });
    const restore = () =>
      api.request<KeptVoiceSamples>("/api/endpoints/fish/voices/old-voice/samples/restore", {
        method: "POST",
      });
    expect(await forget()).toEqual({ status: 200, body: { voiceId: "old-voice" } });
    expect((await samplesOf(api, "old-voice")).status).toBe(404);
    // forgetting is hidden, not gone: its Undo brings the recordings back as they were
    const back = await restore();
    expect([back.status, back.body.samples]).toEqual([200, replaced.body.samples]);
    expect((await restore()).status).toBe(404);
    // and a save after the grace period makes a forget final
    await forget();
    api.db
      .update(clonedVoices)
      .set({ forgottenAt: Date.now() - 25 * 60 * 60 * 1000 })
      .where(eq(clonedVoices.voiceId, "old-voice"))
      .run();
    await api.request("/api/endpoints", {
      ...jsonBody({
        endpoints: [speechEndpoint({ voices: [old] })],
        profiles: [],
        credentials: [],
      }),
      method: "PUT",
    });
    expect((await restore()).status).toBe(404);
    await settled();
    expect(readdirSync(api.voiceDir)).toEqual([]);
    // and the voice itself stays
    expect(
      (await api.request<{ endpoints: Endpoint[] }>("/api/endpoints")).body.endpoints[0].voices,
    ).toEqual([old]);
  });
});
