// Which of a cast's names a line is written with: what a clip is sent as hints when it is checked
// by ear. Pure over the text, so every way a name is written in a book is one row here.
import { describe, expect, test } from "bun:test";
import { castNameFor, chapterCast, nameWords, namesIn, NARRATOR } from "@/lib/cast";

const words = nameWords([
  { name: NARRATOR, aliases: ["Storyteller"] },
  { name: "Noel Rowe", aliases: ["Little Noel"] },
  { name: "Julien D. Evenus", aliases: [] },
  { name: "The man", aliases: [] },
  { name: "Will Turner", aliases: [] },
  { name: "O’Brien", aliases: [] },
  { name: "Jean-Luc", aliases: [] },
  { name: "James", aliases: [] },
]);

describe("the words a cast is named by", () => {
  test("are its names' and aliases' capitalised words, never a title, an initial or the narrator's", () => {
    expect([...words.values()].sort()).toEqual(
      [
        "Evenus",
        "James",
        "Jean",
        "Julien",
        "Little",
        "Luc",
        "Noel",
        "O'Brien",
        "Rowe",
        "Turner",
        "Will",
      ].sort(),
    );
  });
});

describe("the names a line is written with", () => {
  test.each([
    ["a possessive", "Noel's worried voice reached my ears.", ["Noel"]],
    ["a bare possessive", "James' hat was gone.", ["James"]],
    ["in single quotes", "‘Noel’ she said, and then 'Noel' again.", ["Noel"]],
    ["in capitals", "NOEL! Get back here!", ["Noel"]],
    ["a stutter", "N-Noel?", ["Noel"]],
    ["before a dash", "Noel--wait. Rowe—no.", ["Noel", "Rowe"]],
    ["either apostrophe", "O'Brien came, then O’Brien left.", ["O'Brien"]],
    ["half a hyphenated name", "Jean said nothing.", ["Jean"]],
    [
      "the line's order, each once",
      "Rowe, said Julien. “Rowe!” Noel’s brother.",
      ["Rowe", "Julien", "Noel"],
    ],
    ["a name written as a word", "I will go, said the man.", []],
    ["a name starting a sentence", "Will you come?", ["Will"]],
    ["nobody", "The rain kept on.", []],
  ])("%s", (_, line, expected) => {
    expect(namesIn(line, words)).toEqual(expected);
  });
});

describe("the cast member a scripting model meant", () => {
  const cast = [
    { name: NARRATOR, aliases: [] },
    // lines written by "Hero" must not become a second character beside him
    { name: "Young Soldier", aliases: ["Hero"] },
    { name: "Gentle-Voiced Slave", aliases: ["Scholar"] },
    // that run's leftover: a character of the alias's name, until it is merged by hand
    { name: "Scholar", aliases: [] },
    { name: "Kel", aliases: ["the Captain"] },
    { name: "Wren", aliases: ["the captain"] },
  ];
  const meant = (speaker: string) => castNameFor(speaker, cast);

  test("by one of their other names, in any case", () => {
    expect(meant("Hero")).toBe("Young Soldier");
    expect(meant("hero")).toBe("Young Soldier");
    expect(meant("young soldier")).toBe("Young Soldier");
  });

  test("is a name in the cast as written, before anyone's other name", () => {
    expect(meant("Scholar")).toBe("Scholar");
    expect(meant(NARRATOR)).toBe(NARRATOR);
  });

  test("leaves a name that is nobody's, or could be two members', as written", () => {
    expect(meant("the Captain")).toBe("the Captain");
    expect(meant("Unknown")).toBe("Unknown");
    expect(meant("Soldier")).toBe("Soldier");
    expect(meant("Heroes")).toBe("Heroes");
  });

  // A guard: a speaker copied with the cast list's "(male; also called Hero)" must not be new.
  test("by a cast name with a bracket note after it", () => {
    expect(meant("Young Soldier (male)")).toBe("Young Soldier");
    expect(meant("Hero (male)")).toBe("Young Soldier");
  });
});

describe("the cast a chapter's prompt lists", () => {
  const cast = [
    { name: NARRATOR },
    { name: "Sunny", aliases: ["Sunless"] },
    { name: "Young Soldier", aliases: ["Hero"] },
    { name: "Jet", aliases: ["Master Jet"] },
    { name: "Caster" },
    { name: "Lord of Shadows", personaOf: "Sunny" },
    { name: "the Black Mask", masked: true },
    { name: "Nephis" },
    { name: "Kai" },
  ];
  const names = (text: string, recent: string[] = []) =>
    chapterCast(cast, text, new Set(recent)).map((c) => c.name);

  test("is who the chapter names, by a name or another name, in any case", () => {
    expect(names("“Stand up,” HERO said. Master Jet sighed.")).toContain("Young Soldier");
    expect(names("“Stand up,” HERO said. Master Jet sighed.")).toContain("Jet");
    expect(names("the young soldier")).toContain("Young Soldier");
  });

  test("by a whole name only, never a word that starts or holds one", () => {
    expect(names("Kaiser and the castersoft, Jetty.")).not.toContain("Kai");
    expect(names("Kaiser and the castersoft, Jetty.")).not.toContain("Caster");
    expect(names("Kaiser and the castersoft, Jetty.")).not.toContain("Jet");
    expect(names("Kai's sword")).toContain("Kai");
  });

  test("keeps who spoke just before, though the chapter only says “he”", () => {
    expect(names("He did not answer.", ["Caster"])).toContain("Caster");
  });

  test("keeps every disguise, and whoever wears one, for a reveal chapters later", () => {
    expect(names("Nothing happens.")).toEqual([
      NARRATOR,
      "Sunny",
      "Lord of Shadows",
      "the Black Mask",
    ]);
  });

  test("leaves out the rest, in the cast's order", () => {
    expect(names("Nephis looked at Sunless.")).toEqual([
      NARRATOR,
      "Sunny",
      "Lord of Shadows",
      "the Black Mask",
      "Nephis",
    ]);
  });
});
