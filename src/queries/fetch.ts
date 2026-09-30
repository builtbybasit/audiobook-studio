// Read one query now, whatever the cache holds of it.
//
// For a store that needs the server's answer rather than whatever a page last read: after a write
// the server refused, or for a chapter no page has open. `ensure` makes the entry when nothing is
// reading it or it has been collected — an invalidation only reaches entries that exist, so it
// would read nothing then — and `fetch` reads it afresh however fresh the entry thinks it is.
//
// `fetch` does not join a read already on its way: it aborts it and starts another, so the answer
// is always one asked for after the call. The aborted read still comes back, which is why every
// query function here installs what it read only while its signal has not been aborted — the
// later read is the one the store keeps, whichever lands first.
import { useQueryCache, type UseQueryOptions } from "@pinia/colada";

export async function fetchQuery<T>(options: UseQueryOptions<T, Error>): Promise<T> {
  const queryCache = useQueryCache();
  const { data } = await queryCache.fetch(queryCache.ensure(options));
  return data as T;
}
