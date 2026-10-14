// The book's Character voice: what a speaker with no voice of their own is read in, before the
// Narrator's (a linked persona: their character's). `speakerVoice` alone, then through the
// settings route and a real run.
import { describe, expect, test } from "bun:test";

import type { Book, Character, CharacterVoice, Segment } from "@/types";
import { narrator, speakerVoice } from "@/lib/cast";
import { deliveryFor } from "~/narration/cost";
import { story } from "../support/epub";
import {
  jsonBody,
  narrateChapters,
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
  test("gives a linked persona their character's voice and their own style", () => {
    const sunny = { ...speaker("Sunny", "m", "ep/sunny"), style: "dry" };
    const lord = { ...speaker("Lord of Shadows", "m"), style: "cold, distant", personaOf: "Sunny" };
    expect(deliveryFor([narrator("ep/narr"), sunny, lord])("Lord of Shadows")).toEqual({
      voiceRef: "ep/sunny",
      voice: "sunny",
      endpoint: "ep",
      style: "cold, distant",
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

  test("is what a run renders a speaker with no voice of their own in; the Narrator keeps theirs", async () => {
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
        ...jsonBody({ ...c, voice: null }),
        method: "PUT",
      });
    await patch(api, id, { characterVoice: cv({ one: "studio/bea" }) });

    await narrateChapters(api, id, [1]);
    const lines = (await api.request<{ segments: Segment[] }>(`/api/books/${id}/chapters/1/script`))
      .body.segments;
    const spoken = lines.filter((s) => s.audio.status === "done");
    expect(spoken.some((s) => s.speaker !== "Narrator")).toBe(true);
    for (const s of spoken)
      expect(s.audio.voiceRef).toBe(s.speaker === "Narrator" ? "studio/ash" : "studio/bea");
  });
});
