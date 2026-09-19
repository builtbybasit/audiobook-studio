// A chapter's prose, as the page that shows it reads it.
//
// With a server answering, the prose is asked for through the library service in the form the
// caller needs — `markdown` for the contents review, `plain` for anything that counts or bills —
// and kept by the query cache until the chapter's number moves. In the seeded demo it is generated
// from the world on demand, in parts, with the author's note marked. One composable, one seam:
// the page reads `parts` and never knows which answered.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";

import { chapterParts, partsText, type ContentPart } from "@/mock";
import { keys } from "@/queries/keys";
import { activeLibraryService, type TextFormat } from "@/services/library";
import { useLibraryStore } from "@/stores/library";

/** The seeded world's prose for a chapter: its parts, with any author's note marked. */
function seededParts(bookId: string, chapterId: number): ContentPart[] {
  const libraryStore = useLibraryStore();
  return chapterParts(
    bookId,
    chapterId,
    libraryStore.chapter(bookId, chapterId),
    libraryStore.bookById(bookId)?.sample,
  );
}

async function readParts(
  bookId: string,
  chapterId: number,
  format: TextFormat,
): Promise<ContentPart[]> {
  const svc = activeLibraryService();
  if (!svc) return seededParts(bookId, chapterId);
  // The import recorded what it thought of a chapter as a note on the chapter itself, not as a
  // range inside the prose, so the server's text is one part.
  return [{ text: await svc.chapterText(bookId, chapterId, format) }];
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
 * A chapter's prose right now, for a store that needs it synchronously: the seeded world's, or
 * whatever the query cache already holds. Empty when nothing has read it yet — never a fixture
 * standing in for a real book.
 */
export function chapterTextNow(bookId: string, chapterId: number, format: TextFormat): string {
  if (!activeLibraryService()) return partsText(seededParts(bookId, chapterId));
  const cached = useQueryCache().getQueryData<ContentPart[]>(
    keys.chapterText(bookId, chapterId, format),
  );
  return cached ? partsText(cached) : "";
}

export function chapterPartsNow(bookId: string, chapterId: number): ContentPart[] {
  if (!activeLibraryService()) return seededParts(bookId, chapterId);
  return (
    useQueryCache().getQueryData<ContentPart[]>(keys.chapterText(bookId, chapterId, "markdown")) ??
    []
  );
}
