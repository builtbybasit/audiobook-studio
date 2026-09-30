// The notices a web-novel EPUB carries between its chapters, as the import would find them: what
// each kind is called, the titles it tends to have, what gives it away, and a few bodies to read.
//
// These are predetermined fixtures. Nothing here classifies text — the import samples say which
// chapter carries which note, and this file supplies the words. The reasons are written the way
// the review shows them, short enough to read beside a title.
import type { ChapterNote, DemoNoticeKind } from "@/types";

export interface NoticeSpec {
  verdict: "skip" | "review";
  /** the one line beside the title */
  reason: string;
  /** titles such a chapter tends to have */
  titles: string[];
  /** what the check saw */
  evidence: string[];
  /** two or three bodies, so repeated notices read as related rather than identical */
  bodies: string[];
}

export const NOTICES: Record<DemoNoticeKind, NoticeSpec> = {
  hiatus: {
    verdict: "skip",
    reason: "Possible hiatus announcement",
    titles: ["Going on hiatus", "Hiatus notice", "A short break (please read)"],
    evidence: [
      "mentions “hiatus” and a return date",
      "addressed to readers, no dialogue",
      "under 400 words",
    ],
    bodies: [
      "Hi everyone. I’m sorry to do this mid-arc, but I need to put the story on hiatus for a few weeks. Work has picked up and I’d rather pause than post chapters I’m not happy with.\n\nI’ll be back in about a month. The next chapter is half-written and picks up exactly where this one leaves off, so nothing is lost. Thank you for reading, and for your patience.",
      "Quick note before the next chapter: I’m taking a break from posting until the end of the month. Nothing dramatic — I just need the time to plan the next arc properly instead of writing it week to week.\n\nSee you soon. Chapter releases resume on the first Monday after I’m back.",
      "This is the hiatus notice I hoped I wouldn’t have to write. Real life is taking the wheel for a while, so there won’t be new chapters for the next two or three weeks.\n\nThe story is not dropped. I have the ending planned and I intend to reach it. Thank you for sticking with it.",
    ],
  },
  health: {
    verdict: "skip",
    reason: "Personal or health update",
    titles: ["A personal update", "Sorry for the delay", "Not a chapter — an update"],
    evidence: [
      "first person, present tense, addressed to readers",
      "no character names from the story",
      "under 350 words",
    ],
    bodies: [
      "Not a chapter, sorry. I’ve been unwell for the last week and a half and haven’t been able to sit at the desk for more than a few minutes at a time. I’m on the mend now.\n\nChapters will be a little shorter for the next fortnight while I catch up. Thanks to everyone who messaged — it genuinely helped.",
      "A short personal note. My family had an emergency this week and I had to travel at short notice. Everyone is okay, but I haven’t written a word since Tuesday.\n\nNormal releases should resume next week. Thank you for understanding.",
    ],
  },
  return: {
    verdict: "skip",
    reason: "Return announcement",
    titles: ["I’m back", "We’re back — schedule below", "Return from hiatus"],
    evidence: [
      "announces resumed releases",
      "addressed to readers, no dialogue",
      "under 300 words",
    ],
    bodies: [
      "I’m back! Thank you for waiting. The hiatus went a little longer than I planned, but the next arc is fully outlined and the first six chapters are written.\n\nReleases resume this Thursday and will run Monday, Wednesday and Friday from then on.",
      "Hiatus over. Chapters resume tomorrow. I’ve re-read the whole story while I was away and fixed a handful of continuity errors in the early chapters — nothing that changes the plot.\n\nThanks for sticking around.",
    ],
  },
  schedule: {
    verdict: "skip",
    reason: "Release schedule",
    titles: ["Release schedule", "Schedule for the coming month", "Posting schedule (updated)"],
    evidence: [
      "a list of weekdays and dates",
      "addressed to readers, no dialogue",
      "under 250 words",
    ],
    bodies: [
      "Release schedule for the coming month:\n\nMonday — one chapter\nWednesday — one chapter\nFriday — one chapter, sometimes two\n\nBonus chapters go out on the last Sunday of the month when the sponsor goal is met. Thank you all for reading.",
      "Updated posting schedule. I’m moving from three chapters a week to two — Tuesdays and Saturdays — so each one can be longer and get a proper edit.\n\nThe overall word count per week stays the same. Thanks for your patience with the change.",
    ],
  },
  progress: {
    verdict: "skip",
    reason: "Progress or news update",
    titles: ["Progress update", "Some news", "Where things stand"],
    evidence: [
      "talks about the writing, not the story",
      "addressed to readers, no dialogue",
      "under 350 words",
    ],
    bodies: [
      "A quick progress update. The second volume is now fully drafted and with the editor, and the paperback of volume one should be available next month.\n\nChapters here continue as normal. Thank you for reading, and for the kind messages this week.",
      "Some news: the story has been picked up for an official translation, which is exciting and a little terrifying. Nothing changes for readers here — the free chapters continue on the same schedule.\n\nMore soon.",
    ],
  },
  promo: {
    verdict: "skip",
    reason: "Mostly promotional links",
    titles: ["Check out my other work", "New book out now", "Links and where to find me"],
    evidence: ["mostly links", "addressed to readers, no dialogue", "under 200 words"],
    bodies: [
      "If you’re enjoying this story, my other serial is now complete and available as an ebook:\n\nhttps://example.com/books/the-glass-orchard\n\nYou can also find me here:\nhttps://example.com/author\nhttps://social.example/@author\n\nThank you for reading!",
      "New book out now! The first volume is available on every major store — link below. Reviews help more than you’d think.\n\nhttps://example.com/store/volume-one\n\nBack to the story next chapter.",
    ],
  },
  donation: {
    verdict: "skip",
    reason: "Donation message",
    titles: ["Support the story", "A word about donations", "Ko-fi and Patreon"],
    evidence: [
      "asks for support, links to a donation page",
      "addressed to readers, no dialogue",
      "under 250 words",
    ],
    bodies: [
      "A word about donations. This story will always be free to read, but if you’d like to support it, there’s a page here:\n\nhttps://example.com/support/author\n\nSupporters read chapters a week early. Thank you either way — the fact that people read at all still surprises me.",
    ],
  },
  duplicate: {
    verdict: "skip",
    reason: "Duplicate of an earlier notice",
    titles: ["Going on hiatus", "Hiatus notice (reposted)"],
    evidence: ["same text as an earlier chapter", "addressed to readers, no dialogue"],
    bodies: [
      "Hi everyone. I’m sorry to do this mid-arc, but I need to put the story on hiatus for a few weeks. Work has picked up and I’d rather pause than post chapters I’m not happy with.\n\nI’ll be back in about a month. The next chapter is half-written and picks up exactly where this one leaves off, so nothing is lost. Thank you for reading, and for your patience.",
    ],
  },
  sponsor: {
    verdict: "skip",
    reason: "Sponsor thanks",
    titles: ["Sponsored chapter — thank you!", "Thank you to this week’s sponsors"],
    evidence: [
      "a list of names and a thank-you",
      "the same text every few chapters",
      "under 150 words",
    ],
    bodies: [
      "This chapter was sponsored. Thank you to this week’s supporters — you know who you are, and the list is on the support page. The next bonus chapter unlocks at the usual goal.",
      "Sponsored chapter! Huge thanks to everyone who chipped in this week. The bonus chapter goal has been met, so an extra release goes out on Sunday.",
    ],
  },
  vote: {
    verdict: "skip",
    reason: "Vote reminder",
    titles: ["Please vote!", "Vote reminder"],
    evidence: [
      "asks readers to vote, links to a listing",
      "the same text every few chapters",
      "under 120 words",
    ],
    bodies: [
      "Reminder: votes reset this week. If you have a moment, voting on the listing keeps the story on the front page and brings new readers in.\n\nhttps://example.com/vote/this-story\n\nThank you!",
    ],
  },
  afterword: {
    verdict: "skip",
    reason: "Afterword and next-volume schedule",
    titles: ["Afterword", "Author’s afterword and release schedule", "End of volume — what’s next"],
    evidence: [
      "closes the volume, addressed to readers",
      "release dates for the next volume",
      "under 500 words",
    ],
    bodies: [
      "And that’s the end of the volume. Thank you for reading this far.\n\nThe next volume starts in two weeks. I’m taking a few days off first, then chapters resume on the usual schedule. If you spotted continuity mistakes, the comments are open and I read every one.",
      "Volume complete! A short afterword: this arc changed shape twice while I was writing it, and I think it ended up somewhere better than the outline. Thank you for the comments along the way.\n\nThe next volume begins on the first of the month.",
    ],
  },
  translator: {
    verdict: "skip",
    reason: "Translator’s notes",
    titles: ["Translator’s notes"],
    evidence: ["notes on terms and names, addressed to readers", "no dialogue"],
    bodies: [
      "Translator’s notes. A few choices worth explaining: titles of address are kept as in the original where English has no equivalent, and place names follow the map in the print edition rather than the web version.\n\nThank you for reading.",
    ],
  },
  mixed: {
    verdict: "review",
    reason: "Author note and story together",
    titles: [],
    evidence: [
      "opens or closes with a note addressed to readers",
      "the rest is story: dialogue and named characters",
    ],
    bodies: [
      "Author’s note: this chapter was rewritten after some sharp comments on the last one — thank you for those. The next few are longer than usual. On with the story.",
      "Quick note before we start: I’ve fixed the timeline mistake a few readers spotted in the last chapter. Nothing else changes. Enjoy.",
      "That’s the chapter. A short note: I’m travelling next week, so the Wednesday release may slip to Thursday. Thank you for reading.",
      "Author’s note at the end: the name in this chapter was spelled two ways in earlier chapters; it’s been fixed everywhere now. See you next time.",
    ],
  },
  title: {
    verdict: "review",
    reason: "Title looks like a notice, text reads as story",
    titles: [],
    evidence: [
      "the title matches a notice pattern",
      "the text has dialogue and named characters",
      "full chapter length",
    ],
    bodies: [],
  },
};

/** A note as a chapter carries it, from the fixture for its kind. */
export function noteOf(kind: DemoNoticeKind, at?: "start" | "end", variant?: number): ChapterNote {
  const spec = NOTICES[kind];
  const reason =
    kind === "mixed"
      ? at === "end"
        ? "Ends with an author note"
        : "Starts with an author note"
      : spec.reason;
  return {
    verdict: spec.verdict,
    kind,
    reason,
    evidence: [...spec.evidence],
    ...(kind === "mixed" ? { at: at ?? "start" } : {}),
    ...(variant != null ? { variant } : {}),
  };
}

/** The body a notice reads with — `n` picks among the variants so repeats do not all read alike. */
export function noticeBody(kind: DemoNoticeKind, n = 0): string {
  const bodies = NOTICES[kind].bodies;
  return bodies.length ? bodies[Math.abs(n) % bodies.length] : "";
}

/** A title for a notice chapter, from the fixture's list. */
export function noticeTitle(kind: DemoNoticeKind, n = 0): string {
  const titles = NOTICES[kind].titles;
  return titles.length ? titles[Math.abs(n) % titles.length] : NOTICES[kind].reason;
}
