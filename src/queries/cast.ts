// A book's cast and dictionary, read into the cast store, and a speaker's facts. A scripting,
// facts or profiles job landing invalidates both, since the run changes them on the server.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";

import { fetchQuery } from "@/queries/fetch";
import { keys } from "@/queries/keys";
import { libraryService, type Cast } from "@/services/library";
import { useCastStore } from "@/stores/cast";
import { toastFailure } from "@/stores/toastFailure";
import type { CastFact } from "@/types";

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

/** A speaker's facts, read only while `enabled` (behind the record's spoiler button). */
export function useFacts(
  bookId: MaybeRefOrGetter<string>,
  name: MaybeRefOrGetter<string>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  return useQuery(() => ({
    key: keys.facts(toValue(bookId), toValue(name)),
    query: () => libraryService().facts(toValue(bookId), toValue(name)),
    enabled: toValue(enabled),
  }));
}

/** Take a fact off a speaker; the list shown becomes what the server kept. */
export async function deleteFact(bookId: string, name: string, id: number): Promise<void> {
  try {
    const facts = await libraryService().deleteFact(bookId, id);
    useQueryCache().setQueryData<CastFact[]>(keys.facts(bookId, name), facts);
  } catch (cause) {
    toastFailure("remove this fact", cause);
  }
}
