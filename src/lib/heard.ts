// Checking by ear: a line's clip heard back as words, set against the line.
//
// A transcription endpoint hears the clip and writes down what it heard, and with a server that
// gives them (Phonon's `verbose_json`), the time of each word. The line's words and the heard words
// are compared as `wordsOf` compares any two texts, in order, by their longest common subsequence
// (`alignPairs`): a script word in it was heard, one outside it is missing, and a heard word outside
// it was added. Their sum over the line's words is the score; 0 is a clip that says the line.
//
// A heard word carries its time to the script word it matched, and the mark is put on the line's
// own text — the word, not the comma after it — so the Listen page can light each word as it is
// said. A word that was not matched has no mark, and a server that gave no times gives no marks at
// all: a time is never estimated, from the line's length or anything else.
//
// Pure, so the server that writes the finding and a test that reads it agree on it.
import type { HeardLine } from "@/types";
import { tokensOf, wordsOf } from "@/lib/gaps";
import { alignPairs } from "@/lib/scriptHistory";

// ponytail: words are compared as written, so a number spelt one way in the line and heard the
// other ("42" against "forty-two") and a word the dictionary respells both count as misses. The
// upgrade path is to normalise numbers on both sides and leave out words inside a dictionary hit.
/** The share of a line's words that may be missing or added before the clip is called wrong… */
export const MISMATCH_SCORE = 0.2;
/** …and how many there must be at least: one stuttered or dropped word alone is not a wrong clip. */
export const MISMATCH_WORDS = 2;

/** One word as the endpoint heard it, in seconds from the start of the clip. */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export type HeardMatch = Pick<HeardLine, "words" | "score" | "mismatch">;

const LETTER = /[\p{L}\p{N}]/u;
const LAST_LETTER = /[\p{L}\p{N}](?=[^\p{L}\p{N}]*$)/u;

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
  // a token may hold several words ("forty-two"), and is marked only when every one was heard.
  const script: string[] = [];
  const tokenOf: number[] = [];
  const spans: [from: number, to: number][] = [];
  for (const t of tokensOf(text)) {
    const ws = wordsOf(t.text);
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
      for (const x of wordsOf(w.word)) {
        heard.push(x);
        timeOf.push(w);
      }
  else heard.push(...wordsOf(heardText));

  const pairs = alignPairs(script, heard);
  const missing = script.length - pairs.length;
  const added = heard.length - pairs.length;
  const score = (missing + added) / Math.max(1, script.length);
  const mismatch = score > MISMATCH_SCORE && missing + added >= MISMATCH_WORDS;
  if (!timed) return { words: null, score, mismatch };

  const heardAt = new Map(pairs);
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
