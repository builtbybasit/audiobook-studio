<script setup>
// Job view C — "Ledger": a dense vertical log, one row per segment, with filters. Sticky player
// at the bottom follows the row you play. Optimised for "find the failures and listen back".
import { computed, ref } from 'vue'
import { useJob, STATUS_BG, fmt } from './shared'
import { usePlayer } from '../../composables/usePlayer'

const props = defineProps({ bookId: String, chapterId: Number })
const { app, chapter, segments, colorOf, voiceOf, epName, stats } = useJob(props)
const { p, play } = usePlayer()
const filter = ref('all')
const rows = computed(() => filter.value === 'all' ? segments.value : segments.value.filter(s => s.audio.status === filter.value))
const playingSeg = computed(() => segments.value.find(s => 'seg' + s.id === p.id))
</script>

<template>
  <div class="card flex h-full min-h-0 flex-col">
    <div class="grid grid-cols-5 divide-x divide-zinc-200 border-b border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      <button v-for="f in ['all', 'done', 'generating', 'queued', 'failed']" :key="f" class="px-4 py-3 text-left" :class="filter === f ? 'bg-zinc-50 dark:bg-zinc-800/60' : ''" @click="filter = f">
        <div class="text-[11px] uppercase tracking-wider text-zinc-500">{{ f }}</div>
        <div class="text-xl font-semibold" :class="{ 'text-red-500': f === 'failed' && stats.failed, 'text-emerald-500': f === 'done', 'text-violet-500': f === 'generating' }">{{ f === 'all' ? stats.total : stats[f] ?? 0 }}</div>
      </button>
    </div>
    <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
      <span class="text-zinc-500">{{ chapter.title }} · {{ fmt(stats.duration) }} · {{ chapter.narration }}</span>
      <button v-if="stats.failed && chapter.narration !== 'running'" class="btn-primary btn-xs ml-auto" @click="app.retryFailed(bookId, chapterId)">Retry all failed</button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full table-fixed text-sm">
        <thead class="sticky top-0 bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900"><tr><th class="w-10 px-3 py-2">#</th><th class="w-6"></th><th class="w-36">Speaker</th><th>Text</th><th class="w-32">Endpoint</th><th class="w-16 text-right">Took</th><th class="w-16 text-right">Audio</th><th class="w-20"></th></tr></thead>
        <tbody>
          <tr v-for="s in rows" :key="s.id" class="border-t border-zinc-100 dark:border-zinc-800/70" :class="p.id === 'seg' + s.id && 'bg-violet-50 dark:bg-violet-500/10'">
            <td class="px-3 font-mono text-[11px] text-zinc-400">{{ s.id }}</td>
            <td><span class="inline-block h-2.5 w-2.5 rounded-full" :class="STATUS_BG[s.audio.status]"></span></td>
            <td class="py-1.5"><div class="flex items-center gap-1.5"><span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: colorOf(s.speaker) }"></span><span class="truncate">{{ s.speaker }}</span></div><div class="pl-3.5 text-[10px] text-zinc-400">{{ voiceOf(s.speaker) }}</div></td>
            <td class="truncate py-1.5 pr-3 text-zinc-600 dark:text-zinc-300" :class="s.type === 'thought' && 'italic'"><div class="line-clamp-1">{{ s.text }}</div><div v-if="s.direction" class="text-[10px] text-violet-500">[{{ s.direction }}]</div></td>
            <td class="text-xs">{{ epName(s.audio.endpoint) }}</td>
            <td class="text-right font-mono text-xs text-zinc-500">{{ s.audio.ms ? (s.audio.ms / 1000).toFixed(1) + 's' : '' }}</td>
            <td class="text-right font-mono text-xs text-zinc-500">{{ s.audio.duration ? s.audio.duration.toFixed(1) + 's' : '' }}</td>
            <td class="pr-3 text-right">
              <button v-if="s.audio.status === 'done'" class="btn-ghost btn-xs" @click="play('seg' + s.id, s.audio.duration)">{{ p.id === 'seg' + s.id && p.playing ? '❚❚' : '▶' }}</button>
              <button v-else-if="s.audio.status === 'failed'" class="btn-primary btn-xs" @click="app.retrySegment(bookId, chapterId, s.id)">↻ retry</button>
              <span v-else-if="s.audio.status === 'generating'" class="text-[11px] text-violet-500">…</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!rows.length" class="p-8 text-center text-sm text-zinc-500">No {{ filter }} segments.</div>
    </div>

    <div class="flex items-center gap-3 border-t border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60">
      <button class="grid h-8 w-8 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40" :disabled="!stats.done" @click="playingSeg ? play(p.id, p.len) : play('chapter', stats.duration)">{{ p.playing ? '❚❚' : '▶' }}</button>
      <div class="min-w-0 flex-1 text-xs">
        <div class="truncate"><b v-if="playingSeg">#{{ playingSeg.id }} {{ playingSeg.speaker }}</b><b v-else-if="p.id === 'chapter'">Whole chapter</b><span v-else class="text-zinc-500">Nothing playing</span></div>
        <div class="mt-1 h-1 rounded bg-zinc-200 dark:bg-zinc-800"><div class="h-1 rounded bg-violet-500" :style="{ width: (p.len ? p.pos / p.len * 100 : 0) + '%' }"></div></div>
      </div>
      <span class="font-mono text-xs text-zinc-500">{{ fmt(p.pos) }} / {{ fmt(p.len) }}</span>
    </div>
  </div>
</template>
