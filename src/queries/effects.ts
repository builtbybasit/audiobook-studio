// The library's voice effects and its thought effect, read into the effects store; and how many
// of a book's clips have an old sound.
//
// The effects store is the working copy: an editor's slider moves it at once and the write goes
// behind (`effectsStore.update`). This query is how it is filled, and what a refused write reads
// back through. The entry is never collected, as the shelf's is not: the store keeps what it read
// regardless, and a collected entry is one an invalidation would not reach.
//
// The old-sound count is the server's — it compares each clip's `sound` with what its line's
// effects now make — so it stays in the query cache. Anything that changes a line's effects
// invalidates it (`staleMoved`): an effect edited or removed, the library's or a book's thought
// effect, a speaker's effect or thought effect, and a narration or Re-apply that ended
// (`@/queries/jobs`).
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

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

/**
 * What a book's lines' effects make has changed — or every book's, when none is named: whoever
 * shows the old-sound count reads it again, and an entry nobody shows is read afresh when it next is.
 */
export function staleMoved(bookId?: string): Promise<void> {
  return bookId
    ? invalidate({ key: keys.staleSound(bookId) })
    : invalidate({
        key: ["books"],
        predicate: (e) => e.key[2] === "effects" && e.key[3] === "stale",
      });
}
