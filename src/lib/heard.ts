// Checking by ear: a line's clip heard back as words, set against the line.
//
// A transcription endpoint hears the clip and writes down what it heard, and with a server that
// gives them (Phonon's `verbose_json`), the time of each word. Both sides are put in their spoken
// form first (`spokenWords`): a number as its words ("42" and "forty-two" alike), a Roman numeral
// as its number, Mr/Mrs/Dr in full, no case, punctuation or apostrophes, and a run of one letter as
// that letter once ("Umm" and "Um" alike). What the ear cannot tell apart is not a difference.
//
// The score is the share of the line's letters the clip got wrong: the two spoken forms run
// together without spaces and set side by side by their longest common subsequence, each stretch
// between two that agree costing its longer side — so "gray" heard "grey" is one letter, "TV" heard
// "T V" none, and a word read out letter by letter, or a different line, many. A line is a
// mismatch past `MISMATCH_SCORE` with at least `MISMATCH_LETTERS` wrong, so a dropped "the" in a
// long line, or an "Ah" heard "Uh", passes.
//
// The words are set side by side the same way (`alignPairs`), and a heard word carries its time to
// the script word it matched. The mark is put on the line's own text — the word, not the comma
// after it — so the Listen page can light each word as it is said. A word that was not matched has
// no mark, and a server that gave no times gives no marks at all: a time is never estimated, from
// the line's length or anything else.
//
// Pure, so the server that writes the finding and a test that reads it agree on it.
import { diffChars } from "diff";

import type { HeardLine } from "@/types";
import { tokensOf } from "@/lib/gaps";
import { alignPairs } from "@/lib/scriptHistory";

// ponytail: a word the dictionary respells is still compared as the line writes it, and a year
// heard "nineteen ninety" against "1990" still differs. The upgrade path is checking against the
// text the endpoint was sent, and years read in pairs.
/** The share of a line's letters that may be wrong before the clip is called wrong… */
export const MISMATCH_SCORE = 0.15;
/** …and how many there must be at least: a short line with one sound off is not a wrong clip. */
export const MISMATCH_LETTERS = 4;

/** One word as the endpoint heard it, in seconds from the start of the clip. */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export type HeardMatch = Pick<HeardLine, "words" | "score" | "mismatch">;

const LETTER = /[\p{L}\p{N}]/u;
const LAST_LETTER = /[\p{L}\p{N}](?=[^\p{L}\p{N}]*$)/u;
const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
/** I to XXXIX in capitals, as a chapter, a stage or a king is numbered; a lone "I" is a word. */
const ROMAN = /^(?=[IVX]{2})X{0,3}(?:IX|IV|V?I{0,3})$/;
const ROMAN_VALUE: Record<string, number> = { I: 1, V: 5, X: 10 };
const SAID_AS: Record<string, string> = { mr: "mister", mrs: "missus", dr: "doctor" };

const ONES = (
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen " +
  "sixteen seventeen eighteen nineteen"
).split(" ");
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [
  [1e6, "million"],
  [1e3, "thousand"],
];
const ORDINAL: Record<string, string> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};

/** A whole number as it is said; digits one by one when it is too long, or starts with a 0. */
function numberWords(digits: string): string[] {
  if (digits.length > 9 || (digits.length > 1 && digits[0] === "0"))
    return [...digits].map((d) => ONES[+d]);
  const n = +digits;
  if (n < 20) return [ONES[n]];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[n / 10]];
  const rest = (k: number) => (n % k ? numberWords(String(n % k)) : []);
  if (n < 1000) return [ONES[Math.floor(n / 100)], "hundred", ...rest(100)];
  const [k, name] = SCALES.find(([k]) => n >= k)!;
  return [...numberWords(String(Math.floor(n / k))), name, ...rest(k)];
}

const ordinalOf = (w: string): string =>
  ORDINAL[w] ?? (w.endsWith("y") ? `${w.slice(0, -1)}ieth` : `${w}th`);

const romanValue = (r: string): number =>
  [...r].reduce(
    (sum, c, i) =>
      ROMAN_VALUE[c] < (ROMAN_VALUE[r[i + 1]] ?? 0) ? sum - ROMAN_VALUE[c] : sum + ROMAN_VALUE[c],
    0,
  );

/** One written word as the words it is said as, each lower case, with repeated letters once. */
function spoken(w: string): string[] {
  const said = ROMAN.test(w)
    ? numberWords(String(romanValue(w)))
    : w
        .toLowerCase()
        .replace(/'/g, "")
        .split(/(\d+(?:st|nd|rd|th)?)/)
        .filter(Boolean)
        .flatMap((part) => {
          const num = /^(\d+)(st|nd|rd|th)?$/.exec(part);
          if (!num) return [SAID_AS[part] ?? part];
          const words = numberWords(num[1]);
          if (num[2]) words.push(ordinalOf(words.pop()!));
          return words;
        });
  return said.map((s) => s.replace(/(\p{L})\1+/gu, "$1"));
}

/** A text's words in their spoken form: what an ear can tell apart, and nothing it cannot. */
export function spokenWords(text: string): string[] {
  const plain = text
    .normalize("NFKC")
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  return [...plain.matchAll(WORD)].flatMap(([w]) => spoken(w));
}

/** Letters to change, add or take out to turn `a` into `b`: each unmatched stretch costs its longer side. */
function lettersWrong(a: string, b: string): number {
  let wrong = 0;
  let removed = 0;
  let added = 0;
  for (const run of diffChars(a, b)) {
    if (run.added) added += run.value.length;
    else if (run.removed) removed += run.value.length;
    else {
      wrong += Math.max(removed, added);
      removed = added = 0;
    }
  }
  return wrong + Math.max(removed, added);
}

/**
 * Set what was heard against the line: `words` when the endpoint gave each word's time, else the
 * words of `heardText`, which then count for the score alone.
 */
export function alignHeard(
  text: string,
  words: readonly TimedWord[] | undefined,
  heardText: string,
): HeardMatch {
  // The line's words, each pointing at the token it came from, trimmed to its letters and digits:
  // a token may hold several words ("forty-two", "42"), and is marked only when every one was heard.
  const script: string[] = [];
  const tokenOf: number[] = [];
  const spans: [from: number, to: number][] = [];
  for (const t of tokensOf(text)) {
    const ws = spokenWords(t.text);
    if (!ws.length) continue;
    const last = LAST_LETTER.exec(t.text)!;
    spans.push([t.at + t.text.search(LETTER), t.at + last.index + last[0].length]);
    for (const w of ws) {
      script.push(w);
      tokenOf.push(spans.length - 1);
    }
  }

  const timed = words?.length ? words : undefined;
  const heard: string[] = [];
  const timeOf: TimedWord[] = [];
  if (timed)
    for (const w of timed)
      for (const x of spokenWords(w.word)) {
        heard.push(x);
        timeOf.push(w);
      }
  else heard.push(...spokenWords(heardText));

  const line = script.join("");
  const wrong = lettersWrong(line, heard.join(""));
  const score = line.length ? wrong / line.length : wrong ? 1 : 0;
  const mismatch = score > MISMATCH_SCORE && wrong >= MISMATCH_LETTERS;
  if (!timed) return { words: null, score, mismatch };

  const heardAt = new Map(alignPairs(script, heard));
  const marks: [number, number, number, number][] = [];
  let i = 0;
  spans.forEach(([from, to], token) => {
    const at: TimedWord[] = [];
    let all = true;
    for (; i < script.length && tokenOf[i] === token; i++) {
      const j = heardAt.get(i);
      if (j == null) all = false;
      else at.push(timeOf[j]);
    }
    if (all) marks.push([from, to, at[0].start, at[at.length - 1].end]);
  });
  return { words: marks, score, mismatch };
}
