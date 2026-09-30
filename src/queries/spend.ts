// What a book has spent and what its unfinished work holds.
//
// Spending is the server's: every request a job sends is priced and appended to its ledger, and
// every run it queued holds a reservation there. Nothing edits it in the browser, so the reads stay
// in the query cache, and the jobs store's `spent` / `reserved` / `scriptSpent` / `scriptReserved`
// answer from them (`spendOf`) — so the book's budget panel, the Endpoints page's budget table, the
// wait reasons and the run estimates all read the one figure.
//
// Spending moves when a job does, so the queue's poll invalidates a book's spend on every move of
// one of its jobs (`spendMoved`), the same way it reads a chapter's script again as clips land; a
// budget write invalidates it too. Only what a page is showing is read again at once — a poll tick
// would otherwise re-read every book the Endpoints page ever totalled — and the rest is marked
// stale, so the next page to ask reads it afresh, as it does an entry already collected.
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

/**
 * A book's spending read now, whether or not a page shows it — for a run started from a page that
 * has another book open, whose budget still has to be checked against what it has spent.
 */
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
  // the shelf is in the key, so a book added or removed is a read of its own; invalidating
  // `keys.librarySpend` still reaches every such entry, since a key matches by prefix
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
