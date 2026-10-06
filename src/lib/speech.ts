// How a line is *said*, as opposed to how it is written. Two render-time transforms live here and
// neither one touches the book: the per-book pronunciation dictionary rewrites names and invented
// words on their way to the endpoint, and the pacing rules decide how much silence is stitched in
// after each clip. The script the reader shows is always the original prose.
import type { Book, LexEntry, Pacing, SampleRate, Segment, TagBracket } from "@/types";
import { heardLines } from "@/lib/siteText";

/** One dictionary substitution, with offsets into the *original* text. */
export interface LexHit {
  /** the text as it was written, exactly as matched */
  term: string;
  /** what the endpoint is sent instead */
  say: string;
  from: number;
  to: number;
}

export interface Spoken {
  /** the text that actually goes out */
  text: string;
  hits: LexHit[];
}

/** A run of the original text, marked when the dictionary replaces it. */
export interface Mark {
  text: string;
  say?: string;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** letters and digits make a word; a term only matches when neither side continues one */
const WORDY = /[\p{L}\p{N}]/u;

export const termOf = (e: LexEntry): string => e.term.trim();
export const sayOf = (e: LexEntry): string => e.say.trim();
/** entries that are switched on and actually say something */
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

/** Every dictionary hit in `text`, left to right, without overlaps. */
export function hitsIn(text: string, list: LexEntry[]): LexHit[] {
  const m = matcher(list);
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
}

/** The text as the endpoint will receive it. A replacement is never itself re-matched. */
export function speak(text: string, list: LexEntry[]): Spoken {
  const hits = hitsIn(text, list);
  if (!hits.length) return { text, hits };
  let out = "";
  let last = 0;
  for (const h of hits) {
    out += text.slice(last, h.from) + h.say;
    last = h.to;
  }
  return { text: out + text.slice(last), hits };
}

/**
 * What a voice may be sent, and nothing else: Latin letters (the books are English) and digits, the
 * punctuation that shapes how a line is read, the few symbols a voice says — `+5`, `10%`, `$3`,
 * `94/100` — and brackets, less those the voice reads as its own tags (`sayable`).
 */
const SAYABLE =
  /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F0-9\s.,!?;:'"‘’“”\-–—…+%$£€#&/°()[\]{}<>]/;
const BRACKET_CHARS: Record<TagBracket, string> = { round: "()", square: "[]", angle: "<>" };
/** each closing bracket's opener */
const CLOSES: Record<string, string> = { ")": "(", "]": "[", "}": "{", ">": "<" };
/**
 * An HTML tag, whole: a table or list the book kept as markup, a stat sheet in a LitRPG. Only HTML's
 * own elements, so `<Rare>` in a line is prose.
 */
const HTML_TAG =
  /<\/?(a|b|i|u|s|p|br|hr|em|strong|small|big|sub|sup|span|font|div|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|h[1-6]|blockquote|code|pre|img)\b[^<>]*>/iy;
/** a tag that ends a line of a table or list, read as the end of a sentence */
const BLOCK = /^(br|p|div|li|ul|ol|table|tr|td|th|h[1-6])$/i;
/** A footnote reference, `[1]`: a number nobody reads out. */
const FOOTNOTE = /\[\d{1,3}\]/y;

/**
 * A line as a voice is sent it, before any expression tag goes in: only what `SAYABLE` allows, less
 * the `brackets` the voice reads as tags, so prose is never taken for one; HTML tags and footnote
 * references out; and single quotes around a whole line (a thought) out. A voice given the rest
 * reads it out — "F A S T E R punct apostrophe", "div class" — or takes it for its own markup and
 * says nothing like the line. `at` maps an offset in `text` as given to the same place in what is
 * left. A line that would be left with no letter or digit is kept as it is.
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
  /** where each offset of `text` lands in `out` */
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
      // a bracket with nothing said in it — a kaomoji's, once its face is gone — is not sent either
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

/** The original text cut into runs, so the reader can underline what is said differently. */
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
// Silence is not rendered, it is stitched: changing a pause re-times the chapter but invalidates no
// audio. `line` is the gap after an ordinary line, `turn` the longer one when the voice changes.

export const DEFAULT_PACING: Pacing = { line: 0.35, turn: 0.7 };
/** offered in the reader; `null` = back to the book default */
export const PAUSE_STEPS: (number | null)[] = [null, 0, 0.25, 0.5, 1, 1.5, 2.5];

export const pacingOrDefault = (p: Pacing | undefined): Pacing => ({ ...DEFAULT_PACING, ...p });

/** The gap this book would use after `s`, before its neighbour, with no override in play. */
export function defaultPause(s: Segment, next: Segment | undefined, pacing: Pacing): number {
  if (!next) return 0;
  return next.speaker === s.speaker ? pacing.line : pacing.turn;
}

/** The gap actually used after `s` — the line's own override, else the book default. */
export function pauseAfter(s: Segment, next: Segment | undefined, pacing: Pacing): number {
  if (!next) return 0;
  return s.pause ?? defaultPause(s, next, pacing);
}

/** One clip of a chapter's timeline: where it starts and ends, and the silence stitched after it. */
export interface TimelineClip {
  s: Segment;
  start: number;
  end: number;
  gap: number;
}

/**
 * A chapter as it plays: every line with a clip, in order, placed on one clock with the silence
 * stitched after each. Unrendered lines take no time at all, and a gap is measured to the next
 * line that *plays*, not the next line of the script. So do lines the book does not read — site
 * text, and notes unless it reads them (`isSpoken`) — even when they kept a clip from before they
 * were marked.
 *
 * The one layout of a chapter: the player's queue, "play from here", the ledger's scrubber and the
 * chapter's silence all read it, so a line cannot start at one second on the bar and another in
 * the player.
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

/** Total silence stitched between the clips of one chapter; unrendered lines take no time at all. */
export function silenceOf(
  segments: Segment[],
  pacing: Pacing,
  book: Pick<Book, "readNotes"> | undefined,
): number {
  return chapterTimeline(segments, pacing, book).reduce((a, x) => a + x.gap, 0);
}

/** How long a chapter plays: every clip it plays, and the silence stitched between them. */
export const chapterSeconds = (
  segments: Segment[],
  pacing: Pacing,
  book: Pick<Book, "readNotes"> | undefined,
): number => {
  const timeline = chapterTimeline(segments, pacing, book);
  // summed as two totals, clips then silence, so a figure stored before is the figure read now
  return (
    timeline.reduce((a, x) => a + x.s.audio.duration, 0) + timeline.reduce((a, x) => a + x.gap, 0)
  );
};

/** seconds, exact but never noisy: 1s, 1.75s, 0.35s */
export const secs = (n: number): string => `${Number(n.toFixed(2))}s`;

// ---------- voice instructions ----------

/**
 * The voice instructions submitted beside a line.
 *
 * A character's standing style and a line's own direction are not part of the prose — the reader
 * never sees them — but they go over the wire with the request, and a provider that meters what it
 * receives meters them too. Composed in one place so the count that is billed and the audit trail
 * on the clip can never be two different strings.
 *
 * Empty when there is nothing to say, so an endpoint sending no instructions is charged for none.
 */
export function speechInstructions(parts: { style?: string; direction?: string }): string {
  return [parts.style?.trim(), parts.direction?.trim()].filter(Boolean).join(". ");
}

/** Every rate an endpoint can be asked for, lowest first. The server refuses any other. */
export const SAMPLE_RATES: readonly SampleRate[] = [16000, 22050, 24000, 32000, 44100, 48000];

/** 44100 → "44.1 kHz", 16000 → "16 kHz". */
export const sampleRateLabel = (hz: number): string => `${Number((hz / 1000).toFixed(2))} kHz`;
