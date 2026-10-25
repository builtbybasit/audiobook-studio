// How a line is said, not written: the pronunciation dictionary, what a voice may be sent
// (`sayable`), and pacing. Render-time only; the book's text is never touched.
import type { Book, LexEntry, Pacing, SampleRate, Segment, TagBracket } from "@/types";
import { heardLines } from "@/lib/siteText";

/** One dictionary substitution, with offsets into the *original* text. */
export interface LexHit {
  /** as written, exactly as matched */
  term: string;
  say: string;
  from: number;
  to: number;
}

export interface Spoken {
  text: string;
  hits: LexHit[];
}

export interface Mark {
  text: string;
  say?: string;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** a term only matches when neither side continues a word */
const WORDY = /[\p{L}\p{N}]/u;

export const termOf = (e: LexEntry): string => e.term.trim();
export const sayOf = (e: LexEntry): string => e.say.trim();
export const active = (list: LexEntry[]): LexEntry[] =>
  list.filter((e) => e.enabled && termOf(e) && sayOf(e));

/** Longest term first, so "Ji Ning" wins over "Ning" at the same position. */
function matcher(list: LexEntry[]): { re: RegExp; byTerm: Map<string, LexEntry> } | null {
  const on = active(list).sort((a, b) => termOf(b).length - termOf(a).length);
  if (!on.length) return null;
  return {
    re: new RegExp(on.map((e) => escape(termOf(e))).join("|"), "giu"),
    byTerm: new Map(on.map((e) => [termOf(e).toLowerCase(), e])),
  };
}

export interface LexMatcher {
  /** Left to right, without overlaps. */
  hits(text: string): LexHit[];
  /** A replacement is never itself re-matched. */
  speak(text: string): Spoken;
}

/** The dictionary made ready once, for a loop over a book's lines. */
export function lexMatcher(list: LexEntry[]): LexMatcher {
  const m = matcher(list);
  const hits = (text: string): LexHit[] => {
    if (!m) return [];
    const out: LexHit[] = [];
    let last = 0;
    for (const found of text.matchAll(m.re)) {
      const from = found.index ?? 0;
      const to = from + found[0].length;
      if (from < last) continue; // already inside a longer hit
      // mid-word: "Ning" inside "Ninghai" is not the name
      if (WORDY.test(text[from - 1] ?? "") || WORDY.test(text[to] ?? "")) continue;
      const e = m.byTerm.get(found[0].toLowerCase());
      if (!e || (e.matchCase && found[0] !== termOf(e))) continue;
      out.push({ term: found[0], say: sayOf(e), from, to });
      last = to;
    }
    return out;
  };
  return {
    hits,
    speak(text) {
      const found = hits(text);
      if (!found.length) return { text, hits: found };
      let out = "";
      let last = 0;
      for (const h of found) {
        out += text.slice(last, h.from) + h.say;
        last = h.to;
      }
      return { text: out + text.slice(last), hits: found };
    },
  };
}

/** `lexMatcher(list).hits`, for one line. */
export const hitsIn = (text: string, list: LexEntry[]): LexHit[] => lexMatcher(list).hits(text);

/** `lexMatcher(list).speak`, for one line. */
export const speak = (text: string, list: LexEntry[]): Spoken => lexMatcher(list).speak(text);

/** What the narrator says for `name`: its own entries applied to it, or null when it has none. */
export function nameSaid(list: LexEntry[], name: string): string | null {
  const own = list.filter((e) => e.speaker === name);
  return own.length ? speak(name, own).text : null;
}

/**
 * The dictionary with `name` said as `says` (null: as written). Word for word when the word counts
 * match, so "Aisha" alone changes too; else the whole name. A plain entry for a changed word is
 * switched off, not lost, as two live entries for one term would fight.
 */
export function sayNameAs(list: LexEntry[], name: string, says: string | null): LexEntry[] {
  const from = name.trim().split(/\s+/);
  const to = (says ?? "").trim().split(/\s+/).filter(Boolean);
  // ponytail: unequal counts map the whole name only; a word-alignment step if that bites
  const pairs = !to.length
    ? []
    : from.length === to.length
      ? from.map((w, i) => [w, to[i]] as const).filter(([w, s]) => w !== s)
      : [[from.join(" "), to.join(" ")] as const];
  const same = (e: LexEntry, term: string) => termOf(e).toLowerCase() === term.toLowerCase();
  const out = list
    .filter((e) => e.speaker !== name || pairs.some(([w]) => same(e, w)))
    .map((e) => (!e.speaker && pairs.some(([w]) => same(e, w)) ? { ...e, enabled: false } : e));
  let id = Math.max(0, ...list.map((e) => e.id));
  for (const [term, say] of pairs) {
    const i = out.findIndex((e) => same(e, term) && e.speaker === name);
    const e: LexEntry = { id: out[i]?.id ?? ++id, term, say, enabled: true, speaker: name };
    if (i < 0) out.push(e);
    else out[i] = e;
  }
  return out;
}

/**
 * What a voice may be sent: Latin letters (books are English), digits, reading punctuation and the
 * symbols a voice says (`+5`, `10%`). Never `[]{}`: Fish reads `[…]` as its own tag.
 */
const SAYABLE =
  /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9\s.,!?;:'"‘’“”\-–—…+%$£€#&/°()<>]/;
const BRACKET_CHARS: Record<TagBracket, string> = { round: "()", square: "[]", angle: "<>" };
/** each closing bracket's opener */
const CLOSES: Record<string, string> = { ")": "(", ">": "<" };
/** Only HTML's own elements, so `<Rare>` in a line is prose. */
const HTML_TAG =
  /<\/?(a|b|i|u|s|p|br|hr|em|strong|small|big|sub|sup|span|font|div|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|h[1-6]|blockquote|code|pre|img)\b[^<>]*>/iy;
/** read as the end of a sentence */
const BLOCK = /^(br|p|div|li|ul|ol|table|tr|td|th|h[1-6])$/i;
/** A footnote reference, `[1]`. */
const FOOTNOTE = /\[\d{1,3}\]/y;

/**
 * A line as a voice is sent it, before tags: only `SAYABLE`, less the voice's tag `brackets`; HTML
 * tags, footnotes and a whole-line single quote out. `at` maps an offset in `text` into the result.
 * A line left with no letter or digit is kept as is.
 */
export function sayable(
  text: string,
  brackets: readonly TagBracket[] = [],
): { text: string; at: (i: number) => number } {
  const tagChars = brackets.map((b) => BRACKET_CHARS[b]).join("");
  const open = text.search(/\S/);
  const close = text.trimEnd().length - 1;
  const quoted = open < close && /['‘]/.test(text[open]) && /['’]/.test(text[close]);
  let out = "";
  const map: number[] = [];
  for (let i = 0; i < text.length;) {
    HTML_TAG.lastIndex = FOOTNOTE.lastIndex = i;
    const cut = HTML_TAG.exec(text) ?? FOOTNOTE.exec(text);
    if (cut) {
      for (let j = 0; j < cut[0].length; j++) map[i + j] = out.length;
      if (cut[1] && BLOCK.test(cut[1]) && out.trim()) {
        if (WORDY.test(out.trimEnd().at(-1)!)) out = out.trimEnd() + ".";
        if (!/\s$/.test(out)) out += " ";
      }
      i += cut[0].length;
      continue;
    }
    map[i] = out.length;
    const c = text[i];
    if (SAYABLE.test(c) && !tagChars.includes(c) && !(quoted && (i === open || i === close))) {
      // a bracket with nothing said in it (a kaomoji's, once its face is gone) is dropped
      const opened = CLOSES[c] ? out.lastIndexOf(CLOSES[c]) : -1;
      if (opened >= 0 && !WORDY.test(out.slice(opened))) out = out.slice(0, opened).trimEnd();
      else out += c;
    }
    i++;
  }
  map[text.length] = out.length;
  const said = out.trim();
  if (said === text || !WORDY.test(said)) return { text, at: (i) => i };
  const lead = out.length - out.trimStart().length;
  return { text: said, at: (i) => Math.min(Math.max(map[i] - lead, 0), said.length) };
}

/** Runs of the original text, so the reader can underline what is said differently. */
export function marks(text: string, list: LexEntry[]): Mark[] {
  const hits = hitsIn(text, list);
  if (!hits.length) return [{ text }];
  const out: Mark[] = [];
  let last = 0;
  for (const h of hits) {
    if (h.from > last) out.push({ text: text.slice(last, h.from) });
    out.push({ text: h.term, say: h.say });
    last = h.to;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// ---------- pacing ----------
// Silence between lines is stitched, not rendered, so changing it stales no audio. `inlineShort`
// and `inlineLong` are the exception: pauses inside a line are sent with it, so they do.

export const DEFAULT_PACING: Pacing = { line: 0.35, turn: 0.7, inlineShort: 0.4, inlineLong: 1 };
/** offered in the reader; `null` = back to the book default */
export const PAUSE_STEPS: (number | null)[] = [null, 0, 0.25, 0.5, 1, 1.5, 2.5];

export const pacingOrDefault = (p: Pacing | undefined): Pacing => ({ ...DEFAULT_PACING, ...p });

/** The book's gap after `s`, ignoring the line's override. */
export function defaultPause(s: Segment, next: Segment | undefined, pacing: Pacing): number {
  if (!next) return 0;
  return next.speaker === s.speaker ? pacing.line : pacing.turn;
}

export function pauseAfter(s: Segment, next: Segment | undefined, pacing: Pacing): number {
  if (!next) return 0;
  return s.pause ?? defaultPause(s, next, pacing);
}

export interface TimelineClip {
  s: Segment;
  start: number;
  end: number;
  gap: number;
}

/**
 * A chapter as it plays: the heard clips on one clock, with the silence after each measured to the
 * next clip that plays. The one layout every player and scrubber reads.
 */
export function chapterTimeline(
  segments: Segment[],
  pacing: Pacing,
  book: Pick<Book, "readNotes"> | undefined,
): TimelineClip[] {
  const heard = heardLines(segments, book);
  let t = 0;
  return heard.map((s, i) => {
    const start = t;
    const end = start + s.audio.duration;
    const gap = pauseAfter(s, heard[i + 1], pacing);
    t = end + gap;
    return { s, start, end, gap };
  });
}

export function silenceOf(
  segments: Segment[],
  pacing: Pacing,
  book: Pick<Book, "readNotes"> | undefined,
): number {
  return chapterTimeline(segments, pacing, book).reduce((a, x) => a + x.gap, 0);
}

export const chapterSeconds = (
  segments: Segment[],
  pacing: Pacing,
  book: Pick<Book, "readNotes"> | undefined,
): number => {
  const timeline = chapterTimeline(segments, pacing, book);
  // summed as two totals, clips then silence, so float rounding matches stored figures
  return (
    timeline.reduce((a, x) => a + x.s.audio.duration, 0) + timeline.reduce((a, x) => a + x.gap, 0)
  );
};

/** 1s, 1.75s, 0.35s */
export const secs = (n: number): string => `${Number(n.toFixed(2))}s`;

// ---------- voice instructions ----------

/**
 * The voice instructions sent beside a line, often metered. Composed in one place so the billed
 * count and the clip's record are the same string.
 */
export function speechInstructions(parts: { style?: string; direction?: string }): string {
  return [parts.style?.trim(), parts.direction?.trim()].filter(Boolean).join(". ");
}

/** The server refuses any other. */
export const SAMPLE_RATES: readonly SampleRate[] = [16000, 22050, 24000, 32000, 44100, 48000];

/** 44100 → "44.1 kHz", 16000 → "16 kHz". */
export const sampleRateLabel = (hz: number): string => `${Number((hz / 1000).toFixed(2))} kHz`;
