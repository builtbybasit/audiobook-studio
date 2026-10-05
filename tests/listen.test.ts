// Reading along: a line's text cut at the words a check by ear heard, and which of them is being
// said. A word is lit only from a time the transcriber gave it; a line whose text no longer matches
// what was checked, or that has no times at all, gets no marks and lights up whole.
import { describe, expect, test } from "bun:test";

import { markAt, marksFor, piecesOf, type WordMark } from "@/lib/listen";

const joined = (text: string, marks: WordMark[]) =>
  piecesOf(text, marks)
    .map((p) => p.text)
    .join("");

describe("marksFor", () => {
  const words: WordMark[] = [[0, 5, 0.1, 0.4]];

  test("are the heard words when the line still says what was checked", () => {
    expect(marksFor({ text: "Hello there." }, { text: "Hello there.", words })).toBe(words);
  });

  test("are none for a line edited since it was checked", () => {
    expect(marksFor({ text: "Hello, there." }, { text: "Hello there.", words })).toBe(null);
  });

  test("are none for a line never checked, or checked without word times", () => {
    expect(marksFor({ text: "Hello there." }, undefined)).toBe(null);
    expect(marksFor({ text: "Hello there." }, { text: "Hello there.", words: null })).toBe(null);
    expect(marksFor({ text: "Hello there." }, { text: "Hello there.", words: [] })).toBe(null);
  });
});

describe("piecesOf", () => {
  test("with no marks is the whole text, plain", () => {
    expect(piecesOf("Not a word heard.", [])).toEqual([{ text: "Not a word heard.", mark: null }]);
    expect(piecesOf("", [])).toEqual([]);
  });

  test("cuts the text between words into plain pieces", () => {
    const text = "Run, she said.";
    const marks: WordMark[] = [
      [0, 3, 0, 0.3],
      [5, 8, 0.4, 0.6],
      [9, 13, 0.6, 0.9],
    ];
    expect(piecesOf(text, marks)).toEqual([
      { text: "Run", mark: 0 },
      { text: ", ", mark: null },
      { text: "she", mark: 1 },
      { text: " ", mark: null },
      { text: "said", mark: 2 },
      { text: ".", mark: null },
    ]);
  });

  test("keeps adjacent marks apart, with nothing between them", () => {
    expect(
      piecesOf("abcdef", [
        [0, 3, 0, 1],
        [3, 6, 1, 2],
      ]),
    ).toEqual([
      { text: "abc", mark: 0 },
      { text: "def", mark: 1 },
    ]);
  });

  test("leaves a word the transcriber did not hear as plain text", () => {
    // "quietly" was not heard, so it has no mark of its own
    const pieces = piecesOf("She left quietly.", [
      [0, 3, 0, 0.2],
      [4, 8, 0.2, 0.5],
    ]);
    expect(pieces.at(-1)).toEqual({ text: " quietly.", mark: null });
  });

  test("covers the text exactly, whatever the marks", () => {
    const text = "Over the hills and far away";
    for (const marks of [
      [[0, 4, 0, 1]],
      [[23, 27, 3, 4]],
      [[0, 27, 0, 4]],
      [
        [0, 4, 0, 1],
        [2, 8, 1, 2], // overlaps the one before
        [25, 40, 3, 4], // runs past the end
      ],
    ] as WordMark[][])
      expect(joined(text, marks)).toBe(text);
  });

  test("counts in UTF-16, as the marks do", () => {
    const text = "Café 🌙 noir";
    // "🌙" is two UTF-16 units, so "noir" starts at 8
    const marks: WordMark[] = [
      [0, 4, 0, 0.3],
      [5, 7, 0.3, 0.5],
      [8, 12, 0.5, 0.8],
    ];
    expect(piecesOf(text, marks).filter((p) => p.mark != null)).toEqual([
      { text: "Café", mark: 0 },
      { text: "🌙", mark: 1 },
      { text: "noir", mark: 2 },
    ]);
    expect(joined(text, marks)).toBe(text);
  });
});

describe("markAt", () => {
  const marks: WordMark[] = [
    [0, 3, 0.1, 0.4],
    [4, 7, 0.5, 0.8],
    [8, 11, 0.8, 1.2], // starts the instant the one before ends
    [12, 15, 1.6, 2.0],
  ];

  test("is the word whose time holds t", () => {
    expect(markAt(marks, 0.1)).toBe(0);
    expect(markAt(marks, 0.39)).toBe(0);
    expect(markAt(marks, 0.6)).toBe(1);
    expect(markAt(marks, 1.9)).toBe(3);
  });

  test("hands over at the boundary between two words", () => {
    expect(markAt(marks, 0.8)).toBe(2);
  });

  test("is none in the silence between words", () => {
    expect(markAt(marks, 0.45)).toBe(-1);
    expect(markAt(marks, 1.4)).toBe(-1);
  });

  test("is none before the first word and after the last", () => {
    expect(markAt(marks, 0)).toBe(-1);
    expect(markAt(marks, -1)).toBe(-1);
    expect(markAt(marks, 2.0)).toBe(-1);
    expect(markAt(marks, 99)).toBe(-1);
  });

  test("is none with no marks", () => {
    expect(markAt([], 1)).toBe(-1);
  });

  test("finds every word of a long line", () => {
    const many: WordMark[] = Array.from({ length: 500 }, (_, i) => [i * 2, i * 2 + 1, i, i + 0.5]);
    for (let i = 0; i < 500; i++) {
      expect(markAt(many, i + 0.25)).toBe(i);
      expect(markAt(many, i + 0.75)).toBe(-1);
    }
  });
});
