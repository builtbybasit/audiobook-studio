// The shelf, and each book with its chapters, read into the library store (the working copy).
// Every read of a book goes through these, so a later read aborts an earlier one and an aborted
// read installs nothing. Entries are never collected: the store keeps what they read anyway.
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";

import type { Book } from "@/types";
import { fetchQuery } from "@/queries/fetch";
import { keys } from "@/queries/keys";
import { libraryService, type ImportedBook } from "@/services/library";
import { useLibraryStore } from "@/stores/library";

async function readShelf(signal: AbortSignal): Promise<Book[]> {
  const books = await libraryService().books();
  if (!signal.aborted) useLibraryStore()._shelve(books);
  return books;
}

async function readBook(bookId: string, signal: AbortSignal): Promise<ImportedBook> {
  const answer = await libraryService().book(bookId);
  if (!signal.aborted) useLibraryStore()._put(answer.book, answer.chapters);
  return answer;
}

const shelfQuery = {
  key: keys.shelf,
  staleTime: Infinity,
  gcTime: false as const,
  query: ({ signal }: { signal: AbortSignal }) => readShelf(signal),
};

const bookQuery = (bookId: string) => ({
  key: keys.book(bookId),
  staleTime: Infinity,
  gcTime: false as const,
  query: ({ signal }: { signal: AbortSignal }) => readBook(bookId, signal),
});

/** The shelf read from the server now and installed. Throws what the read threw. */
export function fetchShelf(): Promise<Book[]> {
  return fetchQuery(shelfQuery);
}

/** One book and its chapters read from the server now and installed. Throws what the read threw. */
export function fetchBook(bookId: string): Promise<ImportedBook> {
  return fetchQuery(bookQuery(bookId));
}

/** The books the library lists, as the library store holds them. */
export function useShelf() {
  const libraryStore = useLibraryStore();
  const query = useQuery(shelfQuery);
  return { ...query, books: computed(() => libraryStore.books) };
}

/** One book and its chapters, read when a page opens it, as the library store holds them. */
export function useBook(bookId: MaybeRefOrGetter<string | null | undefined>) {
  const libraryStore = useLibraryStore();
  const query = useQuery(() => ({
    ...bookQuery(toValue(bookId) ?? ""),
    enabled: !!toValue(bookId),
  }));
  return {
    ...query,
    book: computed(() => libraryStore.bookById(toValue(bookId) ?? "")),
    chapters: computed(() => libraryStore.chaptersOf(toValue(bookId) ?? "")),
  };
}

/**
 * Every book in `bookIds` read with its chapters as the list changes, for pages like the Queue.
 * Each is read once here; the queue's poll rereads it as its jobs move.
 */
export function useBooks(bookIds: MaybeRefOrGetter<readonly string[]>) {
  const queryCache = useQueryCache();
  const read = (ids: readonly string[]) => {
    for (const id of new Set(ids))
      // the entry holds a failure, which `failed` reads
      void queryCache.refresh(queryCache.ensure(bookQuery(id))).catch(() => {});
  };
  // watched through its joined ids, so a list rebuilt with the same books reads nothing
  const joined = computed(() => [...new Set(toValue(bookIds))].join("\n"));
  watch(joined, () => read(toValue(bookIds)), { immediate: true });
  return {
    /** books that could not be read */
    failed: computed(() =>
      [...new Set(toValue(bookIds))].filter(
        (id) =>
          queryCache.getEntries({ key: keys.book(id), exact: true })[0]?.state.value.status ===
          "error",
      ),
    ),
  };
}
