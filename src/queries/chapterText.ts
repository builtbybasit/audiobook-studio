// A chapter's prose, as the page that shows it reads it.
//
// The prose is asked for through the library service in the form the caller needs — `markdown`
// for the contents review, `plain` for anything that counts or bills — and kept by the query cache
// until the chapter's number moves.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";

import { partsText, type ContentPart } from "@/lib/contents";
import { keys } from "@/queries/keys";
import { libraryService, type TextFormat } from "@/services/library";

async function readParts(
  bookId: string,
  chapterId: number,
  format: TextFormat,
): Promise<ContentPart[]> {
  // The import recorded what it thought of a chapter as a note on the chapter itself, not as a
  // range inside the prose, so the server's text is one part.
  return [{ text: await libraryService().chapterText(bookId, chapterId, format) }];
}

export function useChapterText(
  bookId: MaybeRefOrGetter<string>,
  chapterId: MaybeRefOrGetter<number | null | undefined>,
  format: TextFormat = "markdown",
) {
  const query = useQuery(() => ({
    key: keys.chapterText(toValue(bookId), toValue(chapterId) ?? 0, format),
    enabled: toValue(chapterId) != null,
    // Prose does not change under the app: once read, a chapter's text is right until the book is
    // renumbered or removed, and both invalidate everything under the book.
    staleTime: Infinity,
    query: () => readParts(toValue(bookId), toValue(chapterId)!, format),
  }));
  const parts = computed<ContentPart[]>(() => query.data.value ?? []);
  const text = computed(() => partsText(parts.value));
  return { ...query, parts, text };
}

/**
 * A chapter's prose right now, for a store that needs it synchronously: whatever the query cache
 * already holds. Empty when nothing has read it yet.
 */
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
