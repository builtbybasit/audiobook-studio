// The Character voice as the cast store reports it: what a speaker with no voice of their own is
// read in, and a broken Character voice slot among the voices the cast routes to. Stores filled by
// hand — no server — since both are getters over what is already held.
import { beforeEach, describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { narrator, newSpeaker } from "@/lib/cast";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import type { Book, Character, CharacterVoice, Endpoint, Gender } from "@/types";

const speaker = (name: string, gender: Gender, voice: string | null = null): Character => ({
  ...newSpeaker(name, 0),
  gender,
  voice,
});
const endpoint = (id: string, extra: Partial<Endpoint> = {}) =>
  ({
    id,
    name: id.toUpperCase(),
    enabled: true,
    needsKey: false,
    hasKey: true,
    voices: [{ id: "v1", label: "Voice 1", gender: "n" }],
    ...extra,
  }) as unknown as Endpoint;
const byGender = (slots: Partial<CharacterVoice>): CharacterVoice => ({
  by: "gender",
  one: null,
  male: null,
  female: null,
  other: null,
  ...slots,
});

let cast: ReturnType<typeof useCastStore>;
let book: Book;
beforeEach(() => {
  setActivePinia(createPinia());
  cast = useCastStore();
  useEndpointsStore().endpoints = [
    endpoint("ok"),
    endpoint("off", { enabled: false }),
    endpoint("nokey", { needsKey: true, hasKey: false }),
  ];
  useLibraryStore().books = [{ id: "b" } as Book];
  book = useLibraryStore().books[0];
  cast.characters.b = [
    narrator("ok/v1"),
    speaker("Ana", "f"),
    speaker("Bo", "m"),
    speaker("Cy", "?", "ok/v1"),
  ];
});

describe("what a speaker with no voice of their own is read in", () => {
  test("the Narrator's until the book has a Character voice", () => {
    expect(cast.fallbackLabel("b", "Ana")).toBe("Narrator’s voice");
    book.characterVoice = { ...byGender({}), by: "one", one: "ok/v1" };
    expect(cast.fallbackLabel("b", "Ana")).toBe("Character voice");
    // whether or not they have a voice now, and never for the Narrator
    expect(cast.fallbackLabel("b", "Cy")).toBe("Character voice");
    expect(cast.fallbackLabel("b", "Narrator")).toBe("Narrator’s voice");
  });

  test("by gender, an empty slot falls through to the Narrator's", () => {
    book.characterVoice = byGender({ female: "ok/v1" });
    expect(cast.fallbackLabel("b", "Ana")).toBe("Character voice");
    expect(cast.fallbackLabel("b", "Bo")).toBe("Narrator’s voice");
  });
});

describe("routing issues", () => {
  test("a broken Character voice slot is named for the slot, only while someone is read in it", () => {
    book.characterVoice = byGender({ female: "off/v1", male: "gone/v9", other: "nokey/v1" });
    expect(cast.routingIssues("b").map((i) => [i.name, i.kind])).toEqual([
      ["Character voice (female)", "paused"],
      ["Character voice (male)", "missing"],
    ]);
    // Cy, the one speaker of unknown gender, has a voice of their own: "other" is in nobody's use
    cast.characters.b.push(speaker("Dee", "n"));
    expect(cast.routingIssues("b").at(-1)).toMatchObject({
      name: "Character voice (other)",
      kind: "nokey",
      reason: "NOKEY has no API key",
    });
  });

  test("one voice for all is one issue, beside a speaker's own", () => {
    book.characterVoice = { ...byGender({}), by: "one", one: "off/v1" };
    cast.characters.b[3].voice = "gone/v1";
    expect(cast.routingIssues("b").map((i) => i.name)).toEqual(["Cy", "Character voice"]);
    // everyone voiced: the Character voice reads nobody
    for (const c of cast.characters.b) c.voice = "ok/v1";
    expect(cast.routingIssues("b")).toEqual([]);
  });
});
