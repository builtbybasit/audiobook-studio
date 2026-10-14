// A chapter's script, read into the scripts store (the working copy), with the revision the next
// edit names. Invalidated by whatever changes a script elsewhere: a job landing, a rename, a
// renumber.
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";

import { batchReads } from "@/queries/batch";
import { fetchQuery } from "@/queries/fetch";
import { keys } from "@/queries/keys";
import { libraryService, type ChapterScript } from "@/services/library";
import { isScripted } from "@/lib/scriptReview";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";

async function readScript(
  bookId: string,
  chapterId: number,
  signal: AbortSignal,
): Promise<ChapterScript> {
  const script = await readScripts(bookId, chapterId);
  // a read overtaken by a later one leaves the store to the later one
  if (!signal.aborted) useScriptsStore()._install(bookId, chapterId, script);
  return script;
}

// a page reading every script of a long book reads them a few requests at a time
const readScripts = batchReads((bookId, ids) => libraryService().chapterScripts(bookId, ids));

/** One chapter's script query: what `useChapterScript` watches and `useChapterScripts` reads. */
const scriptQuery = (bookId: string, chapterId: number) => ({
  key: keys.chapterScript(bookId, chapterId),
  // Only the queue or another tab changes a script, and the queue invalidates it; a refetch on
  // focus would replace an edit in progress.
  staleTime: Infinity,
  query: ({ signal }: { signal: AbortSignal }) => readScript(bookId, chapterId, signal),
});

/** Read a chapter's script now and install it, open or not (say, after a refused write). */
export function fetchScript(bookId: string, chapterId: number): Promise<ChapterScript> {
  return fetchQuery(scriptQuery(bookId, chapterId));
}

export function useChapterScript(
  bookId: MaybeRefOrGetter<string>,
  chapterId: MaybeRefOrGetter<number | null | undefined>,
) {
  const scriptsStore = useScriptsStore();
  const query = useQuery(() => ({
    ...scriptQuery(toValue(bookId), toValue(chapterId) ?? 0),
    enabled: toValue(chapterId) != null,
  }));
  const segments = computed(() => {
    const ch = toValue(chapterId);
    return ch == null ? [] : scriptsStore.segmentsOf(toValue(bookId), ch);
  });
  /** Whether the script has been read: `segments` is empty both before and for none. */
  const loaded = computed(() => query.status.value === "success");
  return { ...query, segments, loaded };
}

/**
 * The scripts of every chapter in `chapterIds`, read into the store as the list changes, for
 * counts across chapters a page does not show. A failed read stays an error, not an empty
 * chapter: `failed`, `error` and `retry` let the page say its counts are short.
 */
export function useChapterScripts(
  bookId: MaybeRefOrGetter<string>,
  chapterIds: MaybeRefOrGetter<readonly number[]>,
) {
  const queryCache = useQueryCache();
  const read = (ids: readonly number[]) => {
    for (const id of ids)
      // the entry holds the failure, which `failed` reads
      void queryCache.refresh(queryCache.ensure(scriptQuery(toValue(bookId), id))).catch(() => {});
  };
  watch(() => [...toValue(chapterIds)], read, { immediate: true });
  const entries = computed(() =>
    toValue(chapterIds).map((id) => ({
      id,
      entry: queryCache.getEntries({
        key: keys.chapterScript(toValue(bookId), id),
        exact: true,
      })[0],
    })),
  );
  const failed = computed(() =>
    entries.value.filter(({ entry }) => entry?.state.value.status === "error").map(({ id }) => id),
  );
  return {
    /** chapters whose script could not be read, so every count across them is short */
    failed,
    /** why the first of them could not be read */
    error: computed(
      () =>
        entries.value.find(({ entry }) => entry?.state.value.status === "error")?.entry?.state.value
          .error ?? null,
    ),
    /** whether any of them is being read right now */
    loading: computed(() =>
      entries.value.some(({ entry }) => entry?.asyncStatus.value === "loading"),
    ),
    retry: () => read(failed.value),
  };
}

/** Every scripted chapter's script, for pages reading lines across the book. */
export function useBookScripts(bookId: MaybeRefOrGetter<string>) {
  const libraryStore = useLibraryStore();
  return useChapterScripts(bookId, () =>
    libraryStore
      .chaptersOf(toValue(bookId))
      .filter(isScripted)
      .map((c) => c.id),
  );
}
