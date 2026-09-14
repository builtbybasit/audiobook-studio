import { computed } from "vue";
import { useApp } from "../../stores/app";

export function useScript(props) {
  const app = useApp();
  const segments = computed(() => app.segmentsOf(props.bookId, props.chapterId));
  const cast = computed(() => app.charactersOf(props.bookId));
  const counts = computed(() => app.lineCounts(props.bookId, props.chapterId));
  const inChapter = computed(() => cast.value.filter((c) => counts.value[c.name]));
  const colorOf = (name) => cast.value.find((c) => c.name === name)?.color ?? "#71717a";
  return { app, segments, cast, counts, inChapter, colorOf };
}
export const TYPES = ["dialogue", "narration", "thought"];
export const TYPE_GLYPH = { dialogue: "“ ”", narration: "¶", thought: "…" };
