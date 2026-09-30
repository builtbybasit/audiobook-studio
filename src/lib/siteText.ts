// Words a chapter carries that are not the story.
//
// Web-novel sources weave their own text into a chapter: a site's boilerplate ("Read the latest
// chapters at …"), anti-scraping lines dropped between paragraphs or inside one, and translator's or
// author's notes. None of it belongs in the audiobook, but it cannot simply be cut: every scripting
// answer is checked word for word against the prose it was sent (`fidelity` in
// server/providers/chatScripting.ts), and that check is the only guarantee that a model did not
// quietly drop a sentence of story. Loosening it to let site text go would let story go too.
//
// So site text is *marked*, never removed. The model gives it a line of its own with the type
// `watermark` or `note`, its words copied exactly, and the script still holds every word of the
// chapter. What is read aloud is then decided here, once, for the server and the browser alike:
// narration renders, times and bills only the spoken lines, and the export stitches only their clips.
//
// A deterministic detector sits beside the model (`siteTextSignals`, and the repetition across
// chapters the server counts), because a model misses some and mistakes others. It only ever
// suggests — `Segment.siteCheck` — and a person decides.
import type { Book, Segment, SegmentType } from "@/types";

/** The types that are not the story. */
export const SITE_TEXT_TYPES = ["watermark", "note"] as const satisfies readonly SegmentType[];

export type SiteTextType = (typeof SITE_TEXT_TYPES)[number];

export const isSiteText = (type: SegmentType): type is SiteTextType =>
  (SITE_TEXT_TYPES as readonly SegmentType[]).includes(type);

/** How each type is named where a person reads it. */
export const TYPE_LABEL: Record<SegmentType, string> = {
  narration: "Narration",
  dialogue: "Dialogue",
  thought: "Thought",
  watermark: "Site text",
  note: "Translator's note",
};

/**
 * Whether a line is read aloud: every story line, a note only when the book reads its notes, and
 * site text never. Everything that renders, times, counts, bills or exports audio asks this, and
 * nothing else — a line that is not spoken has no clip to want, lacks none, and costs nothing.
 */
export function isSpoken(
  segment: Pick<Segment, "type">,
  book: Pick<Book, "readNotes"> | undefined,
): boolean {
  if (segment.type === "watermark") return false;
  if (segment.type === "note") return book?.readNotes === true;
  return true;
}

/** The types this book does not read aloud, for a query that counts lines without reading them. */
export const unspokenTypes = (book: Pick<Book, "readNotes"> | undefined): SiteTextType[] =>
  SITE_TEXT_TYPES.filter((type) => !isSpoken({ type }, book));

/**
 * The lines of a chapter that play: spoken, and with a clip. A line marked as site text after it
 * was rendered keeps its clip — turning it back into narration should not cost a render — but the
 * clip is not heard, timed or stitched while the line is not read.
 */
export const heardLines = <S extends Pick<Segment, "type" | "audio">>(
  segments: readonly S[],
  book: Pick<Book, "readNotes"> | undefined,
): S[] => segments.filter((s) => s.audio.duration > 0 && isSpoken(s, book));

/**
 * What in a line's own words gives it away as site text, if anything. Phrases, not words, for the
 * reason server/epub/notices.ts gives: a story says "read", "site" and "chapter" freely; what gives
 * boilerplate away is a web address, or words aimed at the reader about where they are reading.
 */
export function siteTextSignals(text: string): string[] {
  const out: string[] = [];
  for (const { test, saw } of SIGNALS) if (test.test(text)) out.push(saw);
  return out;
}

/**
 * A domain, spelled plainly or with the dot spaced, bracketed or spelled out the way scrapers dodge
 * a filter. A dot with a space after it and none before is a full stop, not an address: "look at
 * me. Me?" names no site.
 */
const ADDRESS =
  /\b[a-z0-9-]{2,}(?:\.|\s\.\s|\s?\[\s?dot\s?\]\s?|\s?\(\s?dot\s?\)\s?|\sdot\s)(?:com|net|org|io|co|me|info|xyz|site|online|club|top)\b/i;

/** "Read the latest chapters", "find the original translation" — the first half of a pointer. */
const READ_MORE =
  /\b(?:read|find|enjoy)(?:ing)?\b[^.!?\n]{0,40}\b(?:latest|new(?:est)?|next|more|full|original|official|updated?)\b[^.!?\n]{0,30}\b(?:chapters?|novels?|translations?|releases?)\b/gi;

/**
 * Where it points, case and all: a site, an address or a name. A novel's manual has chapters too,
 * and "read the next chapter of the manual at dawn" points at a time of day, not a website.
 */
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
    // Case-sensitive on purpose: "TN", "A/N" and "ED" are labels, "An—" and "Ed—" are a stammer
    // and a name. The words are spelled out in either case instead.
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
 * The share of a chapter's words its marks leave out of the audio, past which the chapter is worth
 * a look. A site's boilerplate is a line or two in a chapter of thousands of words, so marks past
 * this are far likelier a model that took story for site text — the silent omission marking must
 * never become. The scripting job warns past it and the review inbox lists the chapter; both read
 * this figure, and count it with `unreadShare`, so they never disagree about a chapter.
 */
export const UNREAD_SHARE_WARNING = 0.15;

/**
 * How much of a chapter its marks leave out of the audio: the words on lines that are not read
 * aloud (`isSpoken`), of all its words. A note the book reads is not left out, so it does not count.
 */
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
