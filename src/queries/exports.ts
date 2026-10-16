// A book's finished audiobooks, the one place the Export page reads them. The queue's poll
// invalidates this key as a build moves; the exports store's `exports` reads these entries.
import {
  computed,
  effectScope,
  onScopeDispose,
  toValue,
  watch,
  type EffectScope,
  type MaybeRefOrGetter,
} from "vue";
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

/** Many books' audiobooks at once, kept read while the caller lives (the Library's cards and counts). */
export function useShelfExports(bookIds: MaybeRefOrGetter<readonly string[]>): void {
  const reading = new Map<string, EffectScope>();
  watch(
    () => toValue(bookIds),
    (ids) => {
      for (const [id, scope] of reading)
        if (!ids.includes(id)) {
          scope.stop();
          reading.delete(id);
        }
      for (const id of ids)
        if (!reading.has(id)) {
          const scope = effectScope(true);
          scope.run(() => useBookExports(id));
          reading.set(id, scope);
        }
    },
    { immediate: true },
  );
  onScopeDispose(() => reading.forEach((scope) => scope.stop()));
}
