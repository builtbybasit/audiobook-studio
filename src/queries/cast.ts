// A book's cast and pronunciation dictionary, read into the cast store.
//
// The cast store owns both and every change to them; this is how they arrive with a server
// answering, and what a scripting job landing invalidates, since a run absorbs the speakers it
// turned up into the cast on the server.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import { keys } from "@/queries/keys";
import { activeLibraryService, type Cast } from "@/services/library";
import { useCastStore } from "@/stores/cast";

async function readCast(bookId: string): Promise<Cast> {
  const castStore = useCastStore();
  const svc = activeLibraryService();
  if (!svc)
    return { characters: castStore.charactersOf(bookId), lexicon: castStore.lexiconOf(bookId) };
  const cast = await svc.cast(bookId);
  castStore._install(bookId, cast);
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
