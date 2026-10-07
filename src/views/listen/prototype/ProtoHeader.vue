<script setup lang="ts">
// PROTOTYPE — throwaway. The card header the capsule variants share: previous and next narrated
// chapter, the chapter picker, the chapter's place, reader settings.
import { computed } from "vue";
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import ReaderSettings from "@/components/ReaderSettings.vue";
import { UiCombobox } from "@/ui";
import {
  fmt,
  isNarratedChapter,
  neighbour,
  placeOf,
  type ListenCtx,
} from "@/views/listen/prototype/ctx";

const props = defineProps<{ ctx: ListenCtx }>();
const options = computed(() =>
  props.ctx.chapters.map((ch, i) => ({
    value: ch.id,
    label: `${i + 1} · ${ch.title}`,
    hint: isNarratedChapter(ch) ? fmt(ch.duration) : "no audio",
  })),
);
const before = computed(() => neighbour(props.ctx, -1));
const after = computed(() => neighbour(props.ctx, 1));
</script>

<template>
  <header
    class="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-xl border-b border-zinc-200 bg-white/95 px-4 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
  >
    <button
      class="icon-btn"
      :disabled="!before"
      title="previous narrated chapter"
      @click="before && ctx.open(before.id)"
    >
      <ChevronLeft class="icon-sm" />
    </button>
    <UiCombobox
      :model-value="ctx.opened"
      :options="options"
      placeholder="Chapter…"
      @update:model-value="(id) => id != null && ctx.open(Number(id))"
    />
    <button
      class="icon-btn"
      :disabled="!after"
      title="next narrated chapter"
      @click="after && ctx.open(after.id)"
    >
      <ChevronRight class="icon-sm" />
    </button>
    <span class="text-xs text-zinc-500">{{ placeOf(ctx) }} of {{ ctx.chapters.length }}</span>
    <span class="ml-auto flex items-center gap-2"><slot /><ReaderSettings /></span>
  </header>
</template>
