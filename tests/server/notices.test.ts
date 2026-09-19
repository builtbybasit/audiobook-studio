// Deciding which chapters are not story.
//
// The prototype's samples declared which chapter carried which note; this is the part that reads
// the text and guesses. The guess only ever attaches a note — the review is where a person
// decides — so these assert the note that gets attached, and, just as importantly, that ordinary
// story chapters get none.
import { describe, expect, test } from "bun:test";

import type { ChapterNote } from "@/types";
import { detectNotices } from "~/epub/notices";
import type { ParsedChapter } from "~/epub/parse";
import { countWords } from "~/epub/text";

const chapter = (title: string, text: string): ParsedChapter => ({
  title,
  text,
  words: countWords(text),
  href: "c.xhtml",
});

/** A full chapter of story: dialogue, named characters, well past the short-notice threshold. */
const storyText = (n = 60): string =>
  Array.from(
    { length: n },
    (_, i) =>
      `“We settle the account tonight,” said Aurelie, and the clerk wrote the ${i + 1}th line into the ledger without once looking up from his work.`,
  ).join("\n\n");

const noteOn = (chs: ParsedChapter[], i = 0): ChapterNote | null => detectNotices(chs)[i];

describe("notices in a web-novel EPUB", () => {
  test("a hiatus announcement is flagged to skip, and says what it saw", () => {
    const note = noteOn([
      chapter(
        "A short break (please read)",
        "Hi everyone. I need to put the story on hiatus for a few weeks. Work has picked up and I'd rather pause than post chapters I'm not happy with.\n\nI'll be back in about a month. Thank you for reading, and for your patience.",
      ),
    ]);
    expect(note?.kind).toBe("hiatus");
    expect(note?.verdict).toBe("skip");
    expect(note?.evidence).toContain("mentions a hiatus");
    expect(note?.evidence).toContain("no dialogue");
  });

  test("an ordinary story chapter carries no note at all", () => {
    expect(noteOn([chapter("The Ledger Opens", storyText())])).toBeNull();
  });

  test("a long chapter of story is not a notice just because it thanks the reader", () => {
    // "thank you for reading" appears in plenty of chapters; length and dialogue outweigh it
    const text = `${storyText()}\n\nThank you for reading.`;
    const note = noteOn([chapter("Salt Tax", text)]);
    expect(note?.kind).not.toBe("hiatus");
    expect(note?.verdict).not.toBe("skip");
  });

  test("a vote reminder, a donation plea and a schedule are told apart", () => {
    const notes = detectNotices([
      chapter(
        "Please vote!",
        "Votes reset this week. Voting on the listing keeps the story on the front page.\n\nhttps://example.com/vote",
      ),
      chapter(
        "Support the story",
        "This story is free to read, but if you'd like to support it there's a Patreon here.\n\nhttps://example.com/support",
      ),
      chapter(
        "Release schedule",
        "Monday — one chapter\nWednesday — one chapter\nFriday — one chapter, sometimes two.",
      ),
    ]);
    expect(notes.map((n) => n?.kind)).toEqual(["vote", "donation", "schedule"]);
    expect(notes.every((n) => n?.verdict === "skip")).toBe(true);
  });

  test("a link in a short notice is counted as evidence", () => {
    const note = noteOn([
      chapter(
        "Links",
        "My other serial is complete and available here:\n\nhttps://example.com/a\nhttps://example.com/b",
      ),
    ]);
    expect(note?.evidence).toContain("contains 2 links");
  });

  test("the same notice posted twice names the chapter it repeats", () => {
    const body =
      "Hi everyone. I need to put the story on hiatus for a few weeks. I'll be back in about a month. Thank you for reading.";
    const notes = detectNotices([
      chapter("Hiatus notice", body),
      chapter("The Ledger Opens", storyText()),
      chapter("Hiatus notice (reposted)", body),
    ]);
    expect(notes[0]?.kind).toBe("hiatus");
    expect(notes[2]?.kind).toBe("duplicate");
    expect(notes[2]?.evidence).toContain("same text as chapter 1");
  });

  test("a short notice with no keyword in it is still a notice", () => {
    // it is short, addressed to readers and has no dialogue; `progress` is the least specific kind
    const note = noteOn([
      chapter(
        "A quick word",
        "Just a short note before the next chapter. Thank you for reading, and see you next time.",
      ),
    ]);
    expect(note?.kind).toBe("progress");
    expect(note?.verdict).toBe("skip");
  });

  test("a full chapter that opens with an author note is sent for review, not skipped", () => {
    const note = noteOn([
      chapter(
        "A Debt in Three Currencies",
        `Author's note: this chapter was rewritten after some sharp comments on the last one — thank you for those. On with the story.\n\n${storyText()}`,
      ),
    ]);
    expect(note?.kind).toBe("mixed");
    expect(note?.at).toBe("start");
    expect(note?.verdict).toBe("review");
    expect(note?.reason).toBe("Starts with an author note");
  });

  test("a note at the end of a chapter is found there too", () => {
    const note = noteOn([
      chapter(
        "Arrears",
        `${storyText()}\n\nThat's the chapter. A short note: I'm travelling next week, so the Wednesday release may slip to Thursday. Thank you for reading.`,
      ),
    ]);
    expect(note?.kind).toBe("mixed");
    expect(note?.at).toBe("end");
    expect(note?.reason).toBe("Ends with an author note");
  });

  test("a story chapter only titled like a notice is sent for review, not skipped", () => {
    // skipping this would drop a real chapter, which is the one mistake that must not be automatic
    const note = noteOn([chapter("Author's Note", storyText())]);
    expect(note?.kind).toBe("title");
    expect(note?.verdict).toBe("review");
    expect(note?.evidence).toContain("the title matches a notice pattern");
  });

  test("a keyword the author italicised is still the keyword", () => {
    // The text is stored with its emphasis marked, so the checks read the prose rather than the
    // markers: `*hiatus*` is the same announcement as `hiatus`.
    const note = noteOn([
      chapter(
        "A short break",
        "I am going on *hiatus* for two weeks. Thank you for reading, and sorry for the wait.",
      ),
    ]);
    expect(note?.kind).toBe("hiatus");
  });

  test("a chapter of Chinese prose is story, not a one-word notice", () => {
    // Chinese has no spaces, so splitting on whitespace reads a whole chapter as one word — under
    // every short-notice threshold there is, with a "skip" suggestion attached to it.
    const line = "他抬起头，望向远处的山峦，心里明白这笔账迟早要算清楚。";
    const text = Array.from({ length: 40 }, () => line).join("\n\n");
    const chs = [chapter("第十二章", text)];
    expect(chs[0].words).toBeGreaterThan(600);
    expect(noteOn(chs)).toBeNull();
  });

  test("a chapter the file could not supply is sent for review, and says why", () => {
    const lost = { ...chapter("Salt Tax", ""), unreadable: true as const };
    const note = noteOn([lost]);
    expect(note?.kind).toBe("unreadable");
    // never an automatic skip: nobody has seen what was in it
    expect(note?.verdict).toBe("review");
    expect(note?.evidence).toContain("the file could not be read");
  });

  test("a chapter with no text is not called a notice", () => {
    // an empty chapter is a parse problem; "notice" would hide it behind a suggestion to skip
    expect(noteOn([chapter("Chapter 12", "")])).toBeNull();
  });

  test("every note a chapter can carry is one the review can act on", () => {
    const notes = detectNotices([
      chapter("Hiatus", "Going on hiatus for a few weeks. Thank you for reading."),
      chapter("The Ledger Opens", storyText()),
      chapter("Author's Note", storyText()),
    ]).filter((n): n is ChapterNote => n != null);
    expect(notes).toHaveLength(2);
    // the review reads `verdict` to decide whether to suggest a skip or ask for a look
    expect(notes.every((n) => n.verdict === "skip" || n.verdict === "review")).toBe(true);
    // and shows `reason` beside the title, so it must never be empty
    expect(notes.every((n) => n.reason.length > 0)).toBe(true);
    expect(notes.every((n) => n.evidence.length > 0)).toBe(true);
  });
});
