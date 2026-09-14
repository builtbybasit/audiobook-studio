<script setup>
defineProps({ status: String });
const cls = {
  none: "bg-zinc-300 dark:bg-zinc-600",
  queued: "bg-zinc-400 ring-2 ring-zinc-300 dark:ring-zinc-700",
  running: "bg-violet-500 animate-pulse",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  generating: "bg-violet-500 animate-pulse",
  stale: "bg-amber-500",
  fallback: "bg-emerald-500 ring-2 ring-amber-400",
};
</script>
<template>
  <span
    class="inline-block h-2 w-2 shrink-0 rounded-full"
    :class="cls[status] ?? cls.none"
    :title="status"
  ></span>
</template>
