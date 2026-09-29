// A book's finished audiobooks, read into the exports store, and the one place the Export page
// reads them from. They are the server's: a build adds the entry it started, the queue's poll
// invalidates this key as that job moves, and forgetting one is a request.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import type { ExportItem } from "@/types";
import { keys } from "@/queries/keys";
import { libraryService } from "@/services/library";
import { useExportsStore } from "@/stores/exports";

async function readExports(bookId: string): Promise<ExportItem[]> {
  const list = await libraryService().exports(bookId);
  useExportsStore()._install(bookId, list);
  return list;
}

export function useBookExports(bookId: MaybeRefOrGetter<string>) {
  const exportsStore = useExportsStore();
  const query = useQuery(() => ({
    key: keys.exports(toValue(bookId)),
    staleTime: Infinity,
    query: () => readExports(toValue(bookId)),
  }));
  return {
    ...query,
    exports: computed(() => exportsStore.exports.filter((e) => e.bookId === toValue(bookId))),
  };
}
