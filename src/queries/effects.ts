// The library's effects and thought effect, read into the effects store; and each book's old-sound
// count, which the server computes and `staleMoved` invalidates whenever a line's effects change.
// The effects entry is never collected: a collected entry is one an invalidation would not reach.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { toCacheKey, useQuery } from "@pinia/colada";

import type { Effect, StaleSound, ThoughtChoice } from "@/types";
import { fetchQuery } from "@/queries/fetch";
import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { effectsService } from "@/services/effects";
import { useEffectsStore } from "@/stores/effects";

interface EffectsRead {
  effects: Effect[];
  thoughts: ThoughtChoice;
}

async function readEffects(signal: AbortSignal): Promise<EffectsRead> {
  const [effects, thoughts] = await Promise.all([
    effectsService().list(),
    effectsService().libraryThoughts(),
  ]);
  // a read overtaken by a later one leaves the store to the later one
  if (!signal.aborted) useEffectsStore()._install(effects, thoughts);
  return { effects, thoughts };
}

const effectsQuery = {
  key: keys.effects,
  staleTime: Infinity,
  gcTime: false as const,
  query: ({ signal }: { signal: AbortSignal }) => readEffects(signal),
};

/** The effects and the library's thought effect read now and installed, after a refused write. */
export function fetchEffects(): Promise<EffectsRead> {
  return fetchQuery(effectsQuery);
}

/** The library's effects in list order, and its thought effect, as the effects store holds them. */
export function useEffects() {
  const effectsStore = useEffectsStore();
  const query = useQuery(effectsQuery);
  return {
    ...query,
    effects: computed(() => effectsStore.effects),
    libraryThoughts: computed(() => effectsStore.libraryThoughts),
  };
}

/** How many of a book's clips have an old sound; `stale` is null until the first read lands. */
export function useStaleSound(bookId: MaybeRefOrGetter<string | null | undefined>) {
  const query = useQuery(() => ({
    key: keys.staleSound(toValue(bookId) ?? ""),
    staleTime: Infinity,
    enabled: !!toValue(bookId),
    query: (): Promise<StaleSound> => effectsService().stale(toValue(bookId)!),
  }));
  return { ...query, stale: computed(() => query.data.value ?? null) };
}

/** A book's (or with none, every book's) effects changed: reread the old-sound counts. */
export function staleMoved(bookId?: string): Promise<void> {
  return bookId
    ? invalidate({ key: keys.staleSound(bookId) })
    : invalidate({
        key: ["books"],
        // a book's own count is its id put into `keys.staleSound`, where every book key keeps it
        predicate: (e) =>
          typeof e.key[1] === "string" &&
          toCacheKey(e.key) === toCacheKey(keys.staleSound(e.key[1])),
      });
}
