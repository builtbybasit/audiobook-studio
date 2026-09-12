<script setup>
import { ref } from 'vue'
import { useApp } from '../stores/app'
const app = useApp()
const open = ref(false)
const icon = { scripting: '✎', narration: '♪', export: '⤓' }
</script>

<template>
  <div class="relative">
    <button class="btn-ghost" @click="open = !open">
      <span v-if="app.activeJobs.length" class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"></span>
      <span v-else class="h-2 w-2 rounded-full bg-zinc-400"></span>
      Jobs
      <span class="rounded bg-zinc-200 px-1.5 text-xs dark:bg-zinc-700">{{ app.activeJobs.length }}</span>
    </button>
    <div v-if="open" class="card absolute right-0 top-10 z-40 w-80 p-2 shadow-xl">
      <div class="label px-2 py-1">Queue</div>
      <div v-if="!app.recentJobs.length" class="px-2 py-3 text-sm text-zinc-500">Nothing has run yet.</div>
      <div v-for="j in app.recentJobs" :key="j.id" class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
        <span class="w-4 text-center text-zinc-500">{{ icon[j.kind] }}</span>
        <div class="min-w-0 flex-1">
          <div class="truncate">{{ j.label }} <span class="text-zinc-400">· {{ app.bookById(j.bookId)?.title }}</span></div>
          <div v-if="j.status === 'running'" class="mt-1 h-1 rounded bg-zinc-200 dark:bg-zinc-700"><div class="h-1 rounded bg-violet-500" :style="{ width: j.progress + '%' }"></div></div>
        </div>
        <span class="text-[11px] uppercase" :class="{ 'text-emerald-500': j.status === 'done', 'text-red-500': j.status === 'failed', 'text-violet-500': j.status === 'running', 'text-zinc-400': j.status === 'queued' }">{{ j.status }}</span>
      </div>
    </div>
  </div>
</template>
