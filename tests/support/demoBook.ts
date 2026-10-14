// Reads one demo book into the stores and query cache as its pages would, so a store test has the
// seeded book in hand without opening each page's queries.
import { useQueryCache } from "@pinia/colada";

import { keys } from "@/queries/keys";
import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import type { TestPinia } from "./pinia";

/**
 * Every store is taken before the first await: a query a previous test left settling can make its
 * own Pinia active again while this waits.
 */
export async function openDemoBook(pinia: TestPinia, bookId: string): Promise<void> {
  const libraryStore = useLibraryStore();
  const endpointsStore = useEndpointsStore();
  const castStore = useCastStore();
  const scriptsStore = useScriptsStore();
  const cache = pinia.run(() => useQueryCache());
  const svc = libraryService();
  await libraryStore.load(true);
  await libraryStore.loadBook(bookId);
  await endpointsStore.load(true);
  castStore._install(bookId, await svc.cast(bookId));
  for (const c of libraryStore.chaptersOf(bookId)) {
    scriptsStore._install(bookId, c.id, await svc.chapterScript(bookId, c.id));
    // what `chapterTextNow` reads: the prose as `useChapterText` leaves it in the cache
    const text = await svc.chapterText(bookId, c.id, "plain");
    cache.setQueryData(keys.chapterText(bookId, c.id, "plain"), [{ text }]);
  }
}
