// What a book has spent and what its unfinished work holds, from the server's ledger, kept in the
// query cache; the jobs store's budget figures answer from it (`spendOf`). The queue's poll and
// budget writes invalidate it (`spendMoved`); only what a page shows is refetched at once.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import type { BookSpend } from "@/types";
import { fetchQuery } from "@/queries/fetch";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { usageService } from "@/services/usage";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";

const readSpend = (bookId: string): Promise<BookSpend> => usageService().bookSpend(bookId);

const spendQuery = (bookId: string) => ({
  key: keys.spend(bookId),
  staleTime: Infinity,
  query: () => readSpend(bookId),
});

/** Read a book's spending now, shown or not, e.g. for a run on a book no page has open. */
export function fetchSpend(bookId: string): Promise<BookSpend> {
  return fetchQuery(spendQuery(bookId));
}

/** One book's spending, read while a page shows it. */
export function useBookSpend(bookId: MaybeRefOrGetter<string | null | undefined>) {
  const jobsStore = useJobsStore();
  const query = useQuery(() => ({
    ...spendQuery(toValue(bookId) ?? ""),
    enabled: !!toValue(bookId),
  }));
  return {
    ...query,
    /** the server's figures; null until the first read lands */
    spend: computed(() => {
      const id = toValue(bookId);
      return id ? (jobsStore.spendOf(id) ?? null) : null;
    }),
  };
}

/** Every book on the shelf's spending, for the pages that list or total the library. */
export function useLibrarySpend() {
  const libraryStore = useLibraryStore();
  // the shelf is in the key, so adding a book is a new read; `keys.librarySpend` still matches
  // every entry by prefix
  const ids = computed(() => libraryStore.books.map((b) => b.id));
  return useQuery(() => ({
    key: [...keys.librarySpend, ids.value.join(",")],
    staleTime: Infinity,
    query: async () => {
      const list = ids.value;
      const all = await Promise.all(list.map((id) => readSpend(id)));
      return Object.fromEntries(list.map((id, i) => [id, all[i]]));
    },
  }));
}

/** A book's spending may have moved: whoever reads it, or has read it, reads it again. */
export function spendMoved(bookId: string): Promise<unknown> {
  return Promise.all([
    invalidate({ key: keys.spend(bookId) }),
    invalidate({ key: keys.librarySpend }),
  ]);
}
