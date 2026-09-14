<script setup>
defineProps({ label: String, n: Number, of: Number, color: String });
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
        :style="{ width: (of ? (n / of) * 100 : 0) + '%' }"
      ></div>
    </div>
  </div>
</template>
