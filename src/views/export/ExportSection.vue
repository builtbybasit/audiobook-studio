<script setup lang="ts">
// One foldable settings block. The summary line carries what the section is currently set to, so a
// folded section still answers its own question and only has to be opened to change the answer.
import { ref } from "vue";
import { ChevronDown as ChevronDownIcon } from "@lucide/vue";
import type { Component } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    summary?: string;
    icon?: Component;
    open?: boolean;
    /** a badge that says this section wants a look */
    note?: string;
  }>(),
  { summary: "", icon: undefined, open: false, note: "" },
);
const open = ref(props.open);
</script>

<template>
  <section class="border-t border-zinc-200 first:border-t-0 dark:border-zinc-800">
    <h3>
      <button
        class="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        :aria-expanded="open"
        @click="open = !open"
      >
        <ChevronDownIcon
          class="icon-sm shrink-0 text-zinc-400 transition-transform"
          :class="!open && '-rotate-90'"
        />
        <component v-if="icon" :is="icon" class="icon shrink-0 text-zinc-400" />
        <span class="shrink-0 text-sm font-medium">{{ title }}</span>
        <span
          v-if="note"
          class="shrink-0 rounded bg-amber-400/15 px-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
          >{{ note }}</span
        >
        <span v-if="summary" class="min-w-0 flex-1 truncate text-right text-xs text-zinc-500">{{
          summary
        }}</span>
      </button>
    </h3>
    <div v-show="open" class="px-4 pb-4 pt-1"><slot /></div>
  </section>
</template>
