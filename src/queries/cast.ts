// A book's cast and pronunciation dictionary, read into the cast store.
//
// The cast store owns both and every change to them; this is how they arrive from the server, and
// what a scripting job landing invalidates, since a run absorbs the speakers it
// turned up into the cast on the server.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import { keys } from "@/queries/keys";
import { libraryService, type Cast } from "@/services/library";
import { useCastStore } from "@/stores/cast";

async function readCast(bookId: string): Promise<Cast> {
  const cast = await libraryService().cast(bookId);
  useCastStore()._install(bookId, cast);
  return cast;
}

export function useCast(bookId: MaybeRefOrGetter<string>) {
  const castStore = useCastStore();
  const query = useQuery(() => ({
    key: keys.cast(toValue(bookId)),
    staleTime: Infinity,
    query: () => readCast(toValue(bookId)),
  }));
  return {
    ...query,
    characters: computed(() => castStore.charactersOf(toValue(bookId))),
    lexicon: computed(() => castStore.lexiconOf(toValue(bookId))),
  };
}
