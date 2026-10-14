// A chapter's prose, in the form the caller needs (`markdown` for the contents review, `plain` for
// anything that counts or bills), cached until the chapter's number moves.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";

import { partsText, type ContentPart } from "@/lib/contents";
import { batchReads } from "@/queries/batch";
import { keys } from "@/queries/keys";
import { libraryService, type TextFormat } from "@/services/library";

async function readParts(
  bookId: string,
  chapterId: number,
  format: TextFormat,
): Promise<ContentPart[]> {
  // the import's verdict is a note on the chapter, not a range in the prose, so this is one part
  return [{ text: await readText(`${format}:${bookId}`, chapterId) }];
}
// a page reading hundreds of chapters reads them a few requests at a time
const readText = batchReads((group, ids) => {
  // a book's id has no colon in it (`BOOK_ID`)
  const [format, bookId] = group.split(":") as [TextFormat, string];
  return libraryService().chapterTexts(bookId, ids, format);
});

/** One chapter's prose as a query: what `useChapterText` watches and `useChapterTexts` reads. */
export const textQuery = (bookId: string, chapterId: number, format: TextFormat) => ({
  key: keys.chapterText(bookId, chapterId, format),
  // Prose does not change under the app; a renumber or removal invalidates the whole book.
  staleTime: Infinity,
  query: () => readParts(bookId, chapterId, format),
});

export function useChapterText(
  bookId: MaybeRefOrGetter<string>,
  chapterId: MaybeRefOrGetter<number | null | undefined>,
  format: TextFormat = "markdown",
) {
  const query = useQuery(() => ({
    ...textQuery(toValue(bookId), toValue(chapterId) ?? 0, format),
    enabled: toValue(chapterId) != null,
  }));
  const parts = computed<ContentPart[]>(() => query.data.value ?? []);
  const text = computed(() => partsText(parts.value));
  return { ...query, parts, text };
}

/** A chapter's cached prose, for synchronous store callers. Empty when unread. */
export function chapterTextNow(bookId: string, chapterId: number, format: TextFormat): string {
  const cached = useQueryCache().getQueryData<ContentPart[]>(
    keys.chapterText(bookId, chapterId, format),
  );
  return cached ? partsText(cached) : "";
}

export function chapterPartsNow(bookId: string, chapterId: number): ContentPart[] {
  return (
    useQueryCache().getQueryData<ContentPart[]>(keys.chapterText(bookId, chapterId, "markdown")) ??
    []
  );
}
