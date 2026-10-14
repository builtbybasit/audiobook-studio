// What the Narration page reads before it can say anything true, and whether it has.
// Until a query lands the store getters answer 0, "" and [], which would read as "no voices" or
// "$0.00", so the page draws nothing until every read here has landed. Missing endpoint
// configuration is a failed read, never an empty pool.
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { computed, ref, toValue, type MaybeRefOrGetter } from "vue";

import { useBookScripts, useCast, useChapterScript } from "@/queries";
import { isScripted } from "@/lib/scriptReview";

export function useNarrationData(bookId: string, opened: MaybeRefOrGetter<number>) {
  const castStore = useCastStore();
  const endpointsStore = useEndpointsStore();
  const libraryStore = useLibraryStore();
  const scriptsStore = useScriptsStore();

  const cast = useCast(bookId);
  const script = useChapterScript(bookId, opened);
  const book = useBookScripts(bookId);
  /** a read of the endpoints asked for again, still out */
  const rereading = ref(false);

  const castHeld = computed(() => castStore.held(bookId));
  // a chapter with no script has nothing for the ledger to show, and says so without waiting
  const scriptHeld = computed(() => {
    const chapter = libraryStore.chapter(bookId, toValue(opened));
    return !chapter || !isScripted(chapter) || scriptsStore.held(bookId, chapter.id);
  });
  // held rather than "not loading": a chapter read again after a clip lands is still here meanwhile
  const bookHeld = computed(() =>
    libraryStore
      .chaptersOf(bookId)
      .filter(isScripted)
      .every((c) => scriptsStore.held(bookId, c.id)),
  );

  const ready = computed(
    () => castHeld.value && scriptHeld.value && bookHeld.value && endpointsStore.loaded,
  );
  /** why the page cannot show what it reads, while a read it needs has failed */
  const error = computed<string | null>(() => {
    if (!castHeld.value && cast.error.value) return "The cast could not be read.";
    if (!scriptHeld.value && script.error.value) return "This chapter’s script could not be read.";
    if (!bookHeld.value && book.failed.value.length)
      return `${book.failed.value.length === 1 ? "A chapter’s script" : `${book.failed.value.length} chapters’ scripts`} could not be read.`;
    if (!endpointsStore.loaded && !rereading.value)
      return "The endpoint configuration could not be read.";
    return null;
  });
  async function retry(): Promise<void> {
    if (!castHeld.value) void cast.refetch();
    if (!scriptHeld.value) void script.refetch();
    book.retry();
    if (!endpointsStore.loaded) {
      rereading.value = true;
      try {
        await endpointsStore.load();
      } finally {
        rereading.value = false;
      }
    }
  }
  return { ready, error, retry };
}
