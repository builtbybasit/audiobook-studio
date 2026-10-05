// Setting what a transcription endpoint heard against the line: which words were heard, where each
// is in the line's text and when in the clip, and whether the clip says something else.
import { describe, expect, test } from "bun:test";

import { alignHeard, type TimedWord } from "@/lib/heard";

/** Words heard a third of a second apart, as a server with word times gives them. */
const timed = (text: string): TimedWord[] =>
  text.split(" ").map((word, i) => ({ word, start: i / 3, end: i / 3 + 0.3 }));

/** What each mark covers of the line, so a test reads as words rather than offsets. */
const marked = (text: string, words: [number, number, number, number][] | null) =>
  words?.map(([from, to]) => text.slice(from, to));

describe("alignHeard", () => {
  test("a clip that says the line marks every word, with its time", () => {
    const text = "We are short again.";
    const r = alignHeard(text, timed("We are short again."), "We are short again.");
    expect(r.score).toBe(0);
    expect(r.mismatch).toBe(false);
    expect(marked(text, r.words)).toEqual(["We", "are", "short", "again"]);
    expect(r.words![2]).toEqual([7, 12, 2 / 3, 2 / 3 + 0.3]);
  });

  test("a word not heard has no mark and counts against the score", () => {
    const text = "We are short again.";
    const r = alignHeard(text, timed("We short again."), "We short again.");
    expect(marked(text, r.words)).toEqual(["We", "short", "again"]);
    expect(r.score).toBe(0.25);
    // one word alone is not a wrong clip
    expect(r.mismatch).toBe(false);
  });

  test("a stutter is one word added, and every word of the line is still marked once", () => {
    const text = "the cat sat";
    const r = alignHeard(text, timed("the the cat sat"), "the the cat sat");
    expect(marked(text, r.words)).toEqual(["the", "cat", "sat"]);
    expect(r.score).toBeCloseTo(1 / 3);
    expect(r.mismatch).toBe(false);
  });

  test("punctuation and case are not words, and a mark covers the word without them", () => {
    const text = "“Mara,” she said — “don’t.”";
    const r = alignHeard(
      text,
      [
        { word: "mara", start: 0, end: 0.4 },
        { word: "She", start: 0.4, end: 0.6 },
        { word: "said,", start: 0.6, end: 0.9 },
        { word: "Don't!", start: 1, end: 1.3 },
      ],
      "mara She said, Don't!",
    );
    expect(r.score).toBe(0);
    expect(marked(text, r.words)).toEqual(["Mara", "she", "said", "don’t"]);
  });

  test("a number heard spelt out is two misses, and calls the clip wrong", () => {
    const text = "It was 42 days.";
    const r = alignHeard(text, timed("It was forty-two days."), "It was forty-two days.");
    expect(marked(text, r.words)).toEqual(["It", "was", "days"]);
    // "42" missing, "forty" and "two" added
    expect(r.score).toBe(0.75);
    expect(r.mismatch).toBe(true);
  });

  test("a clip that says another line is wrong", () => {
    const r = alignHeard("The door was locked.", undefined, "The window was open.");
    expect(r.score).toBe(1);
    expect(r.mismatch).toBe(true);
  });

  test("with no word times the score stands and there are no marks", () => {
    const r = alignHeard("We are short again.", undefined, "We are short again.");
    expect(r).toEqual({ words: null, score: 0, mismatch: false });
    expect(alignHeard("We are short again.", [], "We are short.").words).toBeNull();
  });

  test("an empty line: nothing to mark, and anything heard is added", () => {
    expect(alignHeard("", timed("hm"), "hm")).toEqual({ words: [], score: 1, mismatch: false });
    expect(alignHeard("…", undefined, "")).toEqual({ words: null, score: 0, mismatch: false });
    expect(alignHeard("", undefined, "a whole sentence").mismatch).toBe(true);
  });

  test("offsets slice back to the word, past characters outside the basic plane", () => {
    const text = "Mara 🙂 waved, then — smiling — left.";
    const r = alignHeard(
      text,
      timed("Mara waved then smiling left"),
      "Mara waved then smiling left",
    );
    expect(marked(text, r.words)).toEqual(["Mara", "waved", "then", "smiling", "left"]);
    for (const [from, to] of r.words!) expect(text.slice(from, to)).toMatch(/^\p{L}+$/u);
  });

  test("a hyphenated word is marked only when both halves were heard", () => {
    const text = "A well-known face.";
    const r = alignHeard(text, timed("A well face."), "A well face.");
    expect(marked(text, r.words)).toEqual(["A", "face"]);
    const whole = alignHeard(text, timed("A well known face."), "A well known face.");
    expect(marked(text, whole.words)).toEqual(["A", "well-known", "face"]);
    expect(whole.words![1].slice(2)).toEqual([1 / 3, 2 / 3 + 0.3]);
  });
});
