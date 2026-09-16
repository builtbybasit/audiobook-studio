<script setup lang="ts">
// A line as a strip of words with the gaps between them made visible and clickable. It is the
// one control the editor uses both to cut a segment in two and to place an expression, so the
// two learn the same gesture. The gaps show from the start — light ticks, darker where a sentence
// ends — never only on hover. Expression chips sit inline where they fall and, when asked, open.
//
// Keyboard: the strip takes focus as a whole; ← → walk the gaps, Enter picks, Escape cancels.
import { computed, ref, watch } from "vue";
import { gapLabel, gapsOf, tokensOf } from "@/lib/gaps";
import type { ExpressionAnnotation } from "@/types";

const props = withDefaults(
  defineProps<{
    text: string;
    /** "split": gaps inside the line only; "place": the two edges as well */
    mode: "split" | "place";
    /** whether the gaps are offered at all — without them the strip is just the line and its chips */
    gaps?: boolean;
    expressions?: ExpressionAnnotation[];
    issueOf?: (id: number) => string | undefined;
    /** the chip that is being moved: drawn hollow, since its place is what is being chosen */
    movingId?: number | null;
    quote?: "dialogue" | "thought" | "";
    /** what a gap does, for its label: "cut" or "place" */
    verb?: string;
  }>(),
  {
    gaps: true,
    expressions: () => [],
    issueOf: () => undefined,
    movingId: null,
    quote: "",
    verb: "",
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
  | { kind: "chip"; a: ExpressionAnnotation };

const gapList = computed(() => gapsOf(props.text, props.mode));
/** Words, gaps and chips in reading order. A chip sits before the gap it is anchored at. */
const pieces = computed<Piece[]>(() => {
  const out: Piece[] = [];
  const chips = [...props.expressions].sort(
    (a, b) => a.at - b.at || a.annotationId - b.annotationId,
  );
  let c = 0;
  const flushChips = (upTo: number) => {
    while (c < chips.length && chips[c].at <= upTo) out.push({ kind: "chip", a: chips[c++] });
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

// roving focus over the gaps, for the keyboard
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
        :class="[
          p.a.annotationId === movingId
            ? 'expression-chip-moving'
            : p.a.omitted
              ? 'expression-chip-omitted'
              : issueOf(p.a.annotationId)
                ? 'expression-chip-issue'
                : '',
        ]"
        :title="
          p.a.omitted
            ? `${p.a.label} — omitted from narration`
            : (issueOf(p.a.annotationId) ?? `${p.a.label} · ${p.a.token}`)
        "
        @click.stop="emit('chip', p.a.annotationId, $event.currentTarget as HTMLElement)"
      >
        {{ p.a.label }}<span v-if="issueOf(p.a.annotationId)"> · review</span></button
      ><template v-else>{{ p.text }}</template></template
    ><template v-if="quote === 'dialogue'">’</template></span
  >
</template>
