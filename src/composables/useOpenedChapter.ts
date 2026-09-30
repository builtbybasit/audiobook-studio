// The chapter a stage (Scripting, Narration) has open.
//
// It is kept in the URL as `?ch=`, so a link — the command palette's, a review moving on to the
// next retake in another chapter — opens the chapter it names, and it is remembered per book, so
// the chapter follows you between stages. With no `?ch=` the page opens the chapter it was last on,
// else the stage's own first choice, and writes that into the address once it is on screen.
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";
import { computed, onMounted, watch } from "vue";

import { idParam, textParam, useQueryParam } from "@/composables/useQueryParam";
import type { Chapter } from "@/types";

export function useOpenedChapter(
  bookId: string,
  /** the stage's pick when this book has no chapter open yet */
  first: (chapters: Chapter[]) => number | undefined,
) {
  const libraryStore = useLibraryStore();
  const uiStore = useUiStore();
  const ch = useQueryParam("ch", idParam());
  // `?seg=` names a line in the chapter it came with, so opening another one here drops it; a link
  // that sets both keeps its line
  const seg = useQueryParam("seg", textParam());
  const remembered = (): number => {
    const chapters = libraryStore.chaptersOf(bookId);
    return uiStore.chapterIn(bookId, chapters) || (first(chapters) ?? 1);
  };
  const opened = computed(() => ch.value ?? remembered());

  /** open a chapter from this page — the picker */
  function open(id: number): void {
    if (id === opened.value) return;
    ch.value = id;
    seg.value = "";
  }

  watch(opened, (id) => uiStore.openChapter(bookId, id));
  onMounted(() => {
    uiStore.openChapter(bookId, opened.value);
    if (ch.value != null) return;
    ch.value = opened.value;
    seg.value = "";
  });
  return { opened, open };
}
