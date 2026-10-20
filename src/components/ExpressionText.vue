<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useNarrationStore } from "@/stores/narration";

import { computed } from "vue";
import { Pause as PauseIcon } from "@lucide/vue";

import SpokenText from "@/components/SpokenText.vue";
import { chipLook, chipText, piecesOf } from "@/lib/expressions";
import type { Segment } from "@/types";
const props = defineProps<{ bookId: string; segment: Segment }>();
const castStore = useCastStore();
const narrationStore = useNarrationStore();
const pacing = computed(() => castStore.pacingOf(props.bookId));
const plan = computed(() => narrationStore.expressionRender(props.bookId, props.segment));
const reasonIn = (list: { annotationId: number; reason: string }[], id: number) =>
  list.find((i) => i.annotationId === id)?.reason;
/** the line's words, with each tag as a chip drawn as the plan has it */
const pieces = computed(() =>
  piecesOf(
    props.segment.text,
    [...(props.segment.expressions ?? [])].sort((a, b) => a.annotationId - b.annotationId),
  ).map((p) => {
    if (!("tag" in p)) return p;
    const issue = reasonIn(plan.value.issues, p.tag.annotationId);
    const look = chipLook(
      p.tag,
      issue,
      reasonIn(plan.value.skipped, p.tag.annotationId),
      pacing.value,
    );
    return { ...p, look, text: chipText(p.tag, pacing.value), review: !!issue };
  }),
);
</script>
<template>
  <template v-for="(piece, i) in pieces" :key="i"
    ><span
      v-if="'tag' in piece"
      class="expression-chip"
      :class="piece.look.class"
      :data-tip="piece.look.title"
      ><PauseIcon
        v-if="piece.tag.kind === 'pause'"
        class="-mt-px inline size-3"
        aria-hidden="true"
      />{{ piece.text }}<span v-if="piece.review"> · review</span
      ><span v-if="piece.tag.omitted" class="sr-only"> · omitted</span></span
    ><SpokenText v-else :book-id="bookId" :text="piece.text"
  /></template>
</template>
