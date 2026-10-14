// Site text (boilerplate, anti-scraping lines, translator's notes) is marked as `watermark` or
// `note` lines, never removed: the word-for-word `fidelity` check
// (server/providers/chatScripting.ts) guarantees no story was dropped. What is read aloud is
// decided here (`isSpoken`). `siteTextSignals` only suggests (`Segment.siteCheck`).
import type { Book, Segment, SegmentType } from "@/types";

/** The types that are not the story. */
export const SITE_TEXT_TYPES = ["watermark", "note"] as const satisfies readonly SegmentType[];

export type SiteTextType = (typeof SITE_TEXT_TYPES)[number];

export const isSiteText = (type: SegmentType): type is SiteTextType =>
  (SITE_TEXT_TYPES as readonly SegmentType[]).includes(type);

export const TYPE_LABEL: Record<SegmentType, string> = {
  narration: "Narration",
  dialogue: "Dialogue",
  thought: "Thought",
  watermark: "Site text",
  note: "Translator's note",
};

/**
 * Story lines always, notes when the book reads them, site text never. Everything that renders,
 * times, counts, bills or exports audio asks this.
 */
export function isSpoken(
  segment: Pick<Segment, "type">,
  book: Pick<Book, "readNotes"> | undefined,
): boolean {
  if (segment.type === "watermark") return false;
  if (segment.type === "note") return book?.readNotes === true;
  return true;
}

/** For a query that counts lines without loading them. */
export const unspokenTypes = (book: Pick<Book, "readNotes"> | undefined): SiteTextType[] =>
  SITE_TEXT_TYPES.filter((type) => !isSpoken({ type }, book));

/** Spoken and with a clip. A line marked as site text keeps its clip, unheard, for an undo. */
export const heardLines = <S extends Pick<Segment, "type" | "audio">>(
  segments: readonly S[],
  book: Pick<Book, "readNotes"> | undefined,
): S[] => segments.filter((s) => s.audio.duration > 0 && isSpoken(s, book));

/** Phrases, not words: a story says "read", "site", "chapter" freely (server/epub/notices.ts). */
export function siteTextSignals(text: string): string[] {
  const out: string[] = [];
  for (const { test, saw } of SIGNALS) if (test.test(text)) out.push(saw);
  return out;
}

/**
 * A domain, with the dot plain, spaced, bracketed or spelled out as scrapers dodge filters.
 * "me. Me?" (space after only) is a full stop.
 */
const ADDRESS =
  /\b[a-z0-9-]{2,}(?:\.|\s\.\s|\s?\[\s?dot\s?\]\s?|\s?\(\s?dot\s?\)\s?|\sdot\s)(?:com|net|org|io|co|me|info|xyz|site|online|club|top)\b/i;

/** "Read the latest chapters": the first half of a pointer. */
const READ_MORE =
  /\b(?:read|find|enjoy)(?:ing)?\b[^.!?\n]{0,40}\b(?:latest|new(?:est)?|next|more|full|original|official|updated?)\b[^.!?\n]{0,30}\b(?:chapters?|novels?|translations?|releases?)\b/gi;

/** Case-sensitive: "read the next chapter of the manual at dawn" points at no site. */
const SOMEWHERE = /^(?:[A-Z0-9]|(?:(?:our|my|the|this)\s+)?(?:official\s+)?(?:web)?site\b|app\b)/;

function pointsAtASite(text: string): boolean {
  for (const m of text.matchAll(READ_MORE)) {
    // the rest of the sentence; a full stop inside an address does not end it
    const rest = text.slice(m.index + m[0].length).split(/[!?\n]|\.(?=\s|$)/)[0];
    for (const at of rest.matchAll(/\b(?:at|on)\s+(\S+(?:\s+\S+){0,3})/gi))
      if (SOMEWHERE.test(at[1]) || ADDRESS.test(at[1])) return true;
  }
  return false;
}

const SIGNALS: { test: { test(text: string): boolean }; saw: string }[] = [
  { test: ADDRESS, saw: "names a web address" },
  { test: { test: pointsAtASite }, saw: "tells the reader where to read" },
  {
    // "this chapter was stolen", not "the pill was stolen from the furnace"
    test: /\bthis (?:chapter|content|translation|novel)\s+(?:was|is|has been)\s+(?:stolen|pirated|scraped|taken|copied|reposted)\b|\bwithout (?:the )?(?:author|translator)['’]?s? permission\b|\bif you(?:['’]re| are)? (?:reading|see(?:ing)?) this\b[^.!?\n]{0,60}\b(?:(?:web)?site|app|aggregator|other than)\b/i,
    saw: "says the text was taken from a site",
  },
  {
    // case-sensitive: "TN", "A/N", "ED" are labels; "An—" and "Ed—" are a stammer and a name
    test: /^\s*[([]?\s*(?:T\/?L|TN|A\/?N|ED|[Tt]\/[LlNn]|[Aa]\/[Nn]|[Tt][Ll](?=\s*[Nn]otes?)|(?:[Tt]ranslator|[Ee]ditor|[Aa]uthor|TRANSLATOR|EDITOR|AUTHOR)(?:['’][Ss])?)\s*(?:[Nn]otes?|NOTES?|N)?\s*[:：\-–—]/,
    saw: "opens as a translator's or author's note",
  },
  {
    // "support me" and "donate" alone are a battle and a temple; these are aimed at a reader
    test: /\b(?:patreon|ko-?fi|buy me a coffee|support (?:the|my|our) (?:author|translator|translations?|work)|donate to (?:me|us|the (?:author|translator))|donations? (?:link|page|goal)|vote for (?:this|the|my|our) (?:novel|story|book|series))\b|\b(?:power stones?|golden tickets?)\b[^.!?\n]{0,40}\b(?:vote|votes|voting|novel|book|story)\b|\b(?:vote|votes|voting)\b[^.!?\n]{0,40}\b(?:power stones?|golden tickets?)\b/i,
    saw: "asks the reader for support",
  },
];

/**
 * Past this share of unread words, a model likely took story for site text. The scripting job and
 * the review inbox both use it with `unreadShare`.
 */
export const UNREAD_SHARE_WARNING = 0.15;

/** The share of a chapter's words on lines not read aloud (`isSpoken`). */
export function unreadShare(
  segs: readonly Pick<Segment, "type" | "text">[],
  book: Pick<Book, "readNotes"> | undefined,
): { words: number; unread: number; lines: number; share: number } {
  let words = 0;
  let unread = 0;
  let lines = 0;
  for (const s of segs) {
    const n = s.text.split(/\s+/).filter(Boolean).length;
    words += n;
    if (!isSpoken(s, book)) {
      unread += n;
      lines++;
    }
  }
  return { words, unread, lines, share: words ? unread / words : 0 };
}
