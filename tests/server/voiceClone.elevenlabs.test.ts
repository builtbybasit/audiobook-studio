// Making a voice from recordings on ElevenLabs, and on BreezeBlue, which copies ElevenLabs' shape
// but clones in two requests of its own.
//
// Each cloner against a `fetch` that answers from memory: the request each provider's docs give,
// the answer read into a voice, that every request goes out once whatever fails, and how a refusal
// reads. And the route in front of them: what each provider does not take is refused before
// anything is sent. Fish's cloner, and the route's own rules, are `voiceClone.test.ts`'s.
import { describe, expect, test } from "bun:test";

import type { Endpoint } from "@/types";
import type { CloneRequest } from "~/providers/clone";
import type { ProviderTarget } from "~/providers/target";
import {
  agreed,
  answering,
  cloneForm,
  cloneTarget,
  HEADS,
  postClone,
  sampleFile,
  saved,
  cloneEndpoint,
  unlucky,
} from "../support/cloning";
import { testApi } from "../support/server";

const endpoint = (over: Partial<Endpoint>): Endpoint =>
  cloneEndpoint({
    id: "elevenlabs",
    name: "ElevenLabs",
    baseUrl: "https://api.elevenlabs.io/v1",
    model: "eleven_multilingual_v2",
    apiKey: "sk-eleven",
    ...over,
  });

const target = (over: Partial<ProviderTarget> = {}): ProviderTarget =>
  cloneTarget({
    id: "elevenlabs",
    name: "ElevenLabs",
    baseUrl: "https://api.elevenlabs.io/v1",
    model: "eleven_multilingual_v2",
    apiKey: "sk-eleven",
    ...over,
  });

const breeze = (over: Partial<ProviderTarget> = {}): ProviderTarget =>
  target({
    id: "breezeblue",
    name: "BreezeBlue",
    baseUrl: "https://api.breeze.blue/v1",
    model: "breeze-tts-2",
    apiKey: "sk-breeze",
    ...over,
  });

const signal = () => new AbortController().signal;

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

// ---------- ElevenLabs ----------

describe("the ElevenLabs cloner", () => {
  test("posts the multipart form its Instant Voice Cloning reference gives", async () => {
    const f = answering(() =>
      Response.json({ voice_id: "c38kUX8pkfYO2kHyqfFy", requires_verification: false }),
    );
    const voice = await f.cloner.clone(target(), request, signal());
    expect(voice).toEqual({ id: "c38kUX8pkfYO2kHyqfFy", label: "Mara", gender: "?" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].url).toBe("https://api.elevenlabs.io/v1/voices/add");
    expect(f.sent[0].init.method).toBe("POST");
    const headers = new Headers(f.sent[0].init.headers);
    expect(headers.get("xi-api-key")).toBe("sk-eleven");
    expect(headers.has("authorization")).toBe(false);
    // the boundary is the form's own: no JSON content type is forced onto it
    expect(headers.has("content-type")).toBe(false);
    const body = f.sent[0].init.body as FormData;
    // the name and the files, and nothing it was not asked for: no noise removal, no labels
    expect([...new Set(body.keys())].sort()).toEqual(["files", "name"]);
    expect(body.get("name")).toBe("Mara");
    const files = body.getAll("files") as File[];
    expect(files.map((v) => [v.name, v.size, v.type])).toEqual([
      ["a.wav", 3, "audio/wav"],
      ["b.mp3", 2, "audio/mpeg"],
    ]);
  });

  test("a voice ElevenLabs must verify first is kept, and says so beside its name", async () => {
    const f = answering(() => Response.json({ voice_id: "v1", requires_verification: true }));
    expect(await f.cloner.clone(target(), request, signal())).toEqual({
      id: "v1",
      label: "Mara",
      gender: "?",
      warning: "Verify this voice on ElevenLabs before a line is spoken with it.",
    });
  });

  test("the base URL's path is not ElevenLabs': the API's own root is", async () => {
    const f = answering(() => Response.json({ voice_id: "v1", requires_verification: false }));
    await f.cloner.clone(
      target({ baseUrl: "https://api.eu.residency.elevenlabs.io/v1/text-to-speech" }),
      request,
      signal(),
    );
    expect(f.sent[0].url).toBe("https://api.eu.residency.elevenlabs.io/v1/voices/add");
  });

  test("an upload goes out once: a 5xx, a rate limit or no answer is not sent again", async () => {
    for (const [answer, said] of unlucky("ElevenLabs")) {
      const f = answering(answer);
      await expect(f.cloner.clone(target(), request, signal())).rejects.toThrow(said);
      expect(f.sent).toHaveLength(1);
    }
  });

  test("a refusal is read out in ElevenLabs' words, and an answer without an id fails", async () => {
    const refused = answering(() =>
      Response.json(
        {
          detail: {
            status: "voice_limit_reached",
            message: "You have reached your maximum amount of custom voices",
          },
        },
        { status: 400 },
      ),
    );
    await expect(refused.cloner.clone(target(), request, signal())).rejects.toThrow(
      "ElevenLabs answered 400: You have reached your maximum amount of custom voices",
    );
    const invalid = answering(() =>
      Response.json(
        { detail: [{ loc: ["body", "files"], msg: "Field required", type: "missing" }] },
        { status: 422 },
      ),
    );
    await expect(invalid.cloner.clone(target(), request, signal())).rejects.toThrow(
      "ElevenLabs answered 422: Field required",
    );
    for (const answer of [
      () => Response.json({ requires_verification: false }),
      () => Response.json({ voice_id: "" }),
      () => new Response("not json"),
    ]) {
      const noId = answering(answer);
      await expect(noId.cloner.clone(target(), request, signal())).rejects.toThrow(
        "ElevenLabs answered 200 without the new voice's id",
      );
    }
  });
});

// ---------- BreezeBlue ----------

describe("the BreezeBlue cloner", () => {
  const one: CloneRequest = { title: "Mara", samples: [request.samples[0]] };
  const previewed = () =>
    Response.json({ generated_voice_id: "gvi_01hpreview", requires_verification: false });
  const savedVoice = () =>
    Response.json({ voice_id: "voice_42", name: "Mara", gender: "female", language_code: "en" });

  test("makes a preview from the one sample, then saves it, as its voice-clone guide gives", async () => {
    const f = answering((_, n) => (n === 1 ? previewed() : savedVoice()));
    const voice = await f.cloner.clone(breeze(), one, signal());
    expect(voice).toEqual({ id: "voice_42", label: "Mara", gender: "f" });
    expect(f.sent.map((s) => [s.init.method, s.url])).toEqual([
      ["POST", "https://api.breeze.blue/v1/voice-previews/clone"],
      ["POST", "https://api.breeze.blue/v1/voice-previews/gvi_01hpreview/save"],
    ]);

    const upload = new Headers(f.sent[0].init.headers);
    expect(upload.get("xi-api-key")).toBe("sk-breeze");
    expect(upload.has("content-type")).toBe(false);
    const body = f.sent[0].init.body as FormData;
    expect([...new Set(body.keys())].sort()).toEqual(["files", "name"]);
    expect(body.get("name")).toBe("Mara");
    expect((body.getAll("files") as File[]).map((v) => [v.name, v.size, v.type])).toEqual([
      ["a.wav", 3, "audio/wav"],
    ]);

    const save = new Headers(f.sent[1].init.headers);
    expect([save.get("xi-api-key"), save.get("content-type")]).toEqual([
      "sk-breeze",
      "application/json",
    ]);
    // the language is required, and this app's books are English
    expect(JSON.parse(String(f.sent[1].init.body))).toEqual({
      voice_name: "Mara",
      language_code: "en",
    });
  });

  test("a name longer than BreezeBlue takes is refused before anything is paid for", async () => {
    const f = answering(() => previewed());
    await expect(
      f.cloner.clone(breeze(), { ...one, title: "M".repeat(81) }, signal()),
    ).rejects.toThrow("BreezeBlue takes a voice name of up to 80 characters");
    expect(f.sent).toEqual([]);
  });

  test("each request goes out once, and a preview that fails is not saved", async () => {
    for (const [answer, said] of unlucky("BreezeBlue")) {
      const f = answering(answer);
      await expect(f.cloner.clone(breeze(), one, signal())).rejects.toThrow(said);
      expect(f.sent).toHaveLength(1);
    }
    const noId = answering(() => Response.json({ requires_verification: false }));
    await expect(noId.cloner.clone(breeze(), one, signal())).rejects.toThrow(
      "BreezeBlue answered 200 without the new voice's preview id",
    );
    expect(noId.sent).toHaveLength(1);
  });

  test("a save that fails says the preview was made and paid for, and which it is", async () => {
    const mismatch = answering((_, n) =>
      n === 1
        ? previewed()
        : Response.json(
            {
              ok: false,
              code: "VOICE_CLONE_REFERENCE_LANGUAGE_MISMATCH",
              detail: "The requested language does not match the language detected.",
              error: "The requested language does not match the language detected.",
            },
            { status: 422 },
          ),
    );
    const refused = mismatch.cloner.clone(breeze(), one, signal());
    await expect(refused).rejects.toThrow(
      "BreezeBlue made the voice's preview (gvi_01hpreview) but did not save it: " +
        "BreezeBlue answered 422: The requested language does not match the language detected. " +
        "The preview is paid for; save it on BreezeBlue rather than cloning again.",
    );
    await expect(refused).rejects.toMatchObject({ status: 422 });
    expect(mismatch.sent).toHaveLength(2);

    for (const [answer, said] of unlucky("BreezeBlue")) {
      const f = answering((_, n) => (n === 1 ? previewed() : answer()));
      await expect(f.cloner.clone(breeze(), one, signal())).rejects.toThrow(said);
      expect(f.sent).toHaveLength(2);
    }
    const unsaved = answering((_, n) => (n === 1 ? previewed() : Response.json({ name: "Mara" })));
    await expect(unsaved.cloner.clone(breeze(), one, signal())).rejects.toThrow(
      "did not save it: it answered 200 without the saved voice's id",
    );
  });
});

// ---------- through the route ----------

describe("what each provider takes, through the route", () => {
  async function cloning(
    ep: Endpoint,
    samples: File[],
    answer: (init: RequestInit, n: number) => Response,
  ) {
    const f = answering(answer);
    const api = testApi({ cloner: f.cloner });
    await saved(api, ep);
    const { status, body } = await postClone(api, cloneForm(agreed(ep.id), samples));
    return { status, message: body.error?.message ?? "", body, sent: f.sent };
  }
  const made = () => Response.json({ voice_id: "v1", requires_verification: false });

  test("ElevenLabs is sent MP3, WAV, M4A and FLAC, and nothing else is sent at all", async () => {
    const ok = await cloning(
      endpoint({}),
      [
        sampleFile("a.mp3", HEADS.mp3Frame, "audio/mpeg"),
        sampleFile("b.wav"),
        sampleFile("memo", HEADS.m4a, "application/octet-stream"),
        sampleFile("c.flac", HEADS.flac, "audio/x-flac"),
      ],
      made,
    );
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ id: "v1", label: "Mara" });
    const files = (ok.sent[0].init.body as FormData).getAll("files") as File[];
    expect(files.map((v) => v.type)).toEqual([
      "audio/mpeg",
      "audio/wav",
      "audio/mp4",
      "audio/flac",
    ]);

    const opus = await cloning(
      endpoint({}),
      [sampleFile("note.opus", HEADS.opus, "audio/ogg")],
      made,
    );
    expect([opus.status, opus.message]).toEqual([
      415,
      "note.opus is Opus audio, which this provider does not make a voice from",
    ]);
    expect(opus.sent).toEqual([]);

    const big = await cloning(
      endpoint({}),
      [sampleFile("long.mp3", HEADS.mp3Frame, "audio/mpeg", 10 * 1024 * 1024 + 1)],
      made,
    );
    expect([big.status, big.message]).toEqual([
      413,
      "long.mp3 is larger than 10 MB, the most this provider takes for one sample",
    ]);
    expect(big.sent).toEqual([]);
  });

  test("BreezeBlue is sent one WAV or MP3 of up to 5 MB, and nothing else is sent at all", async () => {
    const ep = endpoint({
      id: "breeze",
      name: "BreezeBlue",
      baseUrl: "https://api.breeze.blue/v1",
      model: "breeze-tts-2",
    });
    const two = await cloning(ep, [sampleFile("a.wav"), sampleFile("b.wav")], made);
    expect([two.status, two.message]).toEqual([
      400,
      "Use one sample: this provider makes a voice from a single file",
    ]);
    const m4a = await cloning(ep, [sampleFile("memo.m4a", HEADS.m4a, "audio/mp4")], made);
    expect([m4a.status, m4a.message]).toEqual([
      415,
      "memo.m4a is M4A audio, which this provider does not make a voice from",
    ]);
    const big = await cloning(
      ep,
      [sampleFile("long.wav", HEADS.wav, "audio/wav", 5 * 1024 * 1024 + 1)],
      made,
    );
    expect([big.status, big.message]).toEqual([
      413,
      "long.wav is larger than 5 MB, the most this provider takes for one sample",
    ]);
    for (const refused of [two, m4a, big]) expect(refused.sent).toEqual([]);

    const ok = await cloning(ep, [sampleFile("take.mp3", HEADS.mp3Frame, "audio/mpeg")], (_, n) =>
      n === 1
        ? Response.json({ generated_voice_id: "gvi_1" })
        : Response.json({ voice_id: "voice_1", name: "Mara", gender: "male" }),
    );
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ id: "voice_1", label: "Mara", gender: "m" });
    expect(ok.sent).toHaveLength(2);
  });
});
