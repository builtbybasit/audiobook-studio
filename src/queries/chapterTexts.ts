// The prose of several chapters at once, for a page that prices or cuts chapters it does not show.
//
// The Scripting page's plan and estimate count each selected chapter's plain text, cut the way
// the chosen endpoint cuts it. A chapter no query has read would otherwise count as no text at all
// — no requests, nothing to pay — and a run over it would pass every budget check. So the page
// reads what it selects, and the store asks `chapterTextRead`, which tells a chapter not read yet
// from one that is empty.
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useQueryCache } from "@pinia/colada";

import { partsText, type ContentPart } from "@/lib/contents";
import { textQuery } from "@/queries/chapterText";
import { keys } from "@/queries/keys";
import type { TextFormat } from "@/services/library";

/**
 * Read every chapter in `chapterIds` as the list changes. A chapter already read is not read again:
 * prose does not change under the app, and a renumbering invalidates everything under the book.
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
        // a read that fails stays in its entry's error state, and is read again when next asked for
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

/**
 * Read these chapters' prose, and resolve once every one is in — for an action that is about to
 * price them. A chapter that could not be read is left unread, and the caller's check says so.
 */
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
 * A chapter's prose as the query cache holds it, or null when nothing has read it yet — unlike
 * `chapterTextNow`, which cannot tell that from an empty chapter. Reactive: a getter that asks
 * before the read lands asks again when it does.
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
 * Each read's prose, joined once. A getter over hundreds of chapters runs again each time one more
 * lands, and would otherwise join every chapter's text anew; the same string each time also lets
 * the scripting store tell that a chapter's text has not changed without comparing it. Keyed by
 * what the cache holds, so a read the cache lets go of is let go of here too.
 */
const joined = new WeakMap<ContentPart[], string>();
