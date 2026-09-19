// A book's finished audiobooks, read into the exports store. Nothing on the server builds one
// yet, so with a server answering this is an empty list until there is a build job; it exists so
// the Export page reads one path in both modes, and so forgetting one is a request.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import type { ExportItem } from "@/types";
import { keys } from "@/queries/keys";
import { activeLibraryService } from "@/services/library";
import { useExportsStore } from "@/stores/exports";

async function readExports(bookId: string): Promise<ExportItem[]> {
  const exportsStore = useExportsStore();
  const svc = activeLibraryService();
  if (!svc) return exportsStore.exports.filter((e) => e.bookId === bookId);
  const list = await svc.exports(bookId);
  exportsStore._install(bookId, list);
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
