// A chapter's script, read into the scripts store.
//
// The scripts store is the working copy: every edit, every undo and the seeded world act on
// `scripts.segments`, and the pages read it. This query is how that copy is filled and kept fresh
// with a server answering — what comes back is installed into the store with the revision a later
// edit has to name — and in the demo it simply answers with what the store already holds. It is
// invalidated by the things that change a script elsewhere: a scripting job landing, a rename
// moving lines, a book being renumbered.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import { keys } from "@/queries/keys";
import { activeLibraryService, type ChapterScript } from "@/services/library";
import { useScriptsStore } from "@/stores/scripts";

async function readScript(bookId: string, chapterId: number): Promise<ChapterScript> {
  const scriptsStore = useScriptsStore();
  const svc = activeLibraryService();
  if (!svc) return { segments: scriptsStore.segmentsOf(bookId, chapterId), revision: 0 };
  const script = await svc.chapterScript(bookId, chapterId);
  scriptsStore._install(bookId, chapterId, script);
  return script;
}

export function useChapterScript(
  bookId: MaybeRefOrGetter<string>,
  chapterId: MaybeRefOrGetter<number | null | undefined>,
) {
  const scriptsStore = useScriptsStore();
  const query = useQuery(() => ({
    key: keys.chapterScript(toValue(bookId), toValue(chapterId) ?? 0),
    enabled: toValue(chapterId) != null,
    // A script changes under the app only through the queue or another tab, and the queue
    // invalidates it when a job lands; a re-read on every focus would replace an edit in progress.
    staleTime: Infinity,
    query: () => readScript(toValue(bookId), toValue(chapterId)!),
  }));
  const segments = computed(() => {
    const ch = toValue(chapterId);
    return ch == null ? [] : scriptsStore.segmentsOf(toValue(bookId), ch);
  });
  /** Whether the script has been read yet: `segments` is empty both before and for a chapter with none. */
  const loaded = computed(() => query.status.value === "success");
  return { ...query, segments, loaded };
}
