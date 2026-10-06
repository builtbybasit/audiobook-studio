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
// the script word it matched — and, for a few words heard as something like them between two that
// matched ("gray" heard "grey", "TV" heard "T V"), the time of what was heard in their place, word
// by word as their letters line up. The mark is put on the line's own text — the word, not the
// comma after it — so the Listen page can light each word as it is said. A word heard as nothing,
// or as something unlike it, has no mark, and a server that gave no times gives no marks at all: a
// time is never estimated, from the line's length or anything else.
//
// Pure, so the server that writes the finding and a test that reads it agree on it.
import { diffChars } from "diff";

import type { HeardLine } from "@/types";
import { tokensOf } from "@/lib/gaps";
import type { LexHit } from "@/lib/speech";
import { alignPairs } from "@/lib/scriptHistory";

// ponytail: a year heard "nineteen ninety" against "1990" still differs; years read in pairs are
// the upgrade if it shows up in real checks.
/** The share of a line's letters that may be wrong before the clip is called wrong… */
export const MISMATCH_SCORE = 0.15;
/** …and how many there must be at least: a short line with one sound off is not a wrong clip. */
export const MISMATCH_LETTERS = 4;

/** Written words heard as something else take its time when at least this share of letters agree… */
export const MISHEARD_ALIKE = 0.5;
/** …and they are no more than this many in a row: past that, it is another sentence. */
export const MISHEARD_WORDS = 3;

/** When a word was said, in seconds from the start of the clip. */
type Span = Pick<TimedWord, "start" | "end">;

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

/** Each letter of `words`, as the index of the word it is in. */
const lettersOf = (words: readonly string[]): number[] =>
  words.flatMap((w, k) => Array.from({ length: w.length }, () => k));

/**
 * Written words heard as something else, each given the time of the heard words its own letters
 * line up with — "TV" heard "T V" the time from "T" to "V" — or nothing for every one when the two
 * sound too little alike to be the same words (`MISHEARD_ALIKE`). A written word none of whose
 * letters line up with any heard has no time.
 */
function misheard(
  written: readonly string[],
  said: readonly string[],
  times: readonly Span[],
): (Span | undefined)[] {
  const a = lettersOf(written);
  const b = lettersOf(said);
  // [written word, heard word] for each letter that lines up: a letter in common with its own, and
  // a stretch where they differ letter by letter, in proportion
  const pairs: [number, number][] = [];
  let ia = 0;
  let ib = 0;
  let alike = 0;
  let removed = 0;
  let added = 0;
  const differ = () => {
    if (added)
      for (let k = 0; k < removed; k++)
        pairs.push([a[ia - removed + k], b[ib - added + Math.floor((k * added) / removed)]]);
    removed = added = 0;
  };
  for (const run of diffChars(written.join(""), said.join(""))) {
    const n = run.value.length;
    if (run.added) {
      added += n;
      ib += n;
    } else if (run.removed) {
      removed += n;
      ia += n;
    } else {
      differ();
      for (let k = 0; k < n; k++) pairs.push([a[ia + k], b[ib + k]]);
      ia += n;
      ib += n;
      alike += n;
    }
  }
  differ();
  if (alike < MISHEARD_ALIKE * Math.max(a.length, b.length)) return [];

  const out: (Span | undefined)[] = [];
  for (const [w, h] of pairs) {
    const t = times[h];
    const was = out[w];
    out[w] = was ? { start: Math.min(was.start, t.start), end: Math.max(was.end, t.end) } : t;
  }
  return out;
}

/** The line's words in their spoken form, each pointing at the stretch of the line it is said for. */
interface Written {
  script: string[];
  tokenOf: number[];
  spans: [from: number, to: number][];
}

/**
 * The line's words, each pointing at the token it came from, trimmed to its letters and digits: a
 * token may hold several words ("forty-two", "42"), and is marked only when every one was heard. A
 * dictionary hit stands as the words it is sent as, over the whole term as written ("Ji Ning").
 */
function writtenOf(text: string, hits: readonly LexHit[]): Written {
  const out: Written = { script: [], tokenOf: [], spans: [] };
  const add = (from: number, to: number, ws: readonly string[]) => {
    out.spans.push([from, to]);
    for (const w of ws) {
      out.script.push(w);
      out.tokenOf.push(out.spans.length - 1);
    }
  };
  let at = 0;
  const plain = (until: number) => {
    for (const t of tokensOf(text.slice(at, until))) {
      const ws = spokenWords(t.text);
      if (!ws.length) continue;
      const last = LAST_LETTER.exec(t.text)!;
      add(at + t.at + t.text.search(LETTER), at + t.at + last.index + last[0].length, ws);
    }
  };
  for (const h of hits) {
    plain(h.from);
    const ws = spokenWords(h.say);
    if (ws.length) add(h.from, h.to, ws);
    at = h.to;
  }
  plain(text.length);
  return out;
}

/**
 * Set what was heard against the line: `words` when the endpoint gave each word's time, else the
 * words of `heardText`, which then count for the score alone.
 *
 * `hits` are the dictionary's substitutions in the line as its clip was sent (`speak`): the voice
 * was given "El-oh-wen" for "Elowen", and a transcriber may write either. So the line is set
 * against what was heard both as written and as sent, and whichever is heard the closer stands.
 */
export function alignHeard(
  text: string,
  words: readonly TimedWord[] | undefined,
  heardText: string,
  hits: readonly LexHit[] = [],
): HeardMatch {
  const asWritten = matchOf(writtenOf(text, []), words, heardText);
  if (!hits.length) return asWritten;
  const asSent = matchOf(writtenOf(text, hits), words, heardText);
  return asSent.score < asWritten.score ? asSent : asWritten;
}

function matchOf(
  { script, tokenOf, spans }: Written,
  words: readonly TimedWord[] | undefined,
  heardText: string,
): HeardMatch {
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

  // Each script word the time of the heard word it matched — and a stretch of a few between two
  // that matched, heard as something like it ("gray" heard "grey"), the time of what was heard in
  // its place (`misheard`): the server's own time still, never estimated. A word heard as nothing,
  // or heard as something unlike it, has none.
  const pairs = alignPairs(script, heard);
  const timeAt = new Map<number, Span>(pairs.map(([i, j]) => [i, timeOf[j]]));
  const ends = [[-1, -1], ...pairs, [script.length, heard.length]];
  for (let k = 1; k < ends.length; k++) {
    const [i0, j0] = ends[k - 1];
    const [i1, j1] = ends[k];
    if (i1 - i0 - 1 < 1 || i1 - i0 - 1 > MISHEARD_WORDS || j1 - j0 - 1 < 1) continue;
    misheard(script.slice(i0 + 1, i1), heard.slice(j0 + 1, j1), timeOf.slice(j0 + 1, j1)).forEach(
      (t, x) => t && timeAt.set(i0 + 1 + x, t),
    );
  }

  // A token is marked when every word of it has a time. One that starts no later than the mark just
  // before it — both heard in one word, "forty two" heard "42" — joins that mark, so each word heard
  // lights one stretch of the line.
  const marks: [number, number, number, number][] = [];
  let joins = false;
  let i = 0;
  spans.forEach(([from, to], token) => {
    const at: Span[] = [];
    let all = true;
    for (; i < script.length && tokenOf[i] === token; i++) {
      const t = timeAt.get(i);
      if (t == null) all = false;
      else at.push(t);
    }
    const start = all ? Math.min(...at.map((t) => t.start)) : 0;
    const end = all ? Math.max(...at.map((t) => t.end)) : 0;
    const before = marks.at(-1);
    if (!all) joins = false;
    else if (joins && before && start <= before[2]) {
      before[1] = to;
      before[3] = Math.max(before[3], end);
    } else {
      marks.push([from, to, start, end]);
      joins = true;
    }
  });
  return { words: marks, score, mismatch };
}
