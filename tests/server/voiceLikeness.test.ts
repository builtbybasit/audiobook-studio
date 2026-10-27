// Comparing cloned voices: the maths of `compareVoices`, and `GET /api/endpoints/voices/likeness`
// fingerprinting kept samples through a fake that maps each sample's tag to a vector.
import { describe, expect, test } from "bun:test";

import type { KeptVoiceSamples, Voice, VoiceLikeness, VoiceLikenessReport } from "@/types";
import { ALIKE_AT, MIXED_BELOW, NEAREST, TWIN_AT } from "@/lib/voiceLikeness";
import { sampleFingerprints } from "~/db/schema";
import { FINGERPRINT_MODEL, type VoiceFingerprinter } from "~/voices/fingerprint";
import { compareVoices } from "~/voices/likeness";
import { cloneEndpoint, cloneForm, HEADS, saved } from "../support/cloning";
import { testApi, type TestApi } from "../support/server";

/** A unit vector whose cosine with `BASE` is `score`; `turn` swings it round, away from others. */
const at = (score: number, turn = 0): Float32Array => {
  const s = Math.sqrt(1 - score * score);
  return new Float32Array([score, s * Math.cos(turn), s * Math.sin(turn)]);
};
const BASE = at(1);

/** voice id → its samples' files and their vectors */
type World = Record<string, Record<string, Float32Array>>;

function compare(world: World): Map<string, VoiceLikeness> {
  const voices = Object.entries(world).map(([voiceId, files]) => ({
    endpointId: "ep",
    voiceId,
    files: Object.keys(files),
  }));
  const vectors = new Map(Object.values(world).flatMap((files) => Object.entries(files)));
  return new Map(compareVoices(voices, vectors).map((v) => [v.voiceId, v]));
}

const ids = (xs: readonly { voiceId: string }[]): string[] => xs.map((x) => x.voiceId);

describe("comparing voices", () => {
  test("nearest: the voices at ALIKE_AT or above, best first, at most NEAREST", () => {
    const scores = [
      ALIKE_AT - 0.01,
      ...Array.from({ length: NEAREST + 1 }, (_, i) => ALIKE_AT + 0.01 + 0.02 * i),
    ];
    const others = scores.map((score, i) => ({ id: `v${i}`, score }));
    const report = compare({
      me: { me: BASE },
      ...Object.fromEntries(others.map((o, i) => [o.id, { [o.id]: at(o.score, i) }])),
    });

    const best = others
      .filter((o) => o.score >= ALIKE_AT)
      .sort((a, b) => b.score - a.score)
      .slice(0, NEAREST);
    expect(ids(report.get("me")!.nearest)).toEqual(best.map((o) => o.id));
  });

  test.each([
    ["the same file", { a1: BASE, kept: at(0.3, 1) }, { kept: at(0.3, 1), b1: at(0, 2) }, true],
    [
      "a recording at TWIN_AT or above",
      { a1: BASE, a2: at(0.5) },
      { b1: at(TWIN_AT + 0.01), b2: at(0.2, 2) },
      true,
    ],
    [
      "nothing as close as TWIN_AT",
      { a1: BASE, a2: at(0.5) },
      { b1: at(TWIN_AT - 0.02), b2: at(0.2, 2) },
      false,
    ],
  ])("twins by %s", (_, a, b, twins) => {
    const report = compare({ a, b });
    expect(ids(report.get("a")!.twins).includes("b")).toBe(twins);
    expect(ids(report.get("b")!.twins).includes("a")).toBe(twins);
  });

  test.each([
    ["one sample", { s1: BASE }, false],
    ["two samples below MIXED_BELOW", { s1: BASE, s2: at(MIXED_BELOW - 0.05) }, true],
    ["two samples above MIXED_BELOW", { s1: BASE, s2: at(MIXED_BELOW + 0.05) }, false],
  ])("mixed with %s", (_, files, mixed) => {
    expect(compare({ a: files }).get("a")!.mixed).toBe(mixed);
  });
});

// ---------- the route ----------

const VECTORS: Record<string, Float32Array> = {
  m1: BASE,
  f1: at(0.8),
  f2: at(0.7, 1),
  shared: at(0.3, 2),
  // mara's own recording kept again under another name: a twin, unless left out
  i1: BASE,
};

/** A WAV whose body names its vector in `VECTORS`. */
const take = (tag: string): File =>
  new File([HEADS.wav, `#${tag}#`, new Uint8Array(512)], `${tag}.wav`, { type: "audio/wav" });

interface FakeFingerprinter extends VoiceFingerprinter {
  /** the tags of every call, in order */
  calls: string[][];
  why: string | null;
  fail: Error | null;
  /** set: every call waits for it */
  gate: Promise<void> | null;
}

function fakeFingerprinter(): FakeFingerprinter {
  const fake: FakeFingerprinter = {
    calls: [],
    why: null,
    fail: null,
    gate: null,
    unavailable: async () => fake.why,
    async fingerprint(paths) {
      const tags = await Promise.all(
        paths.map(async (p) => /#(\w+)#/.exec(await Bun.file(p).text())![1]),
      );
      fake.calls.push(tags);
      if (fake.gate) await fake.gate;
      if (fake.fail) throw fake.fail;
      // a tag with no vector stands for a file the model can't use
      return tags.map((t) => VECTORS[t] ?? null);
    },
  };
  return fake;
}

const voice = (id: string): Voice => ({ id, label: id, gender: "f" });
const ALL = ["mara", "finn", "ida"].map(voice);

async function keep(api: TestApi, voiceId: string, ...tags: string[]): Promise<KeptVoiceSamples> {
  const { status, body } = await api.request<KeptVoiceSamples>(
    `/api/endpoints/fish/voices/${voiceId}/samples`,
    { method: "POST", body: cloneForm({}, tags.map(take)) },
  );
  expect(status).toBe(200);
  return body;
}

const likeness = (api: TestApi) =>
  api.request<VoiceLikenessReport & { error?: { message: string } }>(
    "/api/endpoints/voices/likeness",
  );

async function setup(fingerprinter: VoiceFingerprinter | undefined) {
  const api = testApi({ fingerprinter });
  await saved(api, cloneEndpoint({ voices: ALL }));
  await keep(api, "mara", "m1", "shared");
  const finn = await keep(api, "finn", "f1", "shared");
  return { api, finnFirst: finn.samples[0].file };
}

const entry = (report: VoiceLikenessReport, voiceId: string) =>
  report.voices.find((v) => v.voiceId === voiceId);

describe("GET /api/endpoints/voices/likeness", () => {
  test("fingerprints each kept file once, in one call, and only what is new after", async () => {
    const fake = fakeFingerprinter();
    const { api, finnFirst } = await setup(fake);

    const first = await likeness(api);
    expect(first.status).toBe(200);
    // a file kept for two voices is one fingerprint
    expect(fake.calls.map((c) => [...c].sort())).toEqual([["f1", "m1", "shared"]]);
    expect(ids(entry(first.body, "mara")!.nearest)).toEqual(["finn"]);
    expect(ids(entry(first.body, "mara")!.twins)).toEqual(["finn"]);

    await keep(api, "finn", "f2", "shared");
    expect((await likeness(api)).status).toBe(200);
    expect(fake.calls[1]).toEqual(["f2"]);
    // a file no voice keeps loses its row
    const rows = api.db.select().from(sampleFingerprints).all();
    expect(rows.map((r) => r.file)).not.toContain(finnFirst);
  });

  test("a file the model can't use leaves its voice out and isn't sent again", async () => {
    const fake = fakeFingerprinter();
    const { api } = await setup(fake);
    await keep(api, "ida", "unusable");

    const first = await likeness(api);
    expect(first.status).toBe(200);
    expect(entry(first.body, "ida")).toBeUndefined();
    expect(entry(first.body, "mara")).toBeDefined();

    await likeness(api);
    expect(fake.calls.flat().filter((t) => t === "unusable")).toHaveLength(1);
  });

  test("another model's rows are fingerprinted again", async () => {
    const fake = fakeFingerprinter();
    const { api } = await setup(fake);
    await likeness(api);
    api.db.update(sampleFingerprints).set({ model: "an-older-model" }).run();

    expect((await likeness(api)).status).toBe(200);
    expect([...fake.calls[1]].sort()).toEqual(["f1", "m1", "shared"]);
    const models = api.db
      .select()
      .from(sampleFingerprints)
      .all()
      .map((r) => r.model);
    expect(new Set(models)).toEqual(new Set([FINGERPRINT_MODEL]));
  });

  test.each([
    [
      "forgotten",
      (api: TestApi) => api.request("/api/endpoints/fish/voices/ida/samples", { method: "DELETE" }),
    ],
    [
      "gone from the saved endpoints",
      (api: TestApi) => saved(api, cloneEndpoint({ voices: ALL.slice(0, 2) })),
    ],
  ])("a voice %s is left out", async (_, leave) => {
    const fake = fakeFingerprinter();
    const { api } = await setup(fake);
    await keep(api, "ida", "i1");
    await leave(api);

    const { status, body } = await likeness(api);
    expect(status).toBe(200);
    expect(entry(body, "ida")).toBeUndefined();
    const named = body.voices.flatMap((v) => [...ids(v.nearest), ...ids(v.twins)]);
    expect(named).not.toContain("ida");
    expect(fake.calls.flat()).not.toContain("i1");
  });

  test.each([
    ["no fingerprinter", undefined, null],
    ["a fingerprinter that says why not", fakeFingerprinter(), "uv was not found"],
  ])("with %s, nothing is compared and the reason is given", async (_, fake, why) => {
    if (fake) fake.why = why;
    const { api } = await setup(fake);

    const { status, body } = await likeness(api);
    expect(status).toBe(200);
    expect(body.voices).toEqual([]);
    expect(body.unavailable).toEqual(why ?? expect.any(String));
    expect(fake?.calls ?? []).toEqual([]);
  });

  test("a failed fingerprint is refused with its reason, and the next request runs", async () => {
    const fake = fakeFingerprinter();
    const { api } = await setup(fake);
    fake.fail = new Error("ffmpeg could not read f1.wav");

    const failed = await likeness(api);
    expect(failed.status).toBe(503);
    expect(failed.body.error!.message).toContain("ffmpeg could not read f1.wav");

    fake.fail = null;
    expect((await likeness(api)).status).toBe(200);
  });

  test("overlapping requests fingerprint the files once", async () => {
    const fake = fakeFingerprinter();
    const { api } = await setup(fake);
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));

    const both = Promise.all([likeness(api), likeness(api)]);
    // both requests are in: the first waits on the gate, the second on the first
    while (!fake.calls.length) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    release();

    const [a, b] = await both;
    expect(fake.calls).toHaveLength(1);
    expect(b.body).toEqual(a.body);
  });
});
