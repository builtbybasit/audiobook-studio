// Deciding which chapters of an EPUB are not story.
//
// A web-novel EPUB carries the author's announcements inline with the fiction: hiatus notices,
// release schedules, vote reminders, afterwords. They are chapters as far as the file is
// concerned, and narrating them produces an audiobook that stops mid-arc to ask the listener to
// vote on a website.
//
// The prototype never did this. `src/mock/fixtures/notices.ts` supplies the words for a note whose
// kind the sample already declared; this file is the part that was missing — reading a chapter and
// deciding. It never removes anything: it attaches a `ChapterNote`, and the contents review is
// where the person decides. That division is the whole safety argument for guessing at all, so a
// wrong guess costs a click rather than a missing chapter.
import type { ChapterNote, NoticeKind } from "@/types";
import type { ParsedChapter } from "~/epub/parse";
import { plainText } from "~/epub/markdown";
import { countWords } from "~/epub/text";

/** Below this, a chapter is short enough that being a notice is plausible. */
const SHORT_WORDS = 600;
/** Above this, a chapter is a full one: a note inside it is a note *plus* story. */
const FULL_WORDS = 900;

/** What gives a kind away, most specific first. The first kind to match names the note. */
const KINDS: { kind: NoticeKind; test: RegExp; saw: string }[] = [
  {
    kind: "hiatus",
    test: /\bhiatus\b|\bon (?:a )?break\b|\bpausing (?:the )?(?:story|releases)\b|\bno (?:new )?chapters? for\b/i,
    saw: "mentions a hiatus",
  },
  {
    kind: "return",
    test: /\b(?:i'?m|we'?re) back\b|\bhiatus (?:is )?over\b|\breturn(?:ing)? from (?:the )?hiatus\b|\bresum(?:e|ing) (?:releases|chapters|posting)\b/i,
    saw: "announces resumed releases",
  },
  {
    kind: "translator",
    test: /\btranslator'?s? (?:note|notes)\b|\btl note\b|\beditor'?s? note\b/i,
    saw: "translator’s notes",
  },
  {
    kind: "afterword",
    test: /\bafterword\b|\bend of (?:the )?volume\b|\bvolume (?:is )?complete\b|\bthat'?s the end of (?:the|this) volume\b/i,
    saw: "closes the volume",
  },
  {
    kind: "vote",
    test: /\bvote\b|\bvoting\b|\bpower stones?\b|\bvotes reset\b/i,
    saw: "asks readers to vote",
  },
  {
    kind: "sponsor",
    test: /\bsponsor(?:ed|s)?\b|\bbonus chapter goal\b|\bthank you to (?:this week'?s|our) (?:supporters|sponsors)\b/i,
    saw: "thanks sponsors",
  },
  {
    kind: "donation",
    test: /\bpatreon\b|\bko-?fi\b|\bdonat(?:e|ion|ions)\b|\bsupport the story\b|\bbuy me a coffee\b/i,
    saw: "asks for support",
  },
  {
    kind: "promo",
    test: /\bmy other (?:work|serial|story|book)\b|\bnew book out\b|\bavailable (?:now )?on\b|\bleave a review\b|\bwhere to find me\b/i,
    saw: "promotes other work",
  },
  {
    kind: "schedule",
    test: /\brelease schedule\b|\bposting schedule\b|\bchapters? (?:a|per) week\b|\bschedule (?:for|update)\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\s*[—–-]\s*\w/i,
    saw: "sets out a release schedule",
  },
  {
    kind: "health",
    test: /\b(?:i'?ve been|i am|i'?m) (?:unwell|ill|sick)\b|\bin (?:the )?hospital\b|\bfamily emergency\b|\bpersonal (?:update|reasons)\b|\bhealth\b/i,
    saw: "a personal or health update",
  },
  {
    kind: "progress",
    test: /\bprogress update\b|\bsome news\b|\bwhere things stand\b|\bwith the editor\b|\bdrafted\b|\bword count\b/i,
    saw: "talks about the writing, not the story",
  },
];

/** Titles that read as an announcement whatever the text under them turns out to be. */
const NOTICE_TITLE =
  /^\s*(?:author'?s? note|a? ?note (?:from|to) (?:the )?(?:author|readers?)|not a chapter|announcement|notice|update|hiatus|afterword|translator'?s? notes?|schedule|please vote|vote reminder|support|thank you|sorry|apolog)/i;

/** Phrases that address the reader rather than narrate to them. */
const ADDRESS =
  /\bthank you for reading\b|\bthanks for reading\b|\bsorry for the\b|\bnext chapter\b|\bthis chapter\b|\bthe comments\b|\bdear readers?\b|\bhi everyone\b|\bsee you next\b|\benjoy!?\b|\bplease read\b|\bmy (?:patreon|discord)\b/i;

const URL_RE = /https?:\/\/\S+|\bwww\.\S+/gi;

/** Speech, in the punctuation English and CJK web novels actually use. */
const DIALOGUE = /[“”"]|[「」『』]|^\s*[—–]\s*\p{Lu}/mu;

interface Signals {
  words: number;
  links: number;
  hasDialogue: boolean;
  addresses: boolean;
  kind: { kind: NoticeKind; saw: string } | null;
}

function read(text: string, title: string): Signals {
  const links = text.match(URL_RE)?.length ?? 0;
  const hit = KINDS.find((k) => k.test.test(text) || k.test.test(title));
  return {
    // The same count the import puts on the chapter, rather than a second one that disagrees with
    // it. Splitting on whitespace reads a chapter of Chinese prose as a single word, which makes
    // 689 words of story a one-word notice and suggests skipping it.
    words: countWords(text),
    links,
    hasDialogue: DIALOGUE.test(text),
    addresses: ADDRESS.test(text),
    kind: hit ? { kind: hit.kind, saw: hit.saw } : null,
  };
}

/** The evidence list the review shows: what was actually seen, not what the rule is called. */
function evidenceFor(s: Signals, extra: string[] = []): string[] {
  const out = [...extra];
  if (s.kind) out.push(s.kind.saw);
  if (s.addresses) out.push("addressed to readers");
  if (!s.hasDialogue) out.push("no dialogue");
  if (s.links) out.push(s.links === 1 ? "contains a link" : `contains ${s.links} links`);
  out.push(`${s.words} words`);
  return out;
}

const REASON: Record<NoticeKind, string> = {
  hiatus: "Possible hiatus announcement",
  health: "Personal or health update",
  return: "Return announcement",
  schedule: "Release schedule",
  progress: "Progress or news update",
  promo: "Mostly promotional links",
  donation: "Donation message",
  duplicate: "Duplicate of an earlier notice",
  unreadable: "This chapter could not be read from the file",
  sponsor: "Sponsor thanks",
  vote: "Vote reminder",
  afterword: "Afterword and next-volume schedule",
  translator: "Translator’s notes",
  mixed: "Author note and story together",
  title: "Title looks like a notice, text reads as story",
};

/** Text reduced to what it says, so two postings of the same notice compare equal. */
const fingerprint = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);

/** Does this single block read as a note rather than as story? */
function blockIsNote(block: string): boolean {
  const s = read(block, "");
  if (s.words > 220 || s.hasDialogue) return false;
  return s.addresses || !!s.kind || s.links > 0;
}

/**
 * Judge every chapter of a book together.
 *
 * Together, because two of the decisions need the neighbours: a notice is a duplicate only
 * relative to one posted earlier, and both need a stable reading order. `null` means the chapter
 * read as story and carries no note.
 */
export function detectNotices(chapters: readonly ParsedChapter[]): (ChapterNote | null)[] {
  const seen = new Map<string, number>();

  return chapters.map((chapter, i) => {
    const { title } = chapter;
    // Judged on the prose, not on the markers in it. A keyword the author italicised is the same
    // keyword, and a fingerprint taken over `*` would make two postings of one notice differ.
    const text = plainText(chapter.text);
    const s = read(text, title);
    const titleLooksLikeNotice = NOTICE_TITLE.test(title);

    const note = (kind: NoticeKind, evidence: string[], at?: "start" | "end"): ChapterNote => ({
      verdict: kind === "mixed" || kind === "title" || kind === "unreadable" ? "review" : "skip",
      kind,
      reason:
        kind === "mixed"
          ? at === "end"
            ? "Ends with an author note"
            : "Starts with an author note"
          : REASON[kind],
      evidence,
      ...(kind === "mixed" ? { at: at ?? "start" } : {}),
    });

    // The file said this chapter was here and it could not be read. That is the one case where the
    // review has to speak up rather than guess: narrating it would produce silence, and skipping it
    // by default would quietly drop a chapter nobody has looked at.
    if (chapter.unreadable)
      return note("unreadable", [
        "the file could not be read",
        "no text was recovered",
        `the book lists it as “${title}”`,
      ]);

    // Nothing to read, and nothing went wrong reading it: an empty page in the file. Not a notice —
    // saying "notice" about it would hide a blank chapter behind a suggestion to skip.
    if (!s.words) return null;

    // ---- a short chapter that is all notice ----
    const shortNotice =
      s.words < SHORT_WORDS &&
      !s.hasDialogue &&
      (s.addresses || s.links > 0 || !!s.kind || titleLooksLikeNotice);

    if (shortNotice) {
      const print = fingerprint(text);
      const earlier = seen.get(print);
      if (earlier != null)
        return note("duplicate", [
          `same text as chapter ${earlier}`,
          ...evidenceFor(s).filter((e) => e !== "no dialogue"),
        ]);
      seen.set(print, i + 1);
      // A notice with no keyword in it is still a notice — it is short, addressed to readers and
      // has no dialogue. `progress` is the least specific kind, which is the honest label for it.
      return note(s.kind?.kind ?? "progress", evidenceFor(s));
    }

    // ---- a full chapter with a note stuck to one end ----
    if (s.words >= FULL_WORDS) {
      const blocks = text.split("\n\n").filter((b) => b.trim());
      if (blocks.length >= 3) {
        if (blockIsNote(blocks[0]))
          return note(
            "mixed",
            ["opens with a note addressed to readers", "the rest is story"],
            "start",
          );
        if (blockIsNote(blocks[blocks.length - 1]))
          return note(
            "mixed",
            ["closes with a note addressed to readers", "the rest is story"],
            "end",
          );
      }
      // ---- a story chapter that is only *titled* like a notice ----
      if (titleLooksLikeNotice)
        return note("title", [
          "the title matches a notice pattern",
          ...(s.hasDialogue ? ["the text has dialogue"] : []),
          `${s.words} words`,
        ]);
    }

    return null;
  });
}
