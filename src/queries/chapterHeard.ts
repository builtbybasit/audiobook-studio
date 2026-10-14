// What was heard of a chapter's clips: the check by ear's findings, by segment id. Changes only
// when a `check` job runs, which invalidates it (`queries/jobs.ts`), never refetched on focus.
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@pinia/colada";

import { keys } from "@/queries/keys";
import { libraryService } from "@/services/library";
import type { ChapterHeard } from "@/types";

const NONE: ChapterHeard = {};

export function useChapterHeard(
  bookId: MaybeRefOrGetter<string>,
  chapterId: MaybeRefOrGetter<number | null | undefined>,
) {
  const query = useQuery(() => ({
    key: keys.chapterHeard(toValue(bookId), toValue(chapterId) ?? 0),
    staleTime: Infinity,
    enabled: toValue(chapterId) != null,
    query: () => libraryService().chapterHeard(toValue(bookId), toValue(chapterId)!),
  }));
  /** the chapter's checked lines; empty before the read and for a chapter never checked */
  const lines = computed(() => query.data.value ?? NONE);
  return { ...query, lines };
}
