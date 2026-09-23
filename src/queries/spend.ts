// What a book has spent and what its unfinished work holds, read into the jobs store.
//
// With a server answering, spending is the server's: every request a job sends is priced and
// appended to its ledger, and every run it queued holds a reservation there. Each read is installed
// into the jobs store (`_installSpend`), whose `spent` / `reserved` / `scriptSpent` /
// `scriptReserved` then answer with it — so the book's budget panel, the Endpoints page's budget
// table, the wait reasons and the run estimates all read the one figure. In the demo the jobs store
// sums the session's own ledger and these queries have nothing to read.
//
// Spending moves when a job does, so the queue's poll invalidates a book's spend on every move of
// one of its jobs (`spendMoved`), the same way it reads a chapter's script again as clips land; a
// budget write invalidates it too. Only what a page is showing is read again at once — a poll tick
// would otherwise re-read every book the Endpoints page ever totalled — and the rest is marked
// stale, so the next page to ask reads it afresh, as it does an entry already collected.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import type { BookSpend } from "@/types";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { activeUsageService } from "@/services/usage";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";

async function readSpend(bookId: string): Promise<BookSpend | null> {
  const svc = activeUsageService();
  if (!svc) return null;
  const spend = await svc.bookSpend(bookId);
  useJobsStore()._installSpend(bookId, spend);
  return spend;
}

/** One book's spending, kept in the jobs store while a page shows it. */
export function useBookSpend(bookId: MaybeRefOrGetter<string | null | undefined>) {
  const jobsStore = useJobsStore();
  const query = useQuery(() => ({
    key: keys.spend(toValue(bookId) ?? ""),
    enabled: !!toValue(bookId) && !!activeUsageService(),
    staleTime: Infinity,
    query: () => readSpend(toValue(bookId)!),
  }));
  return {
    ...query,
    /** the server's figures; null in the demo, and until the first read lands */
    spend: computed(() => {
      const id = toValue(bookId);
      return id ? (jobsStore.spend[id] ?? null) : null;
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
    enabled: !!activeUsageService(),
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
