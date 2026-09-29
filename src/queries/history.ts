// A chapter's script history, read into the history store.
//
// The history is the server's: an edit, a checkpoint and a restore each
// write it there, in the transaction that writes the script, and answer with the history as it
// now stands — which the store installs, so the panel follows without asking again. This query is
// the read on opening a chapter, and what the queue invalidates when a scripting job lands.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import type { ChapterHistory } from "@/types";
import { keys } from "@/queries/keys";
import { libraryService } from "@/services/library";
import { useHistoryStore } from "@/stores/history";

async function readHistory(bookId: string, chapterId: number): Promise<ChapterHistory> {
  const history = await libraryService().chapterHistory(bookId, chapterId);
  useHistoryStore()._install(bookId, chapterId, history);
  return history;
}

export function useChapterHistory(
  bookId: MaybeRefOrGetter<string>,
  chapterId: MaybeRefOrGetter<number | null | undefined>,
) {
  const historyStore = useHistoryStore();
  const query = useQuery(() => ({
    key: keys.chapterHistory(toValue(bookId), toValue(chapterId) ?? 0),
    enabled: toValue(chapterId) != null,
    staleTime: Infinity,
    query: () => readHistory(toValue(bookId), toValue(chapterId)!),
  }));
  const history = computed(() => {
    const ch = toValue(chapterId);
    return historyStore.historyOf(toValue(bookId), ch ?? 0);
  });
  const versions = computed(() => [...history.value.versions].reverse());
  return { ...query, history, versions, head: computed(() => history.value.head) };
}
