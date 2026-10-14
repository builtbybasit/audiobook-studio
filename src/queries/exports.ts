// A book's finished audiobooks, the one place the Export page reads them. The queue's poll
// invalidates this key as a build moves; the exports store's `exports` reads these entries.
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
