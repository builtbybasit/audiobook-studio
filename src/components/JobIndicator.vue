<script setup lang="ts">
import { useJobsStore } from "@/stores/jobs";

// Top-bar glance at the queue; click-through to the Queue page.

const jobsStore = useJobsStore();
</script>

<template>
  <RouterLink to="/queue" class="btn-ghost">
    <span
      v-if="jobsStore.activeJobs.length"
      class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"
    ></span>
    <span v-else class="h-2 w-2 rounded-full bg-zinc-400"></span>
    Jobs
    <span class="rounded bg-zinc-200 px-1.5 text-xs dark:bg-zinc-700">{{
      jobsStore.activeJobs.length
    }}</span>
    <span
      v-if="jobsStore.eta"
      class="hidden text-xs text-zinc-500 sm:inline"
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
      class="rounded bg-red-500/15 px-1.5 text-xs text-red-500"
      >{{ jobsStore.jobs.filter((j) => j.status === "failed").length }} failed</span
    >
  </RouterLink>
</template>
