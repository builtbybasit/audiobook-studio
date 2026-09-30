<script setup lang="ts">
// A row of tabs on reka-ui's Tabs, inside the page's own `TabsRoot`: the underline under the open
// one and the muted rest, the same on every page that has tabs. The list's border and spacing are
// the caller's `class`, since each row sits differently in its page. A tab's count, dot or badge
// goes in the `tab` slot, after its label; anything else in the row (a collapse button) goes in the
// default slot, after the last tab.
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
