// What a cloned voice costs, in the usage ledger: charged as the voice is made where its provider
// charges then (Model Studio), set aside for the first line spoken in it where the provider charges
// then (MiniMax), and nothing where it charges nothing (Fish). And what the clone route answers
// beside the voice when the provider said to do something before it speaks.
import { describe, expect, test } from "bun:test";

import type { Endpoint } from "@/types";
import { cloneModelsFor, cloningOf } from "@/lib/providers";
import { cloneFees, requests } from "~/db/schema";
import { endpointVoiceCloner, type VoiceCloner } from "~/providers/clone";
import type { SentSpeech } from "~/providers/sent";
import { settleSpeech } from "~/usage/ledger";
import {
  cloneFields,
  cloneForm,
  postClone,
  remembering,
  sampleFile,
  saved,
  cloneEndpoint,
  cloneTarget,
} from "../support/cloning";
import { testApi, type TestApi } from "../support/server";

const qwen = cloneEndpoint({
  id: "qwen",
  name: "Qwen VC",
  baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1",
  model: "qwen3-tts-vc-2026-01-22",
});
const minimax = cloneEndpoint({
  id: "minimax",
  name: "MiniMax",
  baseUrl: "https://api.minimax.io/v1",
  model: "speech-2.8-hd",
});

/** The ledger's rows, as much of each as a fee is told by. */
const ledger = (api: TestApi) =>
  api.db
    .select({
      label: requests.label,
      cost: requests.cost,
      bookId: requests.bookId,
      endpointId: requests.endpointId,
    })
    .from(requests)
    .all();

async function cloned(ep: Endpoint) {
  const { cloner } = remembering();
  const api = testApi({ cloner });
  await saved(api, ep);
  const { status } = await postClone(api, cloneForm(cloneFields(ep.id), [sampleFile()]));
  expect(status).toBe(201);
  return api;
}

const spoken = (over: Partial<SentSpeech> = {}): SentSpeech => ({
  startedAt: Date.now() - 500,
  finishedAt: Date.now(),
  attempts: 1,
  rateLimited: false,
  status: "done",
  simulated: false,
  text: "Hello there",
  instructions: "",
  audioSeconds: 2,
  reported: null,
  billed: true,
  ...over,
});
const line = (voiceRef: string) => ({ bookId: null, chapterUid: null, label: "Line", voiceRef });

describe("what a clone costs", () => {
  test("a provider that charges as the voice is made is charged then, to the endpoint", async () => {
    const api = await cloned(qwen);
    expect(ledger(api)).toEqual([
      {
        label: "Voice made · Mara · $0.01 a voice",
        cost: 0.01,
        bookId: null,
        endpointId: "qwen",
      },
    ]);
    expect(api.db.select().from(cloneFees).all()).toEqual([]);
  });

  test("a provider that charges nothing leaves nothing in the ledger", async () => {
    const api = await cloned(cloneEndpoint());
    expect(ledger(api)).toEqual([]);
  });

  test("a fee at first use waits for the first billed line in that voice, and is charged once", async () => {
    const api = await cloned(minimax);
    expect(ledger(api)).toEqual([]);
    expect(api.db.select().from(cloneFees).all()).toMatchObject([
      { endpointId: "minimax", voiceId: "new-voice-id", title: "Mara", usd: 1.5 },
    ]);

    // a line refused unbilled, a line that failed, and a line in another voice charge nothing
    settleSpeech(api.db, minimax, line("minimax/new-voice-id"), spoken({ billed: false }));
    settleSpeech(api.db, minimax, line("minimax/new-voice-id"), spoken({ status: "failed" }));
    settleSpeech(api.db, minimax, line("minimax/another-voice"), spoken());
    settleSpeech(api.db, minimax, line("fish/new-voice-id"), spoken());
    expect(ledger(api).filter((r) => r.label.startsWith("Voice"))).toEqual([]);

    // the first billed line does, and the next does not again
    settleSpeech(api.db, minimax, line("minimax/new-voice-id"), spoken());
    settleSpeech(api.db, minimax, line("minimax/new-voice-id"), spoken());
    expect(ledger(api).filter((r) => r.label.startsWith("Voice"))).toEqual([
      {
        label: "Voice first spoken · Mara · $1.50 a voice, charged when it first speaks",
        cost: 1.5,
        bookId: null,
        endpointId: "minimax",
      },
    ]);
    expect(api.db.select().from(cloneFees).all()).toEqual([]);
  });

  test("a clone cancelled once its upload was out may have been charged: a row at a cost nobody knows where the voice is charged as it is made, and nothing otherwise", async () => {
    // a cloner whose upload goes out, then waits until the request is closed
    const uploading: VoiceCloner = {
      clone: (_target, _request, signal, wentOut) =>
        new Promise((_, reject) => {
          wentOut?.();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          setTimeout(() => page.abort(new Error("the page went away")), 0);
        }),
    };
    let page = new AbortController();
    const api = testApi({ cloner: uploading });
    await saved(api, minimax, qwen);
    for (const id of ["qwen", "minimax"]) {
      page = new AbortController();
      await api
        .fetch("/api/endpoints/voices/clone", {
          method: "POST",
          body: cloneForm(cloneFields(id), [sampleFile()]),
          signal: page.signal,
        })
        .catch(() => null);
    }
    expect(
      api.db
        .select({
          endpointId: requests.endpointId,
          status: requests.status,
          cost: requests.cost,
          held: requests.held,
        })
        .from(requests)
        .all(),
    ).toEqual([{ endpointId: "qwen", status: "cancelled", cost: null, held: 0.01 }]);
    expect(api.db.select().from(cloneFees).all()).toEqual([]);
  });

  test("the cloner says a clone went out when its first request did, and not when it was cancelled first", async () => {
    const fetch = (async () =>
      new Response("busy", { status: 503 })) as unknown as typeof globalThis.fetch;
    const samples = [{ name: "mara.wav", format: "wav" as const, blob: sampleFile() }];
    const tried = async (signal: AbortSignal) => {
      let wentOut = false;
      await endpointVoiceCloner({ fetch })
        .clone(cloneTarget({ ...qwen, apiKey: "sk" }), { title: "Mara", samples }, signal, () => {
          wentOut = true;
        })
        .catch(() => null);
      return wentOut;
    };
    expect(await tried(new AbortController().signal)).toBe(true);
    const cancelled = new AbortController();
    cancelled.abort(new Error("the page went away"));
    expect(await tried(cancelled.signal)).toBe(false);
  });

  test("a clone that fails costs nothing and sets nothing aside", async () => {
    const api = testApi({
      cloner: {
        async clone() {
          throw new Error("no");
        },
      },
    });
    await saved(api, minimax, qwen);
    for (const id of ["minimax", "qwen"])
      expect((await postClone(api, cloneForm(cloneFields(id), [sampleFile()]))).status).toBe(500);
    expect(ledger(api)).toEqual([]);
    expect(api.db.select().from(cloneFees).all()).toEqual([]);
  });
});

describe("what the provider says beside the voice", () => {
  test("a warning from the provider is answered beside the voice, and its name is its own", async () => {
    const warning = "Verify this voice on ElevenLabs before a line is spoken with it.";
    const { cloner } = remembering({ warning });
    const api = testApi({ cloner });
    await saved(api, cloneEndpoint());
    const { body } = await postClone(api, cloneForm(cloneFields(), [sampleFile()]));
    expect(body).toEqual({
      id: "new-voice-id",
      label: "Mara",
      gender: "?",
      samplesKept: true,
      warning,
    });
  });
});

describe("a provider that clones for some of its models", () => {
  test("clones for those, and names them for any other", () => {
    expect(cloningOf(qwen)?.maxSamples).toBe(1);
    expect(cloneModelsFor(qwen)).toEqual([]);
    const audio = { ...qwen, model: "qwen-audio-3.0-tts-flash" };
    expect(cloningOf(audio)).toBeNull();
    expect(cloneModelsFor(audio)).toEqual(["qwen3-tts-vc-2026-01-22"]);
    // a provider that clones for every model, and one that clones for none, name nothing
    expect(cloneModelsFor(minimax)).toEqual([]);
    expect(cloneModelsFor(cloneEndpoint({ baseUrl: "https://api.openai.com/v1" }))).toEqual([]);
  });
});
