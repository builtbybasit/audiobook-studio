// Making a voice on Cartesia: `POST /voices/clone`, as its docs give it
// (https://docs.cartesia.ai/api-reference/voices/clone), against a `fetch` that answers from
// memory. The request, the answer read into a voice, that it goes out once whatever fails, how
// Cartesia's refusals reach the page, that the voice made is fetched back even from behind a long
// catalogue, and what the route refuses before anything is sent: a second sample, since Cartesia
// makes a voice from one, and M4A, which it does not take.
import { describe, expect, test } from "bun:test";

import type { CloneRequest } from "~/providers/clone";
import { CARTESIA_VERSION, cartesiaWire } from "~/providers/speech/cartesia";
import type { ProviderTarget } from "~/providers/target";
import {
  agreed,
  answering,
  cloneForm,
  HEADS,
  postClone,
  sampleFile,
  saved,
  speechEndpoint,
} from "../support/cloning";
import { testApi } from "../support/server";

const target: ProviderTarget = {
  id: "cartesia",
  name: "Cartesia",
  baseUrl: "https://api.cartesia.ai",
  model: "sonic-3.6",
  apiKey: "sk_car_key",
  needsKey: true,
  timeoutSec: 5,
  // what a narration endpoint is saved with: the upload must not take them
  maxRetries: 2,
  cooldownSec: 0,
};

/** What Cartesia answers a clone with: the new voice's metadata, as its reference's example. */
const made = (over: Record<string, unknown> = {}) =>
  Response.json({
    id: "f161df88-b5a0-4ea8-aa21-6be12859f761",
    access: "private",
    name: "Mara",
    tagline: "",
    description: "",
    created_at: "2026-09-28T00:00:00.000Z",
    language: "en",
    user_id: "org_123",
    visibility: "owner",
    ...over,
  });

const request: CloneRequest = {
  title: "Mara",
  samples: [
    {
      name: "take-1.wav",
      format: "wav",
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
    },
  ],
};
const signal = () => new AbortController().signal;

describe("the Cartesia cloner", () => {
  test("posts the multipart form Cartesia's docs give: one clip, English, private", async () => {
    const f = answering(() => made());
    const voice = await f.cloner.clone(target, request, signal());
    expect(voice).toEqual({
      id: "f161df88-b5a0-4ea8-aa21-6be12859f761",
      label: "Mara",
      gender: "?",
    });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].url).toBe("https://api.cartesia.ai/voices/clone");
    expect(f.sent[0].init.method).toBe("POST");
    const headers = new Headers(f.sent[0].init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk_car_key");
    expect(headers.get("cartesia-version")).toBe(CARTESIA_VERSION);
    // the boundary is the form's own: no JSON content type is forced onto it
    expect(headers.has("content-type")).toBe(false);
    const body = f.sent[0].init.body as FormData;
    expect([...body.keys()].sort()).toEqual(["access", "clip", "language", "name"]);
    expect([body.get("name"), body.get("language"), body.get("access")]).toEqual([
      "Mara",
      "en",
      "private",
    ]);
    const clip = body.get("clip") as File;
    expect([clip.name, clip.size, clip.type]).toEqual(["take-1.wav", 3, "audio/wav"]);
  });

  test("the voice is named as Cartesia answers, or as asked when it answers no name", async () => {
    const renamed = answering(() => made({ name: " Mara (clone) " }));
    expect((await renamed.cloner.clone(target, request, signal())).label).toBe("Mara (clone)");
    const unnamed = answering(() => made({ name: "" }));
    expect((await unnamed.cloner.clone(target, request, signal())).label).toBe("Mara");
  });

  test("a clone goes out once: a 5xx, a rate limit or no answer is not sent again", async () => {
    const failures: [() => Response | Promise<Response>, string][] = [
      [() => new Response("busy", { status: 503 }), "Cartesia answered 503: busy"],
      [() => new Response("slow down", { status: 429 }), "Cartesia answered 429"],
      [
        () => Promise.reject(new TypeError("connection reset")),
        "Cartesia could not be reached: connection reset",
      ],
    ];
    for (const [answer, said] of failures) {
      const f = answering(answer);
      await expect(f.cloner.clone(target, request, signal())).rejects.toThrow(said);
      expect(f.sent).toHaveLength(1);
    }
  });

  test("a refusal is read out in Cartesia's words, and an answer without an id fails", async () => {
    // its structured error, as https://docs.cartesia.ai/use-the-api/api-conventions gives it
    const refused = answering(() =>
      Response.json(
        {
          error_code: "plan_upgrade_required",
          title: "Plan upgrade required",
          message: "Voice cloning requires a Pro plan or higher.",
          request_id: "550e8400-e29b-41d4-a716-446655440000",
        },
        { status: 402 },
      ),
    );
    await expect(refused.cloner.clone(target, request, signal())).rejects.toThrow(
      "Cartesia answered 402: Voice cloning requires a Pro plan or higher.",
    );
    expect(refused.sent).toHaveLength(1);

    const noId = answering(() => made({ id: undefined }));
    await expect(noId.cloner.clone(target, request, signal())).rejects.toThrow(
      "Cartesia answered 200 without the new voice's id",
    );
    const notJson = answering(() => new Response("ok"));
    await expect(notJson.cloner.clone(target, request, signal())).rejects.toThrow(
      "without the new voice's id",
    );
  });
});

// ---------- the voice, fetched back ----------

describe("a cloned voice in Cartesia's list", () => {
  test("is fetched with the account's own when Cartesia's catalogue runs past the cap", async () => {
    const seen: URL[] = [];
    // a catalogue that never ends, a hundred a page, and the account's one voice
    const fetch = (async (url: string) => {
      const u = new URL(url);
      seen.push(u);
      if (u.searchParams.get("is_owner") === "true")
        return Response.json({
          data: [{ id: "mine", name: "Mara", gender: null, is_owner: true }],
          has_more: false,
        });
      const from = seen.length * 100;
      return Response.json({
        data: Array.from({ length: 100 }, (_, i) => ({ id: `c${from + i}`, name: "Stock" })),
        has_more: true,
      });
    }) as unknown as typeof globalThis.fetch;
    const page = await cartesiaWire.voices(target, signal(), { fetch, backoffMs: () => 0 });
    expect(seen.map((u) => u.searchParams.get("is_owner"))).toEqual([
      ...Array<null>(10).fill(null),
      "true",
    ]);
    expect(page.voices).toHaveLength(1001);
    expect(page.voices.at(-1)).toEqual({ id: "mine", label: "Mara", gender: "?" });
    expect(page.hasMore).toBe(true);
  });
});

// ---------- through the route ----------

describe("a Cartesia clone, through the route", () => {
  async function cloningAgainst(answer: () => Response | Promise<Response>, samples: File[]) {
    const f = answering(answer);
    const api = testApi({ cloner: f.cloner });
    await saved(
      api,
      speechEndpoint({
        id: "cartesia",
        name: "Cartesia",
        baseUrl: "https://api.cartesia.ai",
        model: "sonic-3.6",
        apiKey: "sk_car_key",
      }),
    );
    const { status, body } = await postClone(api, cloneForm(agreed("cartesia"), samples));
    return { status, body, message: body.error?.message ?? "", sent: f.sent };
  }

  test("one WAV is made into a voice", async () => {
    const { status, body, sent } = await cloningAgainst(() => made(), [sampleFile()]);
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: "f161df88-b5a0-4ea8-aa21-6be12859f761", label: "Mara" });
    expect(sent).toHaveLength(1);
  });

  test("a second sample is refused before anything is sent: Cartesia takes one", async () => {
    const { status, message, sent } = await cloningAgainst(
      () => made(),
      [sampleFile("a.wav"), sampleFile("b.wav")],
    );
    expect([status, message]).toEqual([
      400,
      "Use one sample: this provider makes a voice from a single file",
    ]);
    expect(sent).toEqual([]);
  });

  test("M4A, which Cartesia does not list, is refused before anything is sent", async () => {
    const { status, message, sent } = await cloningAgainst(
      () => made(),
      [sampleFile("memo.m4a", HEADS.m4a, "audio/mp4")],
    );
    expect([status, message]).toEqual([
      415,
      "memo.m4a is M4A audio, which this provider does not make a voice from",
    ]);
    expect(sent).toEqual([]);
  });

  test("a sample over Cartesia's 16 MB is refused before anything is sent", async () => {
    const { status, message, sent } = await cloningAgainst(
      () => made(),
      [sampleFile("long.wav", HEADS.wav, "audio/wav", 16 * 1024 * 1024 + 1)],
    );
    expect([status, message]).toEqual([
      413,
      "long.wav is larger than 16 MB, the most this provider takes for one sample",
    ]);
    expect(sent).toEqual([]);
  });

  test("what Cartesia refuses is a 400 carrying its own words, and the key is not in it", async () => {
    const { status, message } = await cloningAgainst(
      () =>
        Response.json(
          { error_code: "file_too_large", title: "File too large", message: "Clip is too long." },
          { status: 413 },
        ),
      [sampleFile()],
    );
    expect([status, message]).toEqual([400, "Cartesia answered 413: Clip is too long."]);
    expect(message).not.toContain("sk_car_key");
  });
});
