<script setup lang="ts">
defineProps<{ label?: string; n?: number; of?: number; color?: string }>();
</script>
<template>
  <div>
    <div class="flex justify-between">
      <span class="text-zinc-500">{{ label }}</span
      ><span>{{ n }}/{{ of }}</span>
    </div>
    <div class="mt-0.5 h-1 rounded bg-zinc-200 dark:bg-zinc-800">
      <div
        class="h-1 rounded"
        :class="color"
        :style="{ width: (of ? ((n ?? 0) / of) * 100 : 0) + '%' }"
      ></div>
    </div>
  </div>
</template>
