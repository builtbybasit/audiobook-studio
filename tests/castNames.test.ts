// Which of a cast's names a line is written with: what a clip is sent as hints when it is checked
// by ear. Pure over the text, so every way a name is written in a book is one row here.
import { describe, expect, test } from "bun:test";
import { nameWords, namesIn, NARRATOR } from "@/lib/cast";

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
