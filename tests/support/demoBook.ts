// One book of the demo library, read into the stores the way its pages read it.
//
// `demoServer()` answers the page's services; this is the reading a page does on top of it — the
// shelf, the book and its chapters, the endpoints, the cast, and every chapter's script and plain
// prose — so a test of what a store works out from them (a plan, an estimate, a retry's scope) has
// the seeded book in hand without opening each page's queries.
import { useQueryCache } from "@pinia/colada";

import { keys } from "@/queries/keys";
import { libraryService } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import type { TestPinia } from "./pinia";

/**
 * Read `bookId` and everything a stage page shows of it into `pinia`'s stores and query cache.
 *
 * Every store is taken before the first await: a query a previous test's app left settling can
 * make its own Pinia the active one again while this is waiting on a read.
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
