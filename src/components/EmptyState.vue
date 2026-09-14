<script setup lang="ts">
import type { Component } from "vue";
import { Circle as DefaultIcon } from "@lucide/vue";
withDefaults(defineProps<{ icon?: Component; title?: string; body?: string; steps?: string[] }>(), {
  icon: () => DefaultIcon,
  title: undefined,
  body: undefined,
  steps: () => [],
});
</script>
<template>
  <div class="card grid h-full place-items-center p-8 text-center">
    <div class="max-w-md">
      <div
        class="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
      >
        <component :is="icon" class="h-6 w-6" />
      </div>
      <div class="text-lg font-medium">{{ title }}</div>
      <p class="mt-1 text-sm text-zinc-500">{{ body }}</p>
      <ol v-if="steps.length" class="mx-auto mt-4 inline-block text-left text-sm">
        <li v-for="(st, i) in steps" :key="i" class="flex gap-2 py-1">
          <span
            class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-violet-600 text-[11px] text-white"
            >{{ i + 1 }}</span
          ><span>{{ st }}</span>
        </li>
      </ol>
      <div class="mt-4 flex justify-center gap-2"><slot /></div>
    </div>
  </div>
</template>
