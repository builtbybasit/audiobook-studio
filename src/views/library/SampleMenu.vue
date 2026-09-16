<script setup lang="ts">
// The sample EPUBs, as a menu rather than a banner: the prototype parses no file, so these are the
// files there are to try, and they belong beside "Add EPUB" instead of across the page.
import { IMPORT_SAMPLES } from "@/mock";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { ChevronDown as OpenIcon, FileText as SampleIcon } from "@lucide/vue";
import { ref } from "vue";

defineProps<{ primary?: boolean }>();
const emit = defineEmits<{ pick: [id: string] }>();
const open = ref(false);
function pick(id: string) {
  open.value = false;
  emit("pick", id);
}
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      :class="primary ? 'btn-primary' : 'btn-ghost'"
      title="Nothing is parsed in this prototype — pick what a file turns out to contain"
    >
      <SampleIcon class="icon" /> Try a sample <OpenIcon class="icon-sm opacity-60" />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        align="end"
        :side-offset="6"
        class="ui-popup w-[min(26rem,92vw)] p-1.5 text-xs"
      >
        <div class="px-2 pb-1 pt-1.5 text-[11px] text-zinc-500">
          Seven files, each a situation the contents review has to handle. Nothing is parsed.
        </div>
        <button
          v-for="s in IMPORT_SAMPLES"
          :key="s.id"
          class="block w-full rounded-md px-2 py-1.5 text-left hover:bg-violet-50 focus-visible:bg-violet-50 focus-visible:outline-none dark:hover:bg-violet-500/15 dark:focus-visible:bg-violet-500/15"
          @click="pick(s.id)"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-medium">{{ s.label }}</span>
            <span class="shrink-0 font-mono text-[10px] text-zinc-400"
              >{{ s.volumes.reduce((a, v) => a + v.chapters.length, 0) }} ch</span
            >
          </div>
          <div class="mt-0.5 leading-snug text-zinc-500">{{ s.hint }}</div>
        </button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
