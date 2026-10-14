// The prose of several chapters at once, for pages that price or cut chapters they do not show.
// An unread chapter would otherwise count as no text and pass every budget check, so the page reads
// what it selects and the store asks `chapterTextRead`, which tells unread from empty.
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useQuery, useQueryCache } from "@pinia/colada";

import { partsText, type ContentPart } from "@/lib/contents";
import { textQuery } from "@/queries/chapterText";
import { keys } from "@/queries/keys";
import { libraryService, type TextFormat } from "@/services/library";

/**
 * Read every chapter in `chapterIds` as the list changes, once each: prose does not change under
 * the app, and a renumbering invalidates everything under the book.
 */
export function useChapterTexts(
  bookId: MaybeRefOrGetter<string>,
  chapterIds: MaybeRefOrGetter<readonly number[]>,
  format: TextFormat,
) {
  const queryCache = useQueryCache();
  watch(
    () => [...toValue(chapterIds)],
    (ids) => {
      for (const id of ids)
        // a failed read stays in its entry's error state and is retried when next asked for
        void queryCache
          .refresh(queryCache.ensure(textQuery(toValue(bookId), id, format)))
          .catch(() => {});
    },
    { immediate: true },
  );
  return {
    /** how many of the chapters have not been read yet */
    unread: computed(
      () =>
        toValue(chapterIds).filter((id) => chapterTextRead(toValue(bookId), id, format) == null)
          .length,
    ),
  };
}

/** Read these chapters' prose; resolves once all are in. A failed one stays unread. */
export async function loadChapterTexts(
  bookId: string,
  chapterIds: readonly number[],
  format: TextFormat,
): Promise<void> {
  const queryCache = useQueryCache();
  await Promise.all(
    chapterIds.map((id) =>
      queryCache.refresh(queryCache.ensure(textQuery(bookId, id, format))).catch(() => {}),
    ),
  );
}

/**
 * A chapter's cached prose, or null when unread (`chapterTextNow` cannot tell that from empty).
 * Reactive: a getter that asks before the read lands asks again when it does.
 */
export function chapterTextRead(
  bookId: string,
  chapterId: number,
  format: TextFormat,
): string | null {
  const cached = useQueryCache().getQueryData<ContentPart[]>(
    keys.chapterText(bookId, chapterId, format),
  );
  if (!cached) return null;
  let text = joined.get(cached);
  if (text === undefined) joined.set(cached, (text = partsText(cached)));
  return text;
}

/**
 * Each read's prose, joined once: getters over hundreds of chapters rerun per landed read, and the
 * stable string lets the scripting store compare by reference. Weakly keyed by the cached parts.
 */
const joined = new WeakMap<ContentPart[], string>();

/**
 * For each of `names`, the ids of chapters whose text names it as written, in book order; empty
 * until the read lands. Read once per set of names.
 */
export function useMentions(
  bookId: MaybeRefOrGetter<string>,
  names: MaybeRefOrGetter<readonly string[]>,
) {
  const query = useQuery(() => ({
    key: keys.mentions(toValue(bookId), toValue(names)),
    staleTime: Infinity,
    enabled: toValue(names).length > 0,
    query: () => libraryService().mentions(toValue(bookId), toValue(names)),
  }));
  return {
    ...query,
    byName: computed((): Record<string, number[]> => query.data.value ?? {}),
  };
}
