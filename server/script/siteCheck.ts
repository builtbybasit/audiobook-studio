// Second opinion on the model's site-text marks (see `src/lib/siteText.ts`), run before a scripted
// chapter is written. It only attaches a `siteCheck` suggestion, never changes a type. Story lines
// with give-away phrases or repeated across `REPEATED_IN` other chapters are suggested as site
// text; a long site-text line with no signals is suggested back as narration.
import type { Book, Segment, SiteCheck } from "@/types";
import { wordsOf } from "@/lib/gaps";
import { isSiteText, siteTextSignals, unreadShare } from "@/lib/siteText";
import type { Tx } from "~/db/client";
import { linesElsewhere } from "~/db/script";

/** How many of the book's other chapters a line has to be in to read as the site's. */
export const REPEATED_IN = 3;
/** Shorter lines ("He nodded.") repeat in every book, so they aren't asked. */
export const REPEAT_MIN_WORDS = 5;
/** Past this many words, a line marked as site text that nothing gives away reads like story. */
export const STORY_WORDS = 40;

export const storyWhy = (words: number): string =>
  `${words} words, and nothing in them gives site text away`;

/** Case and whitespace folded, for comparing lines across chapters. */
export const fold = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The lines with the detector's suggestions on them, replacing any earlier ones. `repeats` counts
 * the other chapters holding a line that `fold`s the same.
 */
export function siteChecks(
  segs: readonly Segment[],
  repeats: (folded: string) => number,
): Segment[] {
  return segs.map((s) => {
    const { siteCheck: _earlier, ...line } = s;
    const words = wordsOf(s.text).length;
    const n = words >= REPEAT_MIN_WORDS ? repeats(fold(s.text)) : 0;
    const signs = [
      ...siteTextSignals(s.text),
      ...(n >= REPEATED_IN ? [`repeated in ${n} chapters`] : []),
    ];
    let check: SiteCheck | null = null;
    if (!isSiteText(s.type) && signs.length)
      check = { suggest: "watermark", why: signs.join(", ") };
    else if (isSiteText(s.type) && !signs.length && words > STORY_WORDS)
      check = { suggest: "narration", why: storyWhy(words) };
    return check ? { ...line, siteCheck: check } : line;
  });
}

/** For the job's log. */
export interface SiteTextTally {
  watermarks: number;
  notes: number;
  /** lines the detector disagrees with */
  toCheck: number;
  /** share of words left out of the audio, 0–1 (`unreadShare`) */
  share: number;
}

export function siteTextTally(
  segs: readonly Segment[],
  book: Pick<Book, "readNotes"> | undefined,
): SiteTextTally {
  const tally: SiteTextTally = { watermarks: 0, notes: 0, toCheck: 0, share: 0 };
  for (const s of segs) {
    if (s.type === "watermark") tally.watermarks++;
    if (s.type === "note") tally.notes++;
    if (s.siteCheck) tally.toCheck++;
  }
  tally.share = unreadShare(segs, book).share;
  return tally;
}

/** `siteChecks` inside the write's transaction, counting repeats against the book as it stands. */
export function checkSiteText(
  tx: Tx,
  bookId: string,
  chapterId: number,
  segs: readonly Segment[],
): Segment[] {
  const asked = [
    ...new Set(
      segs.filter((s) => wordsOf(s.text).length >= REPEAT_MIN_WORDS).map((s) => fold(s.text)),
    ),
  ];
  const chaptersOf = new Map<string, Set<number>>();
  for (const row of linesElsewhere(tx, bookId, chapterId, asked)) {
    const key = fold(row.text);
    (chaptersOf.get(key) ?? chaptersOf.set(key, new Set()).get(key)!).add(row.chapterId);
  }
  return siteChecks(segs, (folded) => chaptersOf.get(folded)?.size ?? 0);
}
