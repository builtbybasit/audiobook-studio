<script setup lang="ts">
import { useJobsStore } from "@/stores/jobs";

// Top-bar glance at the queue; click-through to the Queue page. Sized like the header's other
// chips (Jump, Demo), not like a button.

const jobsStore = useJobsStore();
</script>

<template>
  <RouterLink
    to="/queue"
    class="flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 text-xs text-zinc-600 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700 dark:text-zinc-300"
  >
    <span
      v-if="jobsStore.activeJobs.length"
      class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"
    ></span>
    <span v-else class="h-2 w-2 rounded-full bg-zinc-400"></span>
    <span class="hidden sm:inline">Jobs</span>
    <span class="rounded bg-zinc-200 px-1.5 text-[11px] tabular-nums dark:bg-zinc-700">{{
      jobsStore.activeJobs.length
    }}</span>
    <span
      v-if="jobsStore.eta"
      class="hidden text-[11px] text-zinc-500 sm:inline"
      :title="
        'estimated finish ' +
        new Date(jobsStore.eta.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      "
      >~{{
        jobsStore.eta.seconds < 60 ? "<1m" : Math.round(jobsStore.eta.seconds / 60) + "m"
      }}</span
    >
    <span
      v-if="jobsStore.jobs.some((j) => j.status === 'failed')"
      class="rounded bg-red-500/15 px-1.5 text-[11px] tabular-nums text-red-500"
      >{{ jobsStore.jobs.filter((j) => j.status === "failed").length
      }}<span class="hidden sm:inline"> failed</span></span
    >
  </RouterLink>
</template>
