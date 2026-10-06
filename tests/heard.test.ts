// Setting what a transcription endpoint heard against the line: which words were heard, where each
// is in the line's text and when in the clip, and whether the clip says something else.
import { describe, expect, test } from "bun:test";

import { alignHeard, spokenWords, type TimedWord } from "@/lib/heard";

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
    // "are" is three of the line's fifteen letters
    expect(r.score).toBe(0.2);
    // one short word alone is not a wrong clip
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

  test("a number heard spelt out is the number, and its mark covers it", () => {
    const text = "It was 42 days.";
    const r = alignHeard(text, timed("It was forty-two days."), "It was forty-two days.");
    expect(marked(text, r.words)).toEqual(["It", "was", "42", "days"]);
    expect(r.words![2].slice(2)).toEqual([2 / 3, 2 / 3 + 0.3]);
    expect(r.score).toBe(0);
  });

  test("a clip that says another line is wrong", () => {
    const r = alignHeard("The door was locked.", undefined, "The window was open.");
    expect(r.score).toBeGreaterThan(0.3);
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

  test("a word heard as something like it takes the time of what was heard", () => {
    const text = "Two gray eyes stared.";
    const r = alignHeard(text, timed("Two grey eyes stared."), "");
    expect(marked(text, r.words)).toEqual(["Two", "gray", "eyes", "stared"]);
    expect(r.words![1].slice(2)).toEqual([1 / 3, 1 / 3 + 0.3]);
  });

  test("a word heard letter by letter is lit from its first letter to its last", () => {
    const text = "Inside the TV screen.";
    const r = alignHeard(text, timed("Inside the T V screen."), "");
    expect(marked(text, r.words)).toEqual(["Inside", "the", "TV", "screen"]);
    expect(r.words![2].slice(2)).toEqual([2 / 3, 1 + 0.3]);
  });

  test("two words heard as one are lit as one", () => {
    const text = "She was forty two today.";
    const r = alignHeard(text, timed("She was 42 today."), "");
    expect(marked(text, r.words)).toEqual(["She", "was", "forty two", "today"]);
  });

  test("a word heard as nothing, or as something unlike it, stays dark", () => {
    const text = "Don't worry about it.";
    expect(marked(text, alignHeard(text, timed("Worry about it."), "").words)).toEqual([
      "worry",
      "about",
      "it",
    ]);
    const lost = "This is the last step, right?";
    const r = alignHeard(lost, timed("This is fancy and gonin right?"), "");
    expect(marked(lost, r.words)).toEqual(["This", "is", "right"]);
  });

  test("a longer stretch heard alike is another sentence, and stays dark", () => {
    const text = "Then Elowen Thornfield Merrin Vance left.";
    const r = alignHeard(text, timed("Then Elloin Thornfeld Marin Vans left."), "");
    expect(marked(text, r.words)).toEqual(["Then", "left"]);
    const three = "Then Elowen Thornfield Vance left.";
    const alike = alignHeard(three, timed("Then Elloin Thornfeld Vans left."), "");
    expect(marked(three, alike.words)).toEqual(["Then", "Elowen", "Thornfield", "Vance", "left"]);
  });

  test("a word the dictionary respells is right heard as written or as sent", () => {
    const text = "Then Siobhan left.";
    const hits = [{ term: "Siobhan", say: "Shiv-awn", from: 5, to: 12 }];
    const sent = alignHeard(text, timed("Then Shiv awn left."), "", hits);
    expect(sent.mismatch).toBe(false);
    expect(marked(text, sent.words)).toEqual(["Then", "Siobhan", "left"]);
    expect(alignHeard(text, timed("Then Siobhan left."), "", hits).score).toBe(0);
    // without the dictionary, the respelling is heard wrong
    expect(alignHeard(text, timed("Then Shiv awn left."), "").mismatch).toBe(true);
  });

  test("a term of two words is marked as one, over both", () => {
    const text = "Ask Ji Ning now.";
    const hits = [{ term: "Ji Ning", say: "Jee Ning", from: 4, to: 11 }];
    const r = alignHeard(text, timed("Ask Jee Ning now."), "", hits);
    expect(marked(text, r.words)).toEqual(["Ask", "Ji Ning", "now"]);
    expect(r.words![1].slice(2)).toEqual([1 / 3, 2 / 3 + 0.3]);
  });

  // lines and what Phonon heard of them, from a real check of a narrated chapter
  test.each([
    [
      "Two lackluster gray eyes seemed fixed on me.",
      "Two lackluster grey eyes seemed fixed on me.",
    ],
    ["I stopped him and pointed toward the TV.", "I stopped him and pointed toward the T V."],
    ["Stage IV Lung Cancer.", "Stage four lung cancer."],
    ["Chapter 1: Prologue", "CHAPTER One ProLogue"],
    ["Umm... So what do you think?", "Um, so what do you think?"],
    ["Yea-h. Tell me why it's your favorite game?", "Yeah. Tell me why it's your favorite game."],
    ["Noel's worried voice reached my ears.", "Noelle's worried voice reached my ears."],
    ["Mr. Thornfield came 2nd.", "Mister Thornfield came second."],
    ["Ah...", "Uh"],
    ["Cough! ...Cou..gh!", "Cough cough."],
  ])("heard right: %p", (text, heard) => {
    expect(alignHeard(text, undefined, heard).mismatch).toBe(false);
  });

  test.each([
    ["'Let me die faster.'", "Let me die F A S T E R punct apostrophe."],
    ["*Sip*", "I'm a manny."],
    [
      "[I've waited far too long for this.]",
      "Ma and dab and to no and uh me and Penopio me to none",
    ],
    ["I'm... Cough! F-fine.", "I'm fine."],
  ])("heard wrong: %p", (text, heard) => {
    expect(alignHeard(text, undefined, heard).mismatch).toBe(true);
  });
});

describe("spokenWords", () => {
  test("numbers, ordinals and Roman numerals are their words", () => {
    expect(spokenWords("1,204 and 2nd and 0.5")).toEqual([
      "one",
      "thousand",
      "two",
      "hundred",
      "four",
      "and",
      "second",
      "and",
      "zero",
      "five",
    ]);
    expect(spokenWords("Stage IV, Book XII, I")).toEqual(["stage", "four", "bok", "twelve", "i"]);
    expect(spokenWords("23rd 90th 3d")).toEqual(["twenty", "third", "ninetieth", "thre", "d"]);
    expect(spokenWords("1000000 007")).toEqual(["one", "milion", "zero", "zero", "seven"]);
  });

  test("case, apostrophes and repeated letters are not told apart", () => {
    expect(spokenWords("Don’t SHIIING Mrs. Dr")).toEqual(["dont", "shing", "misus", "doctor"]);
    expect(spokenWords("MIX")).toEqual(["mix"]);
  });
});
