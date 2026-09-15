<script setup lang="ts">
import { useDemoStore } from "@/stores/demo";

// Prototype only: drop the Export page into a situation worth trying a build on. Seeding mutates
// the book in memory and keeps the snapshot that puts it back, exactly as the Search demo does.
import { computed } from "vue";
import { useRouter } from "vue-router";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { FlaskConical as DemoIcon, RotateCcw as ResetIcon } from "@lucide/vue";

import { UiSwitch } from "@/ui";

const demoStore = useDemoStore();
const router = useRouter();
const scenarios = computed(() => demoStore.exportScenarios());
const seeded = computed(() => demoStore._exportDemo);

function pick(id: string) {
  const bookId = demoStore.seedExportDemo(id);
  if (bookId) router.push(`/book/${bookId}/export`);
}
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger class="chip" :class="seeded && 'chip-on'" title="seeded demo scenarios">
      <DemoIcon class="icon-sm" /> Demo
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent align="end" :side-offset="6" class="ui-popup w-[min(22rem,92vw)] p-3 text-xs">
        <div class="label mb-1">Seeded scenarios</div>
        <p class="mb-2 text-[11px] leading-relaxed text-zinc-500">
          Prototype only. Picking one seeds a book in memory and opens its Export page. Reset puts
          it back.
        </p>
        <button
          v-for="s in scenarios"
          :key="s.id"
          class="mb-1 w-full rounded-md border border-zinc-200 p-2 text-left hover:border-violet-400 dark:border-zinc-700"
          @click="pick(s.id)"
        >
          <div class="font-medium">{{ s.label }}</div>
          <div class="mt-0.5 leading-relaxed text-zinc-500">{{ s.hint }}</div>
        </button>
        <div class="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
          <UiSwitch
            v-model="demoStore._exportFails"
            label="make the next build fail"
            class="text-[11px]"
          />
          <p class="mt-1 text-[11px] leading-relaxed text-zinc-500">
            One shot. The build stops part-way, the previous version stays on disk, and the failure
            offers a retry.
          </p>
        </div>
        <button
          class="btn-ghost btn-xs mt-2 w-full justify-center"
          :disabled="!seeded"
          @click="demoStore.resetExportDemo()"
        >
          <ResetIcon class="icon-sm" /> Reset the demo data
        </button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
