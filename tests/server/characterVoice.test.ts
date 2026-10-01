// The book's Character voice: what a speaker with no voice of their own is read in, before the
// Narrator's. The rule is `speakerVoice`, shared by the narration job and the page; here it is
// checked on its own, then through the settings route and a real run.
import { describe, expect, test } from "bun:test";

import type { Book, Character, CharacterVoice, Segment } from "@/types";
import { narrator, speakerVoice } from "@/lib/cast";
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

describe("the voice a speaker is read in", () => {
  test("is their own first, whatever the Character voice says", () => {
    const c = speaker("Mara", "f", "ep/mara");
    expect(speakerVoice("Mara", c, "ep/narr", cv({ one: "ep/char" }))).toEqual({
      ref: "ep/mara",
      from: "own",
    });
  });

  test("is the one Character voice for everyone else, and the Narrator's without one", () => {
    const c = speaker("Tobin", "m");
    expect(speakerVoice("Tobin", c, "ep/narr", cv({ one: "ep/char" })).ref).toBe("ep/char");
    expect(speakerVoice("Tobin", c, "ep/narr", undefined)).toEqual({
      ref: "ep/narr",
      from: "narrator",
    });
    // a name not in the cast is a character too
    expect(speakerVoice("Stranger", undefined, "ep/narr", cv({ one: "ep/char" })).from).toBe(
      "character",
    );
  });

  test("by gender picks the speaker's slot, neutral and unknown share `other`, and an empty slot is the Narrator's", () => {
    const g = cv({ by: "gender", one: "ep/one", male: "ep/m", female: "ep/f", other: "ep/o" });
    expect(speakerVoice("A", speaker("A", "m"), "ep/narr", g).ref).toBe("ep/m");
    expect(speakerVoice("B", speaker("B", "f"), "ep/narr", g).ref).toBe("ep/f");
    expect(speakerVoice("C", speaker("C", "n"), "ep/narr", g).ref).toBe("ep/o");
    expect(speakerVoice("D", speaker("D", "?"), "ep/narr", g).ref).toBe("ep/o");
    expect(speakerVoice("A", speaker("A", "m"), "ep/narr", { ...g, male: null })).toEqual({
      ref: "ep/narr",
      from: "narrator",
    });
  });

  test("never applies to the Narrator", () => {
    expect(speakerVoice("Narrator", narrator(null), null, cv({ one: "ep/char" }))).toEqual({
      ref: null,
      from: "narrator",
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
