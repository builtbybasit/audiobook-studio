// A book's finished audiobooks, and the one place the Export page reads them from. They are the
// server's: a build adds the entry it started, the queue's poll invalidates this key as that job
// moves, and forgetting one is a request. The exports store's `exports` reads these entries.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import type { ExportItem } from "@/types";
import { keys } from "@/queries/keys";
import { libraryService } from "@/services/library";

export function useBookExports(bookId: MaybeRefOrGetter<string>) {
  const query = useQuery(() => ({
    key: keys.exports(toValue(bookId)),
    staleTime: Infinity,
    query: (): Promise<ExportItem[]> => libraryService().exports(toValue(bookId)),
  }));
  return { ...query, exports: computed(() => query.data.value ?? []) };
}
