<script setup lang="ts">
// A row of tabs on reka-ui's Tabs, inside the page's own `TabsRoot`, styled the same everywhere.
// Border and spacing come from `class`; the `tab` slot holds a count or badge, the default extras.
import { TabsList, TabsTrigger } from "reka-ui";

defineProps<{ tabs: readonly { value: string; label: string }[] }>();
</script>

<template>
  <TabsList class="flex items-center gap-1">
    <TabsTrigger
      v-for="t in tabs"
      :key="t.value"
      :value="t.value"
      class="flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm text-zinc-500 transition-colors hover:text-zinc-800 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:hover:text-zinc-200 dark:data-[state=active]:text-zinc-100"
    >
      {{ t.label }}<slot name="tab" :tab="t" />
    </TabsTrigger>
    <slot />
  </TabsList>
</template>
