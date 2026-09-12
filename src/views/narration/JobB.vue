<script setup>
// Job view B — "Lanes": kanban by endpoint. A Queue column feeds one lane per endpoint; done cards
// sink to a Finished column. Makes the load-balancing across endpoints visible at a glance.
import { computed } from 'vue'
import { useJob, fmt } from './shared'
import { usePlayer } from '../../composables/usePlayer'

const props = defineProps({ bookId: String, chapterId: Number })
const { app, chapter, segments, colorOf, stats } = useJob(props)
const { p, play } = usePlayer()
const queued = computed(() => segments.value.filter(s => s.audio.status === 'queued'))
const failed = computed(() => segments.value.filter(s => s.audio.status === 'failed'))
const finished = computed(() => segments.value.filter(s => s.audio.status === 'done'))
const laneOf = (ep) => segments.value.filter(s => s.audio.status === 'generating' && s.audio.endpoint === ep.id)
const doneBy = (ep) => segments.value.filter(s => s.audio.status === 'done' && s.audio.endpoint === ep.id).length
const elapsed = (s) => ((Date.now() - (s.audio.startedAt ?? Date.now())) / 1000).toFixed(0)
</script>

<template>
  <div class="card flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div><div class="font-medium">{{ chapter.title }}</div><div class="text-xs text-zinc-500">{{ stats.done }}/{{ stats.total }} rendered · {{ fmt(stats.duration) }}</div></div>
      <div class="ml-4 h-2 w-48 rounded bg-zinc-200 dark:bg-zinc-800"><div class="h-2 rounded bg-emerald-500 transition-all" :style="{ width: stats.done / stats.total * 100 + '%' }"></div></div>
      <div class="ml-auto flex gap-2">
        <button v-if="failed.length && chapter.narration !== 'running'" class="btn-primary btn-xs" @click="app.retryFailed(bookId, chapterId)">Retry {{ failed.length }} failed</button>
        <button class="btn-ghost btn-xs" :disabled="!stats.done" @click="play('chapter', stats.duration)">{{ p.playing ? '❚❚' : '▶' }} Play chapter</button>
      </div>
    </div>

    <div class="grid min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto p-4" :style="{ gridTemplateColumns: `180px repeat(${app.endpoints.length}, minmax(200px, 1fr)) 220px` }">
      <!-- queue -->
      <div class="flex min-h-0 flex-col rounded-lg bg-zinc-100 dark:bg-zinc-800/50">
        <div class="px-3 py-2 text-xs font-semibold text-zinc-500">QUEUE <span class="ml-1 rounded bg-zinc-300 px-1.5 dark:bg-zinc-700">{{ queued.length }}</span></div>
        <div class="min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-2">
          <div v-for="s in queued.slice(0, 30)" :key="s.id" class="flex items-center gap-1.5 rounded bg-white px-2 py-1 text-[11px] dark:bg-zinc-900"><span class="h-2 w-2 rounded-full" :style="{ background: colorOf(s.speaker) }"></span>#{{ s.id }} <span class="truncate text-zinc-500">{{ s.speaker }}</span></div>
          <div v-if="queued.length > 30" class="px-2 text-[11px] text-zinc-400">+{{ queued.length - 30 }} more</div>
        </div>
        <div v-if="failed.length" class="border-t border-red-300/50 px-2 py-2">
          <div class="mb-1 text-[11px] font-semibold text-red-500">FAILED {{ failed.length }}</div>
          <div v-for="s in failed" :key="s.id" class="mb-1 flex items-center gap-1 rounded border border-red-300 bg-white px-2 py-1 text-[11px] dark:border-red-500/40 dark:bg-zinc-900">#{{ s.id }} <span class="truncate text-zinc-500">{{ s.speaker }}</span><button class="ml-auto text-violet-500" @click="app.retrySegment(bookId, chapterId, s.id)">↻</button></div>
        </div>
      </div>

      <!-- one lane per endpoint -->
      <div v-for="ep in app.endpoints" :key="ep.id" class="flex min-h-0 flex-col rounded-lg border" :class="ep.enabled ? 'border-zinc-200 dark:border-zinc-800' : 'border-dashed border-zinc-300 opacity-50 dark:border-zinc-700'">
        <div class="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <span class="h-2 w-2 rounded-full" :class="ep.enabled ? 'bg-emerald-500' : 'bg-zinc-400'"></span>
          <span class="truncate text-sm font-medium">{{ ep.name }}</span>
          <span class="ml-auto font-mono text-[11px] text-zinc-500">{{ laneOf(ep).length }}/{{ ep.concurrency }}</span>
        </div>
        <div class="flex-1 space-y-2 overflow-auto p-2">
          <div v-for="i in ep.concurrency" :key="i" class="min-h-16 rounded-md border border-dashed border-zinc-200 p-2 dark:border-zinc-800">
            <template v-if="laneOf(ep)[i - 1]">
              <div class="flex items-center gap-1.5 text-xs"><span class="h-2 w-2 animate-pulse rounded-full bg-violet-500"></span><b>#{{ laneOf(ep)[i - 1].id }}</b><span class="truncate" :style="{ color: colorOf(laneOf(ep)[i - 1].speaker) }">{{ laneOf(ep)[i - 1].speaker }}</span><span class="ml-auto font-mono text-zinc-400">{{ elapsed(laneOf(ep)[i - 1]) }}s</span></div>
              <div class="mt-1 line-clamp-2 text-[11px] text-zinc-500">{{ laneOf(ep)[i - 1].text }}</div>
            </template>
            <div v-else class="text-center text-[11px] text-zinc-300 dark:text-zinc-700">slot {{ i }} idle</div>
          </div>
        </div>
        <div class="border-t border-zinc-200 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-800">{{ doneBy(ep) }} done · ~{{ (ep.latency / 1000).toFixed(1) }}s/seg</div>
      </div>

      <!-- finished -->
      <div class="flex min-h-0 flex-col rounded-lg bg-emerald-500/5">
        <div class="px-3 py-2 text-xs font-semibold text-emerald-600">FINISHED <span class="ml-1 rounded bg-emerald-500/20 px-1.5">{{ finished.length }}</span></div>
        <div class="min-h-0 flex-1 space-y-1 overflow-auto px-2 pb-2">
          <div v-for="s in [...finished].reverse()" :key="s.id" class="flex items-center gap-1.5 rounded bg-white px-2 py-1 text-[11px] dark:bg-zinc-900">
            <span class="h-2 w-2 rounded-full" :style="{ background: colorOf(s.speaker) }"></span>#{{ s.id }}
            <span class="truncate text-zinc-500">{{ s.speaker }}</span>
            <span class="ml-auto font-mono text-zinc-400">{{ s.audio.duration.toFixed(1) }}s</span>
            <button class="text-violet-500" @click="play('seg' + s.id, s.audio.duration)">{{ p.id === 'seg' + s.id && p.playing ? '❚❚' : '▶' }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
