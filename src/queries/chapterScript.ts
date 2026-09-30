// A chapter's script, read into the scripts store.
//
// The scripts store is the working copy: every edit and every undo act on `scripts.segments`, and
// the pages read it. This query is how that copy is filled and kept fresh — what comes back is
// installed into the store with the revision a later edit has to name. It is invalidated by the
// things that change a script elsewhere: a scripting job landing, a rename moving lines, a book
// being renumbered.
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";

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
  const script = await libraryService().chapterScript(bookId, chapterId);
  // a read overtaken by a later one leaves the store to the later one
  if (!signal.aborted) useScriptsStore()._install(bookId, chapterId, script);
  return script;
}

/** One chapter's script as a query: what `useChapterScript` watches and `useChapterScripts` reads. */
const scriptQuery = (bookId: string, chapterId: number) => ({
  key: keys.chapterScript(bookId, chapterId),
  // A script changes under the app only through the queue or another tab, and the queue
  // invalidates it when a job lands; a re-read on every focus would replace an edit in progress.
  staleTime: Infinity,
  query: ({ signal }: { signal: AbortSignal }) => readScript(bookId, chapterId, signal),
});

/**
 * A chapter's script read from the server now and installed, whether or not a page has the
 * chapter open — for a store that needs the server's script, like one whose write was refused.
 */
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
  /** Whether the script has been read yet: `segments` is empty both before and for a chapter with none. */
  const loaded = computed(() => query.status.value === "success");
  return { ...query, segments, loaded };
}

/**
 * The scripts of every chapter in `chapterIds`, read into the scripts store as the list changes —
 * for a page that counts lines across chapters it does not show, like the Narration page's run plan
 * over the chapters picked. A script already read is not read again; the queue's invalidation keeps
 * each one fresh after that, as it does the chapter a page has open.
 *
 * A read that fails stays in its entry's error state rather than reading as a chapter with no
 * lines: `failed` names those chapters and `error` says why, so the page can say its counts are
 * short, and `retry` reads them again.
 */
export function useChapterScripts(
  bookId: MaybeRefOrGetter<string>,
  chapterIds: MaybeRefOrGetter<readonly number[]>,
) {
  const queryCache = useQueryCache();
  const read = (ids: readonly number[]) => {
    for (const id of ids)
      // the entry holds the failure, which `failed` reads; the rejection itself has nobody to tell
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
    /** read the chapters that failed again */
    retry: () => read(failed.value),
  };
}

/**
 * Every scripted chapter's script of the book, for a page that reads lines across all of them —
 * Search, the review inbox, a speaker's line count, the dictionary's uses. A chapter scripted
 * while the page is open is read as it becomes one.
 */
export function useBookScripts(bookId: MaybeRefOrGetter<string>) {
  const libraryStore = useLibraryStore();
  return useChapterScripts(bookId, () =>
    libraryStore
      .chaptersOf(toValue(bookId))
      .filter(isScripted)
      .map((c) => c.id),
  );
}
