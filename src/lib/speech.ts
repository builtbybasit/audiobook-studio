// How a line is *said*, as opposed to how it is written. Two render-time transforms live here and
// neither one touches the book: the per-book pronunciation dictionary rewrites names and invented
// words on their way to the endpoint, and the pacing rules decide how much silence is stitched in
// after each clip. The script the reader shows is always the original prose.
import type { LexEntry, Pacing, SampleRate, Segment } from "@/types";

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

/** Total silence stitched between the clips of one chapter; unrendered lines take no time at all. */
export function silenceOf(segments: Segment[], pacing: Pacing): number {
  const heard = segments.filter((s) => s.audio.duration > 0);
  return heard.reduce((a, s, i) => a + pauseAfter(s, heard[i + 1], pacing), 0);
}

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
