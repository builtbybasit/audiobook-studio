// Editing one line in place: split/join, its words, and the pause after it. Shared by the reader's
// keys and the editor under the line via provide/inject instead of a dozen props and events.
import { computed, inject, nextTick, provide, ref, type InjectionKey, type Ref } from "vue";
import { defaultPause, pauseAfter } from "@/lib/speech";
import { useCastStore } from "@/stores/cast";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import type { ChapterProps } from "@/views/scripting/shared";
import type { Segment } from "@/types";

export const preview = (t: string, n = 42) => (t.length > n ? t.slice(0, n) + "…" : t);

function segmentEditing(
  props: ChapterProps,
  /** the line whose editor is open, and the line the keys act on */
  { open, focus }: { open: Ref<number | null>; focus: Ref<number | null> },
) {
  const castStore = useCastStore();
  const scriptsStore = useScriptsStore();
  const uiStore = useUiStore();
  const segments = computed(() => scriptsStore.segmentsOf(props.bookId, props.chapterId));

  // ---- split at a word gap, join with a neighbour
  const splitting = ref<number | null>(null);
  /** the gap under the pointer while splitting, for the two-halves preview */
  const cutAt = ref<number | null>(null);
  const joinPreview = ref<"prev" | "next" | null>(null);
  const at = (id: number) => segments.value.findIndex((x) => x.id === id);
  const nextOf = (s: Segment): Segment | undefined => segments.value[at(s.id) + 1];
  const prevOf = (s: Segment): Segment | undefined => segments.value[at(s.id) - 1];
  /** keeps the separator the split kept */
  function mergedText(s: Segment, dir: "next" | "prev"): string {
    const first = dir === "next" ? s : prevOf(s);
    const second = first && nextOf(first);
    if (!first || !second) return "";
    const text = `${first.text.trimEnd()}${first.sep ?? " "}${second.text.trimStart()}`;
    return text.length > 180
      ? `${text.slice(0, 100).trimEnd()} … ${text.slice(-70).trimStart()}`
      : text;
  }
  function doSplit(s: Segment, offset: number) {
    const id = scriptsStore.splitSegment(props.bookId, props.chapterId, s.id, offset);
    splitting.value = null;
    cutAt.value = null;
    if (id == null) return;
    // the second half usually needs a different speaker
    open.value = id;
    focus.value = id;
    void nextTick(() =>
      document.getElementById("seg-" + id)?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }
  function doJoin(s: Segment, dir: "next" | "prev") {
    const first = dir === "next" ? s : prevOf(s);
    if (!first || !nextOf(first)) return;
    if (scriptsStore.joinSegments(props.bookId, props.chapterId, first.id)) {
      open.value = first.id;
      focus.value = first.id;
    }
  }

  // ---- the words themselves (Contents sends author's notes here to be trimmed)
  const editingText = ref<number | null>(null);
  const textDraft = ref("");
  function startTextEdit(s: Segment) {
    open.value = s.id;
    focus.value = s.id;
    editingText.value = s.id;
    textDraft.value = s.text;
    void nextTick(() => document.getElementById(`seg-text-${s.id}`)?.focus());
  }
  /** The store remaps expressions; the clip goes stale, so this is undoable. */
  function commitText(s: Segment) {
    const text = textDraft.value.trim();
    editingText.value = null;
    if (!text || text === s.text) return;
    const before = preview(s.text, 60);
    const revert = scriptsStore._editSnapshot(props.bookId, props.chapterId);
    scriptsStore.updateSegment(props.bookId, props.chapterId, s.id, { text });
    uiStore.toast(`#${s.id} rewritten`, { description: `Was “${before}”`, undo: revert });
  }
  function dropSegment(s: Segment) {
    if (scriptsStore.deleteSegment(props.bookId, props.chapterId, s.id)) {
      if (open.value === s.id) open.value = null;
      if (focus.value === s.id) focus.value = null;
      editingText.value = null;
    }
  }
  function close() {
    open.value = null;
    splitting.value = null;
    cutAt.value = null;
  }

  // ---- pacing: silence is stitched, not rendered, so a pause never makes a clip stale.
  const pacing = computed(() => castStore.pacingOf(props.bookId));
  const gapOf = (s: Segment) => pauseAfter(s, nextOf(s), pacing.value);
  const bookGap = (s: Segment) => defaultPause(s, nextOf(s), pacing.value);
  const setPause = (s: Segment, v: number | null) =>
    castStore.setPause(props.bookId, props.chapterId, s.id, v);

  return {
    open,
    focus,
    splitting,
    cutAt,
    joinPreview,
    nextOf,
    prevOf,
    mergedText,
    doSplit,
    doJoin,
    editingText,
    textDraft,
    startTextEdit,
    commitText,
    dropSegment,
    close,
    gapOf,
    bookGap,
    setPause,
  };
}

export type SegmentEditing = ReturnType<typeof segmentEditing>;
const KEY: InjectionKey<SegmentEditing> = Symbol("segment editing");

export function provideSegmentEditing(
  props: ChapterProps,
  lines: { open: Ref<number | null>; focus: Ref<number | null> },
): SegmentEditing {
  const editing = segmentEditing(props, lines);
  provide(KEY, editing);
  return editing;
}

export function useSegmentEditing(): SegmentEditing {
  const editing = inject(KEY);
  if (!editing) throw new Error("A segment editor is only ever used inside the script reader");
  return editing;
}
