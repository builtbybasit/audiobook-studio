// A book's cast and dictionary, read into the cast store. A scripting job landing invalidates it,
// since the run adds speakers on the server.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import { fetchQuery } from "@/queries/fetch";
import { keys } from "@/queries/keys";
import { libraryService, type Cast } from "@/services/library";
import { useCastStore } from "@/stores/cast";

async function readCast(bookId: string, signal: AbortSignal): Promise<Cast> {
  const castStore = useCastStore();
  // where the book's writes were when asked: one answered after may not be in this read
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

/** Read a book's cast now and install it, shown or not (after a refusal, or with no book open). */
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
