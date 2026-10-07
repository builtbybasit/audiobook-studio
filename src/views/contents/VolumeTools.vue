<script setup lang="ts">
// The ways to cut a book at once: evenly into N, every N chapters, or where the titles say a
// volume starts — shown first, by number and the words that said so, so the person sees what
// would be cut before it is. Each replaces every boundary the book has; Undo is in the toast.
import { computed, ref } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { TITLE_START } from "@/lib/volumes";
import { UiCheckbox } from "@/ui";
import type { ContentsPage } from "@/views/contents/useContents";

const props = defineProps<{ page: ContentsPage }>();
const p = props.page;
const evenly = ref(Math.max(2, Math.round(p.chapters.value.length / 100)));
const every = ref(100);
const picked = ref(new Set<number>());
const candidates = computed(() =>
  p.titleCandidates.value.map((c) => ({
    id: c.id,
    number: p.numbers.value?.get(c.id) ?? "—",
    says: TITLE_START.exec(c.title)?.[0] ?? "",
  })),
);
function openDetect() {
  picked.value = new Set(candidates.value.map((c) => c.id));
}
function togglePick(id: number) {
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
    <div class="flex items-center gap-1.5">
      <span>Evenly into</span>
      <input
        v-model.number="evenly"
        type="number"
        min="2"
        class="input w-14 py-0.5 text-xs"
        aria-label="How many volumes"
      />
      <span>volumes</span>
      <button class="btn-ghost btn-xs" @click="p.cutEvenly(Math.max(2, evenly))">Split</button>
    </div>
    <div class="flex items-center gap-1.5">
      <span>Every</span>
      <input
        v-model.number="every"
        type="number"
        min="10"
        step="10"
        class="input w-14 py-0.5 text-xs"
        aria-label="Chapters per volume"
      />
      <span>chapters</span>
      <button class="btn-ghost btn-xs" @click="p.cutEvery(Math.max(10, every))">Split</button>
    </div>
    <PopoverRoot @update:open="(o) => o && openDetect()">
      <PopoverTrigger class="btn-ghost btn-xs">
        Where titles say so
        <span class="font-mono text-zinc-400">{{ candidates.length }}</span>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          side="bottom"
          align="start"
          :side-offset="4"
          class="z-50 w-72 rounded-lg border border-zinc-200 bg-white p-3 text-xs shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div class="font-medium">Titles that read like a volume start</div>
          <p v-if="!candidates.length" class="mt-1 text-zinc-500">
            No title says “Volume 2”, “Book Two” or “Arc 3”.
          </p>
          <div v-else class="mt-2 max-h-56 space-y-1 overflow-auto">
            <label v-for="c in candidates" :key="c.id" class="flex items-center gap-2">
              <UiCheckbox
                :model-value="picked.has(c.id)"
                size="xs"
                @update:model-value="togglePick(c.id)"
              />
              <span class="w-10 font-mono text-[10px] text-zinc-400">ch {{ c.number }}</span>
              <span class="min-w-0 truncate">{{ c.says }}</span>
            </label>
          </div>
          <button
            v-if="candidates.length"
            class="btn-primary btn-xs mt-2"
            :disabled="!picked.size"
            @click="p.cutByTitles([...picked])"
          >
            Cut at {{ picked.size }}
          </button>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </div>
</template>
