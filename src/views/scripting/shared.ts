import { useCastStore } from "@/stores/cast";
import { useScriptsStore } from "@/stores/scripts";
import { computed } from "vue";
import type { ComputedRef } from "vue";

import type { Character, SegmentType } from "@/types";

export interface ChapterProps {
  bookId: string;
  chapterId: number;
}

export function useScript(props: ChapterProps) {
  const castStore = useCastStore();
  const scriptsStore = useScriptsStore();
  const segments = computed(() => scriptsStore.segmentsOf(props.bookId, props.chapterId));
  const cast = computed(() => castStore.charactersOf(props.bookId));
  const counts = computed(() => scriptsStore.lineCounts(props.bookId, props.chapterId));
  const inChapter: ComputedRef<Character[]> = computed(() =>
    cast.value.filter((c) => counts.value[c.name]),
  );
  const colorOf = (name: string): string =>
    cast.value.find((c) => c.name === name)?.color ?? "#71717a";
  return { segments, cast, counts, inChapter, colorOf };
}
export const TYPES: SegmentType[] = ["dialogue", "narration", "thought"];
export const TYPE_GLYPH: Record<SegmentType, string> = {
  dialogue: "“ ”",
  narration: "¶",
  thought: "…",
};
