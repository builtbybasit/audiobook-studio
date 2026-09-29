// A chapter's script, read into the scripts store.
//
// The scripts store is the working copy: every edit and every undo act on `scripts.segments`, and
// the pages read it. This query is how that copy is filled and kept fresh — what comes back is
// installed into the store with the revision a later edit has to name. It is invalidated by the
// things that change a script elsewhere: a scripting job landing, a rename moving lines, a book
// being renumbered.
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";

import { keys } from "@/queries/keys";
import { libraryService, type ChapterScript } from "@/services/library";
import { useScriptsStore } from "@/stores/scripts";

async function readScript(bookId: string, chapterId: number): Promise<ChapterScript> {
  const script = await libraryService().chapterScript(bookId, chapterId);
  useScriptsStore()._install(bookId, chapterId, script);
  return script;
}

/** One chapter's script as a query: what `useChapterScript` watches and `useChapterScripts` reads. */
const scriptQuery = (bookId: string, chapterId: number) => ({
  key: keys.chapterScript(bookId, chapterId),
  // A script changes under the app only through the queue or another tab, and the queue
  // invalidates it when a job lands; a re-read on every focus would replace an edit in progress.
  staleTime: Infinity,
  query: () => readScript(bookId, chapterId),
});

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
 */
export function useChapterScripts(
  bookId: MaybeRefOrGetter<string>,
  chapterIds: MaybeRefOrGetter<readonly number[]>,
): void {
  const queryCache = useQueryCache();
  watch(
    () => [...toValue(chapterIds)],
    (ids) => {
      for (const id of ids)
        // a read that fails is in its entry's error state, and read again the next time it is asked for
        void queryCache
          .refresh(queryCache.ensure(scriptQuery(toValue(bookId), id)))
          .catch(() => {});
    },
    { immediate: true },
  );
}
