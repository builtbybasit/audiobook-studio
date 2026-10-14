// The chapter a stage (Scripting, Narration) has open, kept in `?ch=` so links open it, and
// remembered per book so it follows you between stages. Without `?ch=`: the last chapter, else the
// stage's own pick, written into the address once shown.
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
  // `?seg=` belongs to the chapter it came with, so opening another drops it; a link setting both
  // keeps its line
  const seg = useQueryParam("seg", textParam());
  const remembered = (): number => {
    const chapters = libraryStore.chaptersOf(bookId);
    return uiStore.chapterIn(bookId, chapters) || (first(chapters) ?? 1);
  };
  const opened = computed(() => ch.value ?? remembered());

  /** open a chapter from this page (the picker) */
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
