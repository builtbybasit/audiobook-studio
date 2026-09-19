// Invalidate queries without a refetch's failure becoming an unhandled rejection.
//
// `invalidateQueries` refetches what it invalidated and rejects if any of those reads fails. That
// is right for a caller that wants to know, and wrong for the callers here: a book was renumbered
// or removed, and a query still open on a chapter number that no longer exists *should* fail —
// its page has already been told, through the query's own error state. Nothing else needs to hear
// about it.
import { useQueryCache, type UseQueryEntryFilter } from "@pinia/colada";

export async function invalidate(
  filters: UseQueryEntryFilter,
  refetch: boolean | "all" = true,
): Promise<void> {
  try {
    await useQueryCache().invalidateQueries(filters, refetch);
  } catch {
    // the failed read has said so to whoever is reading it
  }
}
