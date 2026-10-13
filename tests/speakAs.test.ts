import { describe, expect, test } from "bun:test";
import { newSpeaker, sameReading } from "@/lib/cast";
import { identityGroup, speakAsMoves } from "@/views/scripting/speakAs";
import type { Character, CharacterVoice, SegmentType } from "@/types";

const cast = [
  { name: "Narrator" },
  { name: "Sunny" },
  { name: "Lord of Shadows", personaOf: "Sunny" },
  { name: "Nephis" },
  { name: "Masked Stranger", personaOf: "Nobody" },
  { name: "Grey Fox", personaOf: "Sunny" },
];

describe("identityGroup", () => {
  test("a character and a persona both give the character, then the personas in cast order", () => {
    const group = ["Sunny", "Lord of Shadows", "Grey Fox"];
    expect(identityGroup("Sunny", cast)).toEqual(group);
    expect(identityGroup("Lord of Shadows", cast)).toEqual(group);
  });
  test("a speaker with no personas, an unlinked persona and a name not in the cast are alone", () => {
    expect(identityGroup("Nephis", cast)).toEqual(["Nephis"]);
    expect(identityGroup("Masked Stranger", cast)).toEqual(["Masked Stranger"]);
    expect(identityGroup("Walk-on", cast)).toEqual(["Walk-on"]);
  });
});

describe("speakAsMoves", () => {
  const line = (id: number, speaker: string, type: SegmentType = "dialogue") => ({
    id,
    speaker,
    type,
  });
  const segments = [
    line(1, "Sunny"),
    line(2, "Narrator", "narration"),
    line(3, "Sunny"),
    line(4, "Nephis"),
    line(5, "Lord of Shadows", "thought"),
    line(6, "Grey Fox"),
    line(7, "Sunny", "narration"),
  ];
  const group = identityGroup("Sunny", cast);

  test("this line only", () => {
    expect(speakAsMoves(segments, 3, "Lord of Shadows", group, false)).toEqual([
      { id: 3, from: "Sunny" },
    ]);
  });
  test("with the rest: every later dialogue or thought line of the group, none already there", () => {
    expect(speakAsMoves(segments, 3, "Lord of Shadows", group, true)).toEqual([
      { id: 3, from: "Sunny" },
      { id: 6, from: "Grey Fox" },
    ]);
  });
  test("the line itself already spoken as the choice still moves the rest", () => {
    expect(speakAsMoves(segments, 5, "Lord of Shadows", group, true)).toEqual([
      { id: 6, from: "Grey Fox" },
    ]);
  });
  test("earlier lines and a line not in the chapter are left alone", () => {
    expect(speakAsMoves(segments, 5, "Sunny", group, true)).toEqual([
      { id: 5, from: "Lord of Shadows" },
      { id: 6, from: "Grey Fox" },
    ]);
    expect(speakAsMoves(segments, 99, "Sunny", group, true)).toEqual([]);
  });
});

describe("sameReading", () => {
  const who = (name: string, extra: Partial<Character> = {}): Character => ({
    ...newSpeaker(name, 0),
    gender: "m",
    ...extra,
  });
  const lookup = new Map(
    [
      who("Narrator", { voice: "ep/narrator" }),
      who("Sunny", { voice: "ep/sunny" }),
      who("Lord of Shadows", { personaOf: "Sunny" }),
      who("Grey Fox", { personaOf: "Sunny", style: "gravelly" }),
      who("Kai"),
      who("Effie", { gender: "f" }),
    ].map((c) => [c.name, c]),
  );
  const cv: CharacterVoice = { by: "gender", one: null, male: "ep/m", female: "ep/f", other: null };

  test("a character and a linked persona with no style of their own read alike", () => {
    expect(sameReading("Sunny", "Lord of Shadows", lookup, cv)).toBe(true);
    expect(sameReading("Lord of Shadows", "Sunny", lookup, cv)).toBe(true);
  });
  test("a persona with a style of their own does not", () => {
    expect(sameReading("Sunny", "Grey Fox", lookup, cv)).toBe(false);
    expect(sameReading("Lord of Shadows", "Grey Fox", lookup, cv)).toBe(false);
  });
  test("two speakers sharing the Character voice read alike; another voice does not", () => {
    expect(sameReading("Kai", "Walk-on", lookup, { ...cv, other: "ep/m" })).toBe(true);
    expect(sameReading("Kai", "Effie", lookup, cv)).toBe(false);
    expect(sameReading("Kai", "Sunny", lookup, cv)).toBe(false);
  });
});
