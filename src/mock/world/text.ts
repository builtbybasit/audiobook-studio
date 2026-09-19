// What a chapter reads as. The prototype parses no file, so a chapter's text is composed here from
// its note: a notice reads as the notice, story reads as story, and a chapter that carries both
// reads as both with the note marked — which is what lets the review show where the note sits.
//
// This is the one source of chapter text: the picker's peek, the contents preview, the scripting
// estimate and the mock scripting run all read it, so they cannot disagree about what a chapter says.
import { generateSegments } from "@/mock/world/script";
import { noticeBody } from "@/mock/fixtures/notices";
import { BOOK_SEEDS } from "@/mock/fixtures/books";
import type { Chapter } from "@/types";

/** A run of text, marked when it is the note rather than the story. */
export interface ContentPart {
  text: string;
  notice?: boolean;
}

/** The seeded prose an imported book reads with — its sample says which, and a seeded book is its own. */
const proseOf = (bookId: string, prose?: string): string =>
  BOOK_SEEDS.some((b) => b.id === bookId) ? bookId : (prose ?? BOOK_SEEDS[0].id);

const storyOf = (bookId: string, chId: number, prose?: string): string =>
  generateSegments(proseOf(bookId, prose), chId)
    .map((x) => x.text)
    .join("\n\n");

/**
 * The chapter's text in the order it is read. `prose` names the seeded book an imported one
 * borrows its story from; a note's `variant` picks which wording the notice uses, so repeated
 * announcements read as related rather than identical.
 */
export function chapterParts(
  bookId: string,
  chId: number,
  chapter: Chapter | undefined,
  prose?: string,
): ContentPart[] {
  const note = chapter?.note;
  const variant = note?.variant ?? chId;
  // `unreadable` is the import saying it could not read the file. Nothing in the demo reads one, so
  // there is no notice body to show and the chapter reads as the story it stands in for.
  // The seeded world's prose is plain, and plain prose is valid Markdown that parses to itself —
  // so the review draws both through one path rather than branching on where the text came from.
  if (!note || note.kind === "title" || note.kind === "unreadable")
    return [{ text: storyOf(bookId, chId, prose) }];
  if (note.kind === "mixed") {
    const noteText = noticeBody("mixed", variant);
    const story = { text: storyOf(bookId, chId, prose) };
    return note.at === "end"
      ? [story, { text: noteText, notice: true }]
      : [{ text: noteText, notice: true }, story];
  }
  return [{ text: noticeBody(note.kind, variant), notice: true }];
}

export const partsText = (parts: ContentPart[]): string => parts.map((p) => p.text).join("\n\n");
