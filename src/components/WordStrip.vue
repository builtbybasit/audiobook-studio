<script setup lang="ts">
// A line as a strip of words with visible, clickable gaps: the one control for both cutting a
// segment and placing an expression. Keyboard: ← → walk the gaps, Enter picks, Escape cancels.
import { computed, ref, watch } from "vue";
import { Pause as PauseIcon } from "@lucide/vue";
import { chipLook, chipText } from "@/lib/expressions";
import { gapLabel, gapsOf, tokensOf } from "@/lib/gaps";
import { DEFAULT_PACING } from "@/lib/speech";
import type { ExpressionAnnotation, Pacing } from "@/types";

const props = withDefaults(
  defineProps<{
    text: string;
    /** "split": gaps inside the line only; "place": the two edges as well */
    mode: "split" | "place";
    /** without gaps the strip is just the line and its chips */
    gaps?: boolean;
    expressions?: ExpressionAnnotation[];
    issueOf?: (id: number) => string | undefined;
    /** why a scripted tag is left out for this voice: drawn dimmed, never as an issue */
    skippedOf?: (id: number) => string | undefined;
    /** drawn hollow, since its place is being chosen */
    movingId?: number | null;
    quote?: "dialogue" | "thought" | "";
    /** for the gap's label */
    verb?: string;
    /** for a pause chip's length */
    pacing?: Pacing;
  }>(),
  {
    gaps: true,
    expressions: () => [],
    issueOf: () => undefined,
    skippedOf: () => undefined,
    movingId: null,
    quote: "",
    verb: "",
    pacing: () => DEFAULT_PACING,
  },
);
const emit = defineEmits<{
  pick: [at: number, el: HTMLElement];
  hover: [at: number | null];
  chip: [id: number, el: HTMLElement];
  cancel: [];
}>();

type Piece =
  | { kind: "gap"; at: number; strong: boolean; edge?: "start" | "end" }
  | { kind: "word"; text: string }
  | { kind: "chip"; a: ExpressionAnnotation; look: ReturnType<typeof chipLook>; review: boolean };

const gapList = computed(() => gapsOf(props.text, props.mode));
/** Words, gaps and chips in reading order; a chip sits before the gap it is anchored at. */
const pieces = computed<Piece[]>(() => {
  const out: Piece[] = [];
  const chips = [...props.expressions].sort(
    (a, b) => a.at - b.at || a.annotationId - b.annotationId,
  );
  let c = 0;
  const flushChips = (upTo: number) => {
    for (; c < chips.length && chips[c].at <= upTo; c++) {
      const a = chips[c];
      const issue = props.issueOf(a.annotationId);
      const look = chipLook(a, issue, props.skippedOf(a.annotationId), props.pacing);
      out.push({ kind: "chip", a, look, review: !!issue });
    }
  };
  const tokens = tokensOf(props.text);
  const gapAt = new Map(gapList.value.map((g) => [g.at, g]));
  tokens.forEach((t, i) => {
    flushChips(t.at);
    const g = gapAt.get(t.at);
    if (g && (i > 0 || g.edge)) out.push({ kind: "gap", ...g });
    out.push({ kind: "word", text: t.text });
  });
  flushChips(Infinity);
  const end = gapAt.get(props.text.length);
  if (end?.edge === "end") out.push({ kind: "gap", ...end });
  return out;
});

const active = ref<number | null>(null);
watch(
  () => props.gaps,
  (on) => {
    if (!on) active.value = null;
  },
);
const root = ref<HTMLElement | null>(null);
const gapEl = (at: number) =>
  root.value?.querySelector<HTMLElement>(`[data-gap="${at}"]`) ?? root.value!;
function onKey(e: KeyboardEvent) {
  if (!props.gaps) return;
  const ats = gapList.value.map((g) => g.at);
  if (!ats.length) return;
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    e.preventDefault();
    const i = active.value == null ? -1 : ats.indexOf(active.value);
    const next =
      e.key === "ArrowRight"
        ? ats[Math.min(ats.length - 1, i + 1)]
        : ats[Math.max(0, i < 0 ? 0 : i - 1)];
    active.value = next;
    emit("hover", next);
  } else if (e.key === "Enter" && active.value != null) {
    e.preventDefault();
    emit("pick", active.value, gapEl(active.value));
  } else if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
  }
}
const label = (at: number) =>
  `${props.verb || (props.mode === "split" ? "cut" : "place")} ${gapLabel(props.text, at)}`;
</script>

<template>
  <span
    ref="root"
    class="word-strip"
    :class="gaps && 'word-strip-live'"
    :tabindex="gaps ? 0 : -1"
    :role="gaps ? 'group' : undefined"
    :aria-label="
      gaps
        ? `${verb || (mode === 'split' ? 'Cut' : 'Place')} at a gap between words: left and right move, Enter picks`
        : undefined
    "
    @keydown="onKey"
    @mouseleave="emit('hover', null)"
    @blur="emit('hover', null)"
    ><template v-if="quote === 'dialogue'">‘</template
    ><template v-for="(p, i) in pieces" :key="i"
      ><button
        v-if="p.kind === 'gap'"
        v-show="gaps"
        type="button"
        tabindex="-1"
        class="split-gap"
        :class="[
          p.strong && 'split-gap-strong',
          active === p.at && 'split-gap-active',
          p.edge && 'split-gap-edge',
        ]"
        :data-gap="p.at"
        :aria-label="label(p.at)"
        :title="label(p.at)"
        @mouseenter="emit('hover', p.at)"
        @click.stop="emit('pick', p.at, $event.currentTarget as HTMLElement)"
      >
        <span class="split-gap-tick"></span></button
      ><button
        v-else-if="p.kind === 'chip'"
        type="button"
        class="expression-chip"
        :class="p.a.annotationId === movingId ? 'expression-chip-moving' : p.look.class"
        :title="p.look.title"
        @click.stop="emit('chip', p.a.annotationId, $event.currentTarget as HTMLElement)"
      >
        <PauseIcon v-if="p.a.kind === 'pause'" class="-mt-px inline size-3" aria-hidden="true" />{{
          chipText(p.a, pacing)
        }}<span v-if="p.review"> · review</span></button
      ><template v-else>{{ p.text }}</template></template
    ><template v-if="quote === 'dialogue'">’</template></span
  >
</template>
