// The book's Character voice: what a speaker with no voice of their own is read in, before the
// Narrator's (a linked persona: their character's). `speakerVoice` alone, then through the
// settings route and a real run; then the finished lines a voice change leaves behind.
import { describe, expect, test } from "bun:test";

import type {
  Book,
  Character,
  CharacterVoice,
  Endpoint,
  NarrationQueued,
  OldVoice,
  Segment,
} from "@/types";
import { narrator, speakerVoice } from "@/lib/cast";
import { deliveryFor } from "~/narration/cost";
import { story } from "../support/epub";
import {
  jsonBody,
  narrateChapters,
  saveEndpoints,
  speechEndpoint,
  testApi,
  voicedBook,
  type TestApi,
} from "../support/server";

const speaker = (name: string, gender: Character["gender"], voice: string | null = null) => ({
  ...narrator(voice),
  name,
  gender,
});
const cv = (over: Partial<CharacterVoice> = {}): CharacterVoice => ({
  by: "one",
  one: null,
  male: null,
  female: null,
  other: null,
  ...over,
});

/** A cast by name, the Narrator in it read in `narr`. */
const castOf = (narr: string | null, ...cs: Character[]) =>
  new Map([narrator(narr), ...cs].map((c) => [c.name, c]));

describe("the voice a speaker is read in", () => {
  test("is their own first, whatever the Character voice says", () => {
    const cast = castOf("ep/narr", speaker("Mara", "f", "ep/mara"));
    expect(speakerVoice("Mara", cast, cv({ one: "ep/char" }))).toEqual({
      ref: "ep/mara",
      from: "own",
    });
  });

  test("is the one Character voice for everyone else, and the Narrator's without one", () => {
    const cast = castOf("ep/narr", speaker("Tobin", "m"));
    expect(speakerVoice("Tobin", cast, cv({ one: "ep/char" })).ref).toBe("ep/char");
    expect(speakerVoice("Tobin", cast, undefined)).toEqual({ ref: "ep/narr", from: "narrator" });
    // a name not in the cast is a character too
    expect(speakerVoice("Stranger", cast, cv({ one: "ep/char" })).from).toBe("character");
  });

  test("by gender picks the speaker's slot, neutral and unknown share `other`, and an empty slot is the Narrator's", () => {
    const g = cv({ by: "gender", one: "ep/one", male: "ep/m", female: "ep/f", other: "ep/o" });
    const cast = castOf(
      "ep/narr",
      speaker("A", "m"),
      speaker("B", "f"),
      speaker("C", "n"),
      speaker("D", "?"),
    );
    expect(speakerVoice("A", cast, g).ref).toBe("ep/m");
    expect(speakerVoice("B", cast, g).ref).toBe("ep/f");
    expect(speakerVoice("C", cast, g).ref).toBe("ep/o");
    expect(speakerVoice("D", cast, g).ref).toBe("ep/o");
    expect(speakerVoice("A", cast, { ...g, male: null })).toEqual({
      ref: "ep/narr",
      from: "narrator",
    });
  });

  describe("with age voices", () => {
    // Mara is a girl, Tobin an old man, Ivo a man of unknown age
    const cast = castOf(
      "ep/narr",
      { ...speaker("Mara", "f"), age: "child" },
      { ...speaker("Tobin", "m"), age: "elderly" },
      speaker("Ivo", "m"),
    );
    const ages: CharacterVoice["ages"] = [
      { slot: "female", age: "child", voice: "ep/girl" },
      { slot: "male", age: "child", voice: "ep/boy" },
      { slot: "male", age: "elderly", voice: "ep/old" },
    ];
    const g = cv({ by: "gender", one: "ep/one", male: "ep/m", female: "ep/f", ages });
    test.each([
      ["their gender's for their age", "Mara", g, "ep/girl"],
      ["their gender's for their age", "Tobin", g, "ep/old"],
      ["their gender's when their age is unknown", "Ivo", g, "ep/m"],
      ["their gender's when their age has none", "Mara", { ...g, ages: ages.slice(1) }, "ep/f"],
      ["the one voice in one-voice mode", "Mara", { ...g, by: "one" as const }, "ep/one"],
    ])("is %s (%s)", (_, name, voices, ref) => {
      expect(speakerVoice(name, cast, voices)).toEqual({ ref, from: "character" });
    });
  });

  test("never applies to the Narrator", () => {
    expect(speakerVoice("Narrator", castOf(null), cv({ one: "ep/char" }))).toEqual({
      ref: null,
      from: "narrator",
    });
  });
});

describe("the voice a persona is read in", () => {
  // a persona of a woman, with no voice of their own and a gender a link sets aside
  const lord = { ...speaker("Lord of Shadows", "m"), personaOf: "Sunny" };
  const g = cv({ by: "gender", male: "ep/m", female: "ep/f" });

  test("is their character's own voice when linked", () => {
    const cast = castOf("ep/narr", speaker("Sunny", "f", "ep/sunny"), lord);
    expect(speakerVoice("Lord of Shadows", cast, g)).toEqual({
      ref: "ep/sunny",
      from: "persona",
      of: "Sunny",
    });
  });

  test("is their own when they have one, linked or not: a reveal changes nothing heard", () => {
    const masked = { ...lord, voice: "ep/lord" };
    const cast = castOf("ep/narr", speaker("Sunny", "f", "ep/sunny"), masked);
    expect(speakerVoice("Lord of Shadows", cast, g)).toEqual({ ref: "ep/lord", from: "own" });
  });

  test("is the Character voice for their character's gender, or the Narrator's, when the character has none", () => {
    const cast = castOf("ep/narr", speaker("Sunny", "f"), lord);
    expect(speakerVoice("Lord of Shadows", cast, g).ref).toBe("ep/f");
    expect(speakerVoice("Lord of Shadows", cast, undefined)).toEqual({
      ref: "ep/narr",
      from: "persona",
      of: "Sunny",
    });
  });

  test("is their own while the link names nobody in the cast, or themselves", () => {
    expect(speakerVoice("Lord of Shadows", castOf("ep/narr", lord), g).ref).toBe("ep/m");
    const self = { ...lord, personaOf: "Lord of Shadows" };
    expect(speakerVoice("Lord of Shadows", castOf("ep/narr", self), g).ref).toBe("ep/m");
  });

  test("follows one link only", () => {
    const cast = castOf(
      "ep/narr",
      { ...speaker("Sunny", "f", "ep/sunny"), personaOf: "Nephis" },
      speaker("Nephis", "f", "ep/neph"),
      lord,
    );
    expect(speakerVoice("Lord of Shadows", cast, g).ref).toBe("ep/sunny");
  });
});

describe("a delivery", () => {
  const voiceOf = (ref: string) => (ref === "ep/sunny" ? { speed: 1.09 } : undefined);

  test.each([
    ["their character's voice's speed", undefined, 1.09],
    ["their own speed, 1 too", 1, 1],
  ])("gives a linked persona their character's voice, their own style and %s", (_, own, speed) => {
    const sunny = { ...speaker("Sunny", "m", "ep/sunny"), style: "dry", speed: 1.5 };
    const lord = {
      ...speaker("Lord of Shadows", "m"),
      style: "cold, distant",
      personaOf: "Sunny",
      speed: own,
    };
    const cast = [narrator("ep/narr"), sunny, lord];
    expect(deliveryFor(cast, undefined, voiceOf)("Lord of Shadows")).toEqual({
      voiceRef: "ep/sunny",
      voice: "sunny",
      endpoint: "ep",
      style: "cold, distant",
      speed,
    });
  });
});

const patch = (api: TestApi, id: string, body: unknown) =>
  api.request<{ book: Book }>(`/api/books/${id}`, { ...jsonBody(body), method: "PATCH" });

describe("a book's Character voice", () => {
  test("is kept by the settings route, cleared by null, and a malformed one is refused", async () => {
    const api = testApi();
    const id = await voicedBook(api, { paragraphs: story(2), voiceOf: "studio/ash" });
    const set = cv({ by: "gender", female: "studio/bea" });

    expect((await patch(api, id, { characterVoice: set })).body.book.characterVoice).toEqual(set);
    expect(
      (await api.request<{ book: Book }>(`/api/books/${id}`)).body.book.characterVoice,
    ).toEqual(set);
    expect(
      (await patch(api, id, { characterVoice: null })).body.book.characterVoice,
    ).toBeUndefined();
    expect((await patch(api, id, { characterVoice: { ...set, by: "age" } })).status).toBe(400);
  });

  test("keeps age voices, stores none for an empty list, and refuses two voices for one pair", async () => {
    const api = testApi();
    const id = await voicedBook(api, { paragraphs: story(1), voiceOf: "studio/ash" });
    const girl = { slot: "female", age: "child", voice: "studio/bea" } as const;
    const set = cv({ by: "gender", ages: [girl] });

    expect((await patch(api, id, { characterVoice: set })).body.book.characterVoice).toEqual(set);
    expect(
      (await patch(api, id, { characterVoice: { ...set, ages: [] } })).body.book.characterVoice,
    ).toEqual(cv({ by: "gender" }));
    const twice = { ...set, ages: [girl, { ...girl, voice: "studio/ash" }] };
    const refused = await patch(api, id, { characterVoice: twice });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("ages");
  });

  // every speaker but the Narrator is a child; one-voice mode reads past the age voices
  const childOf = (voice: string) =>
    (["male", "female", "other"] as const).map((slot) => ({ slot, age: "child" as const, voice }));
  test.each([
    ["the one voice", cv({ one: "studio/bea", ages: childOf("studio/ash") })],
    [
      "their age voice",
      cv({
        by: "gender",
        male: "studio/ash",
        female: "studio/ash",
        other: "studio/ash",
        ages: childOf("studio/bea"),
      }),
    ],
  ])(
    "is what a run renders a speaker with no voice of their own in (%s); the Narrator keeps theirs",
    async (_, characterVoice) => {
      const api = testApi();
      const endpoint = speechEndpoint({
        voices: [
          { id: "ash", gender: "m", label: "Ash" },
          { id: "bea", gender: "f", label: "Bea" },
        ],
      });
      const id = await voicedBook(api, {
        endpoints: [endpoint],
        paragraphs: story(5),
        voiceOf: "studio/ash",
      });
      // everyone but the Narrator back to no voice of their own
      const cast = (await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`)).body
        .characters;
      for (const c of cast.filter((c) => c.name !== "Narrator"))
        await api.request(`/api/books/${id}/characters/${encodeURIComponent(c.name)}`, {
          ...jsonBody({ ...c, voice: null, age: "child" }),
          method: "PUT",
        });
      await patch(api, id, { characterVoice });

      await narrateChapters(api, id, [1]);
      const lines = (
        await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`)
      ).body.segments;
      const spoken = lines.filter((s) => s.audio.status === "done");
      expect(spoken.some((s) => s.speaker !== "Narrator")).toBe(true);
      for (const s of spoken)
        expect(s.audio.voiceRef).toBe(s.speaker === "Narrator" ? "studio/ash" : "studio/bea");
    },
  );
});

// $15 per million characters, so every line has a price
const twoVoices = speechEndpoint({
  price: 15,
  billing: { unit: "chars", rate: 15 },
  voices: [
    { id: "ash", gender: "m", label: "Ash" },
    { id: "bea", gender: "f", label: "Bea" },
  ],
});

/** Two chapters, everyone read in `studio/ash`; `narrated` chapters rendered. */
async function heard(narrated: number[], endpoint = twoVoices) {
  const api = testApi();
  const id = await voicedBook(api, {
    endpoints: [endpoint],
    paragraphs: [
      "“We are short again,” said Mara.",
      "“Then we count it twice,” said Tobin.",
      "Rain ran down the shutters.",
    ],
    voiceOf: "studio/ash",
    chapters: ["One", "Two"],
  });
  await narrateChapters(api, id, narrated);
  return { api, id };
}

async function recast(api: TestApi, id: string, name: string, over: Partial<Character>) {
  const cast = (await api.request<{ characters: Character[] }>(`/api/books/${id}/cast`)).body;
  const c = cast.characters.find((x) => x.name === name)!;
  await api.request(`/api/books/${id}/characters/${encodeURIComponent(name)}`, {
    ...jsonBody({ ...c, ...over }),
    method: "PUT",
  });
}

const script = async (api: TestApi, id: string, ch: number) =>
  (await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/${ch}/script`)).body
    .segments;
const oldVoice = (api: TestApi, id: string, name: string) =>
  api.request<OldVoice>(`/api/books/${id}/characters/old-voice`, jsonBody({ names: [name] }));
const revoice = (api: TestApi, id: string, name: string, chapters: number[]) =>
  api.request<NarrationQueued>(
    `/api/books/${id}/characters/revoice`,
    jsonBody({ names: [name], chapters }),
  );
const doneBy = (segs: Segment[], speakers: readonly string[]) =>
  segs.filter((s) => s.audio.status === "done" && speakers.includes(s.speaker)).length;

describe("lines left in an old voice", () => {
  test.each([
    // Tobin, a voiceless persona of Mara's, is read in her voice and moves with it
    {
      changed: "Mara",
      setup: { Tobin: { personaOf: "Mara", voice: null } },
      moved: ["Mara", "Tobin"],
    },
    // Tobin falls back to the Narrator; Mara keeps her own
    { changed: "Narrator", setup: { Tobin: { voice: null } }, moved: ["Narrator", "Tobin"] },
  ])(
    "after $changed's voice changes are the lines it moved, chapter by chapter, priced",
    async ({ changed, setup, moved }) => {
      const { api, id } = await heard([1, 2]);
      for (const [name, over] of Object.entries(setup)) await recast(api, id, name, over);
      expect((await oldVoice(api, id, changed)).body.lines).toBe(0);
      await recast(api, id, changed, { voice: "studio/bea" });

      const { body } = await oldVoice(api, id, changed);
      const want = [
        doneBy(await script(api, id, 1), moved),
        doneBy(await script(api, id, 2), moved),
      ];
      expect(want[0]).toBeGreaterThan(0);
      expect(body.chapters.map((c) => [c.id, c.lines])).toEqual([
        [1, want[0]],
        [2, want[1]],
      ]);
      expect(body.lines).toBe(want[0] + want[1]);
      expect(body.cost).toBeGreaterThan(0);
      expect(body.cost).toBeCloseTo(
        body.chapters.reduce((n, c) => n + c.cost!, 0),
        12,
      );
    },
  );

  // Fish takes the speed with the request; the studio's is made here, from the same clip
  const FISH = "https://api.fish.audio/v1";
  const own = (api: TestApi, id: string) => recast(api, id, "Mara", { speed: 1.5 });
  const voice = (api: TestApi, _: string, e: Endpoint) =>
    saveEndpoints(api, [{ ...e, voices: e.voices.map((v) => ({ ...v, speed: 1.5 })) }]);
  test.each([
    ["her own", "sends it", FISH, own, true],
    ["her own", "stretches it", twoVoices.baseUrl, own, false],
    ["her voice's", "sends it", FISH, voice, true],
    ["her voice's", "stretches it", twoVoices.baseUrl, voice, false],
  ])("after a change to %s speed on an endpoint that %s", async (_, __, baseUrl, change, sent) => {
    const endpoint = { ...twoVoices, baseUrl };
    const { api, id } = await heard([1], endpoint);
    await change(api, id, endpoint);
    const { body } = await oldVoice(api, id, "Mara");
    expect(body.lines).toBe(sent ? doneBy(await script(api, id, 1), ["Mara"]) : 0);
    expect(body.lines > 0).toBe(sent);
  });

  test("re-narrate in the new voice just those lines in the chapters asked for, priced as shown", async () => {
    const { api, id } = await heard([1]);
    const before = await script(api, id, 1);
    await recast(api, id, "Mara", { voice: "studio/bea" });
    const shown = (await oldVoice(api, id, "Mara")).body;

    const { status, body } = await revoice(api, id, "Mara", [1, 2]);
    expect(status).toBe(202);
    // two has no clips, so nothing in an old voice: its missing lines are not this run's
    expect(body.skipped).toEqual([{ id: 2, why: "nothing" }]);
    expect(body.jobs.map((j) => j.narrationRun?.reserved)).toEqual([shown.cost!]);
    await api.runner.idle();

    const after = await script(api, id, 1);
    const mara = after.filter((s) => s.speaker === "Mara");
    expect(mara.map((s) => s.audio.voiceRef)).toEqual(mara.map(() => "studio/bea"));
    const others = (segs: Segment[]) =>
      segs.filter((s) => s.speaker !== "Mara").map((s) => [s.id, s.audio.at]);
    expect(others(after)).toEqual(others(before));
    expect((await script(api, id, 2)).every((s) => s.audio.status === "none")).toBe(true);
    expect((await oldVoice(api, id, "Mara")).body).toEqual({ lines: 0, cost: 0, chapters: [] });
  });

  test("are refused for no chapters or an unknown speaker, and over budget leave every clip as it was", async () => {
    const { api, id } = await heard([1]);
    await recast(api, id, "Mara", { voice: "studio/bea" });
    expect((await revoice(api, id, "Mara", [])).status).toBe(400);
    expect((await oldVoice(api, id, "Nobody")).status).toBe(404);
    expect((await revoice(api, id, "Nobody", [1])).status).toBe(404);

    const before = await script(api, id, 1);
    await patch(api, id, { budget: { cap: 0.000001, paused: false } });
    expect((await revoice(api, id, "Mara", [1])).status).toBe(409);
    expect(await script(api, id, 1)).toEqual(before);
  });
});
