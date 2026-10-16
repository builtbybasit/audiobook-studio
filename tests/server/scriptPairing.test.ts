// Pairing a file chapter with a book chapter whose words changed a little, and moving the lines
// onto the book's words. Pure functions: no book, no server.
import { describe, expect, test } from "bun:test";

import type { Segment } from "@/types";
import { wordsOf } from "@/lib/gaps";
import { fromFileLine, writeMarkers } from "@/lib/scriptFile";
import { fidelity } from "~/providers/chatScripting";
import { pairByText, retext } from "~/script/pairing";
import { line, story } from "../support/epub";

/** Marked lines as the import reads them: `{sigh?}` (a tag awaiting review) becomes an expression. */
function segments(lines: string[]): Segment[] {
  let n = 0;
  return lines.map((text, i) =>
    fromFileLine({ speaker: "Narrator", type: "narration", text }, i + 1, [], () => ++n),
  );
}

describe("moving the lines onto the book's words", () => {
  test.each([
    [
      "a fixed typo goes into the line that held it, with the book's punctuation",
      ["The lamp burnt, low.", "{sigh?} said Mara."],
      "The lamp burned; low. said Mara.",
      ["The lamp burned; low.", "{sigh?} said Mara."],
      [1],
    ],
    [
      "a new word goes to the line holding the word before it",
      ["The lamp burned", "low tonight."],
      "The lamp burned very low tonight.",
      ["The lamp burned very", "low tonight."],
      [1],
    ],
    [
      "a new first word goes before the first",
      ["lamp burned."],
      "The lamp burned.",
      ["The lamp burned."],
      [1],
    ],
    [
      "a dropped word leaves its line, the marker before it staying put",
      ["We are {sigh?} truly short."],
      "We are short.",
      ["We are {sigh?} short."],
      [1],
    ],
    [
      "a marker inside a changed word moves to its nearer edge",
      ["We are sh{sigh?}ort again."],
      "We are long again.",
      ["We are {sigh?} long again."],
      [1],
    ],
    [
      "a word the book joined is rewritten whole",
      ["It was to-day, she said."],
      "It was today, she said.",
      ["It was today, she said."],
      [1],
    ],
    [
      "a line the book no longer has is dropped and the rest renumbered",
      ["We are short.", "Yes.", "Go."],
      "We are short. Go.",
      ["We are short.", "Go."],
      [],
    ],
    [
      "a line split inside a word the book kept is left alone",
      ["He said—", "“Halt!”"],
      "He said—“Halt!”",
      ["He said—", "“Halt!”"],
      [],
    ],
  ])("%s", (_, lines, book, want, retexted) => {
    const got = retext(segments(lines), book);
    expect(got.segments.map((s) => writeMarkers(s.text, s.expressions))).toEqual(want);
    expect(got.retexted).toEqual(retexted);
    expect(got.segments.map((s) => s.id)).toEqual(want.map((_, i) => i + 1));
    expect(fidelity(book, got.segments)).toMatchObject({ missing: 0, added: 0 });
  });
});

describe("pairing by text", () => {
  test.each([
    ["short", line("Author's note")],
    ["long", story(4).join(" ")],
  ])("two identical %s chapters pair by nearest place, not by list order", (_, note) => {
    const words = wordsOf(note);
    const edition = [...words.slice(0, -1), "changed"];
    const got = pairByText(
      [
        { position: 0, words },
        { position: 9, words },
      ],
      [
        { position: 9, words: edition },
        { position: 0, words: edition },
      ],
    );
    expect(got.map((p) => p.book)).toEqual([1, 0]);
  });

  test("900 chapters, each a few words off, pair with their own in a few seconds", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const vocabulary = Array.from({ length: 5000 }, (_, i) => `w${i.toString(36)}`);
    const book = Array.from({ length: 900 }, (_, position) => ({
      position,
      words: Array.from(
        { length: 1500 + Math.floor(random() * 1500) },
        () => vocabulary[Math.floor(random() * vocabulary.length)],
      ),
    }));
    // a word changed every 400, as a new edition's fixes would be
    const files = book.map((b) => ({
      position: b.position,
      words: b.words.map((w, i) => (i % 400 === 50 ? "changed" : w)),
    }));
    // shuffled, so a pair is found by its words and not by where it sits in the list
    const shuffled = [...book].sort(() => random() - 0.5);

    const started = performance.now();
    const got = pairByText(files, shuffled);
    // Without the shingle prefilter this is 810,000 diffs: minutes, not seconds.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(got.map((p) => (p.book === undefined ? -1 : shuffled[p.book].position))).toEqual(
      files.map((f) => f.position),
    );
  });
});
