<script setup lang="ts">
import { useDemoStore } from "@/stores/demo";

// Prototype-only: drop the Search page into a seeded situation worth trying the bulk flow on.
// Seeding mutates the open book in memory and keeps the snapshot that puts it back — Reset restores
// it exactly, and nothing is written anywhere.
import { computed } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { FlaskConical as DemoIcon, RotateCcw as ResetIcon } from "@lucide/vue";

import type { SearchScenario } from "@/types";

const props = defineProps<{ bookId: string }>();
const emit = defineEmits<{ pick: [SearchScenario]; reset: [] }>();
const demoStore = useDemoStore();
const scenarios = computed(() => demoStore.searchScenarios(props.bookId));
const seeded = computed(() => demoStore._searchDemo?.bookId === props.bookId);

function pick(s: SearchScenario) {
  demoStore.seedSearchDemo(props.bookId);
  emit("pick", s);
}
/** Restoring the book can move the lines out from under a selection, so drop it. */
function reset() {
  demoStore.resetSearchDemo();
  emit("reset");
}
</script>

<template>
  <PopoverRoot>
    <!-- These are searches, not world states: the header's Demo chip seeds the situation, this one
         runs a query against it. Named apart so two chips never both read "Demo". -->
    <PopoverTrigger
      class="chip"
      :class="seeded && 'chip-on'"
      title="seeded searches to try the bulk corrections on"
    >
      <DemoIcon class="icon-sm" /> Demo searches
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent align="end" :side-offset="6" class="ui-popup w-80 p-3 text-xs">
        <div class="label mb-1">Seeded searches</div>
        <p class="mb-2 text-[11px] leading-relaxed text-zinc-500">
          Prototype only. Picking one seeds this book in memory and runs the search. Reset puts the
          book back.
        </p>
        <div v-if="!scenarios.length" class="py-2 text-zinc-500">
          Script a chapter of this book first.
        </div>
        <button
          v-for="s in scenarios"
          :key="s.id"
          class="mb-1 w-full rounded-md border border-zinc-200 p-2 text-left hover:border-violet-400 dark:border-zinc-700"
          @click="pick(s)"
        >
          <div class="font-medium">{{ s.label }}</div>
          <div class="mt-0.5 leading-relaxed text-zinc-500">{{ s.hint }}</div>
        </button>
        <button
          class="btn-ghost btn-xs mt-1 w-full justify-center"
          :disabled="!seeded"
          @click="reset"
        >
          <ResetIcon class="icon-sm" /> Reset the demo data
        </button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
