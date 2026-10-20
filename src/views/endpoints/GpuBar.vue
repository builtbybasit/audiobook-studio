<script setup lang="ts">
// This machine's NVIDIA GPUs, one line each, live from the local servers poll; hidden without one.
import { useLocalServers } from "@/queries/localServers";
import { gb } from "@/views/endpoints/state";

const { data } = useLocalServers();
const used = (mb: number, total: number) => Math.min(100, (mb / total) * 100 || 0);
</script>

<template>
  <section v-if="data?.gpus.length" class="card space-y-1.5 px-3 py-2" aria-label="GPUs">
    <div v-for="g in data.gpus" :key="g.index" class="flex items-center gap-3 text-xs">
      <span class="w-40 shrink-0 truncate font-medium sm:w-56" :title="g.name">{{ g.name }}</span>
      <span
        class="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        aria-hidden="true"
        ><span
          class="block h-full rounded-full"
          :class="used(g.memoryUsedMb, g.memoryTotalMb) >= 90 ? 'bg-amber-500' : 'bg-violet-500'"
          :style="{ width: `${used(g.memoryUsedMb, g.memoryTotalMb)}%` }"
        ></span
      ></span>
      <span class="shrink-0 font-mono"
        >{{ gb(g.memoryUsedMb) }} / {{ gb(g.memoryTotalMb) }} GB
        <span class="sr-only">VRAM used</span></span
      >
      <span v-if="g.utilization != null" class="w-10 shrink-0 text-right font-mono text-zinc-500"
        >{{ g.utilization }}%<span class="sr-only"> busy</span></span
      >
      <span v-if="g.temperature != null" class="w-12 shrink-0 text-right font-mono text-zinc-500"
        >{{ g.temperature }} °C</span
      >
    </div>
  </section>
</template>
