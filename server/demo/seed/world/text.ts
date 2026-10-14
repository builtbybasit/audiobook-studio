// A demo chapter's text, composed from its note: a notice, story, or both with the note marked.
// The one source of demo chapter text, so every reader agrees.
import { generateProse } from "~/demo/seed/world/script";
import { noticeBody } from "~/demo/seed/fixtures/notices";
import { BOOK_SEEDS } from "~/demo/seed/fixtures/books";
import type { ContentPart } from "@/lib/contents";
import type { Chapter } from "@/types";

export { partsText, type ContentPart } from "@/lib/contents";

/** An imported book borrows its sample's prose; a seeded book has its own. */
const proseOf = (bookId: string, prose?: string): string =>
  BOOK_SEEDS.some((b) => b.id === bookId) ? bookId : (prose ?? BOOK_SEEDS[0].id);

const storyOf = (bookId: string, chId: number, prose?: string): string =>
  generateProse(proseOf(bookId, prose), chId);

/** A note's `variant` picks the notice's wording, so repeated announcements differ. */
export function chapterParts(
  bookId: string,
  chId: number,
  chapter: Chapter | undefined,
  prose?: string,
): ContentPart[] {
  const note = chapter?.note;
  const variant = note?.variant ?? chId;
  // these have no notice body in the demo (no file is read), so they read as story
  if (
    !note ||
    note.kind === "title" ||
    note.kind === "unreadable" ||
    note.kind === "empty" ||
    note.kind === "front"
  )
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
