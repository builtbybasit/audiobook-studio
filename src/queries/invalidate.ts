// Invalidate without a failed refetch becoming an unhandled rejection: after a renumber or removal,
// a query on a chapter number that no longer exists should fail, and its page already shows that.
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
