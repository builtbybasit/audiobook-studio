// Each speaker's spoken lines across a book, counted by the server, so no page loads every script
// to count them. `countsMoved` rereads them after a write moves lines between speakers.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import { invalidate } from "@/queries/invalidate";
import { keys } from "@/queries/keys";
import { libraryService } from "@/services/library";

export function useSpeakerCounts(bookId: MaybeRefOrGetter<string>) {
  const query = useQuery(() => ({
    key: keys.speakerCounts(toValue(bookId)),
    enabled: !!toValue(bookId),
    query: () => libraryService().speakerCounts(toValue(bookId)),
  }));
  return { ...query, counted: computed(() => !!query.data.value) };
}

interface Waiting {
  timer: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolve: () => void;
}
const waiting = new Map<string, Waiting>();

/**
 * A book's lines changed speaker, or which of them are spoken. Calls within 300 ms share one
 * reread, so a bulk edit landing chapter by chapter counts once at the end.
 */
export function countsMoved(bookId: string): Promise<void> {
  let w = waiting.get(bookId);
  if (w) clearTimeout(w.timer);
  else {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    w = { timer: 0 as unknown as Waiting["timer"], done, resolve };
    waiting.set(bookId, w);
  }
  const { resolve } = w;
  w.timer = setTimeout(() => {
    waiting.delete(bookId);
    void invalidate({ key: keys.speakerCounts(bookId) }).then(resolve);
  }, 300);
  return w.done;
}

/** The reread `countsMoved` has scheduled, if any; resolves at once when none is. */
export const countsSettled = (bookId: string): Promise<void> =>
  waiting.get(bookId)?.done ?? Promise.resolve();
