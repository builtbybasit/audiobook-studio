// The site-text detector's server half: a second opinion on the lines a model has just typed.
//
// The model marks a site's boilerplate `watermark` and a translator's note `note` (see
// `src/lib/siteText.ts` for why such text is marked and never removed), and it gets some wrong
// both ways: a watermark left as narration is read aloud, and a paragraph of story marked as site
// text is silently not. So after a chapter is scripted, and before its lines are written, each line
// is held against what the model cannot see — the chapter's other lines and the book's other
// chapters — and a line the detector disagrees with carries a `siteCheck` suggestion. It never
// changes a type: a person decides, and changing the type or dismissing the suggestion clears it.
//
// Three rules, each one cheap:
//
//   * A story line with a phrase that gives it away (`siteTextSignals`) — a web address, "read the
//     latest chapters at", a plea for support — is suggested as site text.
//   * A story line whose words are in three or more of the book's other chapters is too: a site
//     drops the same sentence into every chapter, and a story rarely repeats a whole sentence.
//     Short lines are not asked, since "Yes." and "He nodded." are in every chapter of every book.
//   * A line marked as site text with nothing to give it away that runs past a paragraph's length
//     is suggested back as narration: boilerplate is short, and a long one is more likely story.
import type { Book, Segment, SiteCheck } from "@/types";
import { isSiteText, siteTextSignals, unreadShare } from "@/lib/siteText";
import type { Tx } from "~/db/client";
import { linesElsewhere } from "~/db/script";
import { wordsOf } from "~/providers/chatScripting";

/** How many of the book's other chapters a line has to be in to read as the site's. */
export const REPEATED_IN = 3;
/** The fewest words a line needs before its repeating means anything. */
export const REPEAT_MIN_WORDS = 5;
/** Past this many words, a line marked as site text that nothing gives away reads like story. */
export const STORY_WORDS = 40;

/** Why a long marked line reads like story: its length, and that nothing in it gives site text away. */
export const storyWhy = (words: number): string =>
  `${words} words, and nothing in them gives site text away`;

/** A line's words as they are compared across chapters: case and whitespace folded. */
export const fold = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The lines with the detector's suggestions on them. `repeats` answers how many of the book's
 * other chapters have a line reading as this one (`fold`ed); it is asked only of lines long enough
 * for repeating to mean anything. A line with nothing to suggest is returned as it came, and any
 * suggestion it carried is dropped: this is the detector's whole opinion of the chapter.
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

/** What the detector and the model made of a chapter, for the job's log. */
export interface SiteTextTally {
  /** lines the model marked as a site's text */
  watermarks: number;
  /** lines the model marked as a translator's or author's note */
  notes: number;
  /** lines the detector disagrees with, either way */
  toCheck: number;
  /** the share of the chapter's words left out of the audio, 0–1 (`unreadShare`) */
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

/**
 * The detector run over a chapter about to be written, inside the write's transaction: its lines
 * with suggestions, counting repeats against the book's other chapters as they stand.
 */
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
