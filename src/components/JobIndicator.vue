<script setup>
// Top-bar glance at the queue; click-through to the Queue page.
import { useApp } from '../stores/app'
const app = useApp()
</script>

<template>
  <RouterLink to="/queue" class="btn-ghost">
    <span v-if="app.activeJobs.length" class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"></span>
    <span v-else class="h-2 w-2 rounded-full bg-zinc-400"></span>
    Jobs
    <span class="rounded bg-zinc-200 px-1.5 text-xs dark:bg-zinc-700">{{ app.activeJobs.length }}</span>
    <span v-if="app.eta" class="hidden text-xs text-zinc-500 sm:inline" :title="'estimated finish ' + new Date(app.eta.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })">~{{ app.eta.seconds < 60 ? '<1m' : Math.round(app.eta.seconds / 60) + 'm' }}</span>
    <span v-if="app.jobs.some(j => j.status === 'failed')" class="rounded bg-red-500/15 px-1.5 text-xs text-red-500">{{ app.jobs.filter(j => j.status === 'failed').length }} failed</span>
  </RouterLink>
</template>
