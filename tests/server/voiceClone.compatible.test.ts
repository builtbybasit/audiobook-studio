// Making a voice on an OpenAI-compatible server: `POST /audio/voices` as the batch speech API gives
// it (`docs/speech-batch-api.md#voices`), against a `fetch` that answers from memory — the form
// sent, the voice read back, what a server that makes no voices is said to be, and that the route
// offers none of it to an endpoint that does not say its server makes voices.
import { describe, expect, test } from "bun:test";

import type { CloneRequest } from "~/providers/clone";
import {
  answering,
  cloneEndpoint,
  cloneFields,
  cloneForm,
  cloneTarget,
  postClone,
  sampleFile,
  saved,
} from "../support/cloning";
import { testApi } from "../support/server";

const target = cloneTarget({
  id: "omni",
  name: "OmniVoice",
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "omnivoice",
  apiKey: null,
  needsKey: false,
});

const request = (transcript?: string): CloneRequest => ({
  title: "Mara",
  samples: [
    {
      name: "take-1.wav",
      format: "wav",
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      ...(transcript ? { transcript } : {}),
    },
  ],
});
const signal = () => new AbortController().signal;

/** What the batch speech API answers a voice made with: the voice, as the list shows it. */
const made = () =>
  Response.json({ id: "mara", name: "Mara", gender: "f", language: "en" }, { status: 201 });

describe("the compatible cloner", () => {
  test("posts the spec's form — a name, the recording and its transcript — and reads the voice", async () => {
    const f = answering(() => made());
    const voice = await f.cloner.clone(target, request("We are short again."), signal());
    expect(voice).toEqual({ id: "mara", label: "Mara", gender: "f" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].url).toBe("http://127.0.0.1:8000/v1/audio/voices");
    expect(f.sent[0].init.method).toBe("POST");
    expect(new Headers(f.sent[0].init.headers).has("content-type")).toBe(false);
    const body = f.sent[0].init.body as FormData;
    expect([...body.keys()].sort()).toEqual(["name", "samples", "transcript"]);
    expect(body.get("transcript")).toBe("We are short again.");
    const clip = body.get("samples") as File;
    expect([clip.name, clip.type]).toEqual(["take-1.wav", "audio/wav"]);

    const untold = answering(() => made());
    await untold.cloner.clone(target, request(), signal());
    expect((untold.sent[0].init.body as FormData).has("transcript")).toBe(false);
  });

  test("a server that makes no voices says to turn voice making off", async () => {
    for (const status of [404, 405]) {
      const f = answering(() => new Response("Not Found", { status }));
      await expect(f.cloner.clone(target, request(), signal())).rejects.toThrow(
        `OmniVoice makes no voices: POST http://127.0.0.1:8000/v1/audio/voices answered ${status}`,
      );
      expect(f.sent).toHaveLength(1);
    }
    const noId = answering(() => Response.json({ name: "Mara" }, { status: 201 }));
    await expect(noId.cloner.clone(target, request(), signal())).rejects.toThrow(
      "OmniVoice answered 201 without the new voice's id",
    );
  });
});

describe("a compatible clone, through the route", () => {
  const omni = (makesVoices?: boolean) =>
    cloneEndpoint({
      id: "omni",
      name: "OmniVoice",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "omnivoice",
      needsKey: false,
      apiKey: undefined,
      ...(makesVoices === undefined ? {} : { makesVoices }),
    });

  test("is made where the endpoint says its server makes voices", async () => {
    const f = answering(() => made());
    const api = testApi({ cloner: f.cloner });
    await saved(api, omni(true));
    const { status, body } = await postClone(
      api,
      cloneForm(cloneFields("omni"), [sampleFile()], ["We are short again."]),
    );
    expect(status).toBe(201);
    expect(body).toMatchObject({ id: "mara", label: "Mara" });
    expect((f.sent[0].init.body as FormData).get("transcript")).toBe("We are short again.");
  });

  test("is refused, with nothing sent, where it does not", async () => {
    const f = answering(() => made());
    const api = testApi({ cloner: f.cloner });
    await saved(api, omni());
    const { status, body } = await postClone(api, cloneForm(cloneFields("omni"), [sampleFile()]));
    expect(status).toBe(400);
    expect(body.error?.message).toBe(
      "OmniVoice does not say its server makes voices; turn that on on its Voices tab first",
    );
    expect(f.sent).toHaveLength(0);
  });
});
