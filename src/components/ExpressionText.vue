<script setup lang="ts">
import { useNarrationStore } from "@/stores/narration";

import { computed } from "vue";

import SpokenText from "@/components/SpokenText.vue";
import type { Segment, ExpressionAnnotation } from "@/types";
const props = defineProps<{ bookId: string; segment: Segment }>();
const narrationStore = useNarrationStore();
const plan = computed(() => narrationStore.expressionRender(props.bookId, props.segment));
const pieces = computed(() => {
  const out: { text?: string; annotation?: ExpressionAnnotation }[] = [];
  let at = 0;
  for (const a of [...(props.segment.expressions ?? [])].sort(
    (a, b) => a.at - b.at || a.annotationId - b.annotationId,
  )) {
    const pos = Math.max(at, Math.min(a.at, props.segment.text.length));
    if (pos > at) out.push({ text: props.segment.text.slice(at, pos) });
    out.push({ annotation: a });
    at = pos;
  }
  out.push({ text: props.segment.text.slice(at) });
  return out;
});
const issue = (id: number) => plan.value.issues.find((i) => i.annotationId === id);
</script>
<template>
  <template v-for="(piece, i) in pieces" :key="i"
    ><span
      v-if="piece.annotation"
      class="mx-1 inline-block rounded border px-1.5 py-0.5 align-baseline font-sans text-[11px] not-italic leading-normal"
      :class="
        piece.annotation.omitted
          ? 'border-zinc-200 text-zinc-400 line-through dark:border-zinc-700'
          : issue(piece.annotation.annotationId)
            ? 'border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
            : 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300'
      "
      :title="
        piece.annotation.omitted
          ? 'Omitted from narration'
          : (issue(piece.annotation.annotationId)?.reason ?? piece.annotation.token)
      "
      >{{ piece.annotation.label }}<span v-if="issue(piece.annotation.annotationId)"> · review</span
      ><span v-if="piece.annotation.omitted" class="sr-only"> · omitted</span></span
    ><SpokenText v-else :book-id="bookId" :text="piece.text ?? ''"
  /></template>
</template>
