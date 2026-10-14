// Read one query now, whatever the cache holds: for a store that needs the server's answer.
// `ensure` makes the entry if missing or collected (invalidation would reach nothing), and `fetch`
// aborts any read in flight and starts another; query functions install only when not aborted.
import { useQueryCache, type UseQueryOptions } from "@pinia/colada";

export async function fetchQuery<T>(options: UseQueryOptions<T, Error>): Promise<T> {
  const queryCache = useQueryCache();
  const { data } = await queryCache.fetch(queryCache.ensure(options));
  return data as T;
}
