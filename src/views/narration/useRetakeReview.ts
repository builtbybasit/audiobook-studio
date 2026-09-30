// The book's retakes waiting for a verdict, as one queue the ledger walks through.
//
// A verdict removes its comparison and moves on to the next retake in the *book*, which can be in
// another chapter — so the queue is read across every chapter's script, and moving on goes through
// the URL (`?ch=`, `?filter=review`, `?seg=`), which is what NarrationView and the ledger already
// follow.
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { computed, nextTick, type Ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { ChapterProps } from "@/views/narration/shared";
import type { Segment } from "@/types";

/** A retake that rendered and can be heard beside the clip in the book. */
const waiting = (s: Segment): boolean =>
  !!s.candidate?.duration && !["queued", "generating"].includes(s.candidate.status);

export function useRetakeReview(props: ChapterProps, segments: Ref<Segment[]>) {
  const libraryStore = useLibraryStore();
  const narrationStore = useNarrationStore();
  const scriptsStore = useScriptsStore();
  const route = useRoute();
  const router = useRouter();

  /** this chapter's retakes waiting for a verdict */
  const reviewable = computed(() => segments.value.filter(waiting));
  /** every chapter's, in reading order */
  const bookReviewable = computed(() =>
    libraryStore.chaptersOf(props.bookId).flatMap((chapter) =>
      scriptsStore
        .segmentsOf(props.bookId, chapter.id)
        .filter(waiting)
        .map((segment) => ({ chId: chapter.id, segment })),
    ),
  );
  const indexOf = (s: Segment) =>
    bookReviewable.value.findIndex(
      (row) => row.chId === props.chapterId && row.segment.id === s.id,
    );
  /** where this line's retake sits in the book's queue, from 1; 0 when it is not in it */
  const reviewPosition = (s: Segment) => indexOf(s) + 1;

  function focusReview(id: number | undefined) {
    if (!id) return;
    void nextTick(() => {
      const row = document.getElementById(`row-${id}`);
      row?.focus();
      row?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  /** A verdict removes this comparison, so remember its neighbour before changing the store. */
  async function decideTake(s: Segment, keep: "current" | "new") {
    const reviews = bookReviewable.value;
    const at = indexOf(s);
    const nextReview = reviews[at + 1] ?? reviews[at - 1];
    if (keep === "new") narrationStore.acceptTake(props.bookId, props.chapterId, s.id);
    else narrationStore.rejectTake(props.bookId, props.chapterId, s.id);
    if (!nextReview) {
      await router.replace({ query: { ...route.query, seg: undefined } });
      return;
    }
    await router.replace({
      query: {
        ...route.query,
        ch: String(nextReview.chId),
        filter: "review",
        seg: String(nextReview.segment.id),
      },
    });
    if (nextReview.chId === props.chapterId) focusReview(nextReview.segment.id);
  }

  return { reviewable, bookReviewable, reviewPosition, decideTake, focusReview };
}
