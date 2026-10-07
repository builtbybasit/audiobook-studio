// A book's cast and pronunciation dictionary, read into the cast store.
//
// The cast store owns both and every change to them; this is how they arrive from the server, and
// what a scripting job landing invalidates, since a run absorbs the speakers it
// turned up into the cast on the server.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import { fetchQuery } from "@/queries/fetch";
import { keys } from "@/queries/keys";
import { libraryService, type Cast } from "@/services/library";
import { useCastStore } from "@/stores/cast";

async function readCast(bookId: string, signal: AbortSignal): Promise<Cast> {
  const castStore = useCastStore();
  // where the book's writes were as it was asked for: one answered under it may not be in it
  const readAt = castStore._readAt(bookId);
  const cast = await libraryService().cast(bookId);
  // a read overtaken by a later one leaves the store to the later one
  if (!signal.aborted) castStore._install(bookId, cast, readAt);
  return cast;
}

const castQuery = (bookId: string) => ({
  key: keys.cast(bookId),
  staleTime: Infinity,
  query: ({ signal }: { signal: AbortSignal }) => readCast(bookId, signal),
});

/**
 * A book's cast read from the server now and installed, whether or not a page shows it — after a
 * change the server refused, or for a page that has no book open.
 */
export function fetchCast(bookId: string): Promise<Cast> {
  return fetchQuery(castQuery(bookId));
}

export function useCast(bookId: MaybeRefOrGetter<string>) {
  const castStore = useCastStore();
  const query = useQuery(() => castQuery(toValue(bookId)));
  return {
    ...query,
    characters: computed(() => castStore.charactersOf(toValue(bookId))),
    lexicon: computed(() => castStore.lexiconOf(toValue(bookId))),
  };
}
