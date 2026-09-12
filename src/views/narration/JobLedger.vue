<script setup>
// Job ledger: one row per segment, filterable. Sticky player at the bottom plays the stitched chapter:
// a scrubber drawn from segment boundaries (colour = speaker), the current row highlighted and kept in
// view. Stale rows (edited after narration) can be re-rendered on their own.
import { computed, ref, watch } from 'vue'
import { useJob, STATUS_BG, fmt } from './shared'
import { usePlayer } from '../../composables/usePlayer'

const props = defineProps({ bookId: String, chapterId: Number })
const { app, chapter, segments, colorOf, voiceOf, epName, stats } = useJob(props)
const { p, play, pause, seek } = usePlayer()
const filter = ref('all')
const rows = computed(() => filter.value === 'all' ? segments.value : segments.value.filter(s => s.audio.status === filter.value))
const FILTERS = ['all', 'done', 'generating', 'queued', 'failed', 'stale']
const count = (f) => f === 'all' ? stats.value.total : segments.value.filter(s => s.audio.status === f).length

// stitched timeline: cumulative offsets of segments that have audio (done or stale)
const timeline = computed(() => {
  let t = 0
  return segments.value.filter(s => s.audio.duration > 0).map(s => { const start = t; t += s.audio.duration; return { s, start, end: t } })
})
const total = computed(() => timeline.value.at(-1)?.end ?? 0)
const currentId = computed(() => p.id === 'chapter' ? timeline.value.find(x => p.pos >= x.start && p.pos < x.end)?.s.id ?? null : p.id?.startsWith('seg') ? Number(p.id.slice(3)) : null)
watch(currentId, id => { if (id && p.playing) document.getElementById('row-' + id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) })
function playFrom(s) { const x = timeline.value.find(x => x.s.id === s.id); if (!x) return; play('chapter', total.value); p.pos = x.start }
function scrub(e) { const frac = e.offsetX / e.currentTarget.clientWidth; if (p.id !== 'chapter') { play('chapter', total.value); pause() } seek(frac) }
</script>

<template>
  <div class="card flex h-full min-h-0 flex-col">
    <div class="grid grid-cols-6 divide-x divide-zinc-200 border-b border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      <button v-for="f in FILTERS" :key="f" class="px-4 py-3 text-left" :class="filter === f ? 'bg-zinc-50 dark:bg-zinc-800/60' : ''" @click="filter = f">
        <div class="text-[11px] uppercase tracking-wider text-zinc-500">{{ f }}</div>
        <div class="text-xl font-semibold" :class="{ 'text-red-500': f === 'failed' && count(f), 'text-emerald-500': f === 'done', 'text-violet-500': f === 'generating', 'text-amber-500': f === 'stale' && count(f) }">{{ count(f) }}</div>
      </button>
    </div>
    <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
      <span class="text-zinc-500">{{ chapter.title }} · {{ fmt(total) }} · {{ chapter.narration }}</span>
      <span class="ml-auto flex gap-2">
        <button v-if="count('stale') && chapter.narration !== 'running'" class="btn-primary btn-xs" @click="app.renarrateStale(bookId, chapterId)">↻ Re-narrate changed ({{ count('stale') }})</button>
        <button v-if="stats.failed && chapter.narration !== 'running'" class="btn-ghost btn-xs" @click="app.retryFailed(bookId, chapterId)">Retry failed ({{ stats.failed }})</button>
        <button v-if="chapter.narration !== 'running'" class="btn-ghost btn-xs" @click="app.runNarration(bookId, [chapterId])">Re-narrate all</button>
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full table-fixed text-sm">
        <thead class="sticky top-0 bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900"><tr><th class="w-10 px-3 py-2">#</th><th class="w-6"></th><th class="w-32">Speaker</th><th>Text</th><th class="w-28">Endpoint</th><th class="w-14 text-right">Took</th><th class="w-14 text-right">Audio</th><th class="w-24"></th></tr></thead>
        <tbody>
          <tr v-for="s in rows" :key="s.id" :id="'row-' + s.id" class="border-t border-zinc-100 dark:border-zinc-800/70" :class="currentId === s.id && 'bg-violet-50 dark:bg-violet-500/10'">
            <td class="px-3 font-mono text-[11px] text-zinc-400">{{ s.id }}</td>
            <td><span class="inline-block h-2.5 w-2.5 rounded-full" :class="STATUS_BG[s.audio.status]" :title="s.audio.status"></span></td>
            <td class="py-1.5"><div class="flex items-center gap-1.5"><span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: colorOf(s.speaker) }"></span><span class="truncate">{{ s.speaker }}</span></div><div class="pl-3.5 text-[10px] text-zinc-400">{{ voiceOf(s.speaker) }}</div></td>
            <td class="truncate py-1.5 pr-3 text-zinc-600 dark:text-zinc-300" :class="s.type === 'thought' && 'italic'"><div class="line-clamp-1">{{ s.text }}</div><div class="flex gap-2 text-[10px]"><span v-if="s.direction" class="text-violet-500">[{{ s.direction }}]</span><span v-if="s.audio.status === 'stale'" class="text-amber-600">edited after narration — audio is from the old script</span><span v-if="s.fallback" class="text-amber-600">unverified chunk</span></div></td>
            <td class="text-xs">{{ epName(s.audio.endpoint) }}</td>
            <td class="text-right font-mono text-xs text-zinc-500">{{ s.audio.ms ? (s.audio.ms / 1000).toFixed(1) + 's' : '' }}</td>
            <td class="text-right font-mono text-xs text-zinc-500">{{ s.audio.duration ? s.audio.duration.toFixed(1) + 's' : '' }}</td>
            <td class="pr-3 text-right">
              <template v-if="s.audio.status === 'done' || s.audio.status === 'stale'">
                <button class="btn-ghost btn-xs" :title="'play this segment'" @click="play('seg' + s.id, s.audio.duration)">{{ p.id === 'seg' + s.id && p.playing ? '❚❚' : '▶' }}</button>
                <button class="ml-1 text-[11px] text-zinc-400 hover:text-violet-500" title="play chapter from here" @click="playFrom(s)">⇥</button>
              </template>
              <button v-else-if="s.audio.status === 'failed'" class="btn-primary btn-xs" @click="app.retrySegment(bookId, chapterId, s.id)">↻ retry</button>
              <span v-else-if="s.audio.status === 'generating'" class="text-[11px] text-violet-500">…</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!rows.length" class="p-8 text-center text-sm text-zinc-500">No {{ filter }} segments.</div>
    </div>

    <!-- player -->
    <div class="border-t border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div class="flex items-center gap-3">
        <button class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40" :disabled="!total" @click="play('chapter', total)">{{ p.id === 'chapter' && p.playing ? '❚❚' : '▶' }}</button>
        <div class="min-w-0 flex-1">
          <div class="mb-1 flex items-center justify-between text-xs">
            <span class="truncate"><b v-if="currentId">#{{ currentId }} {{ segments.find(s => s.id === currentId)?.speaker }}</b><span v-else class="text-zinc-500">{{ total ? 'Stitched chapter · click the bar to scrub' : 'No audio yet' }}</span></span>
            <span class="font-mono text-zinc-500">{{ fmt(p.id === 'chapter' ? p.pos : (p.id ? p.pos : 0)) }} / {{ fmt(p.id === 'chapter' || !p.id ? total : p.len) }}</span>
          </div>
          <div class="relative h-5 cursor-pointer overflow-hidden rounded" @click="scrub">
            <div class="absolute inset-0 flex gap-px">
              <div v-for="x in timeline" :key="x.s.id" class="h-full" :style="{ width: ((x.end - x.start) / total * 100) + '%', background: colorOf(x.s.speaker), opacity: x.s.audio.status === 'stale' ? .35 : .75 }" :title="`#${x.s.id} ${x.s.speaker}`"></div>
              <div v-if="!timeline.length" class="h-full w-full bg-zinc-200 dark:bg-zinc-800"></div>
            </div>
            <div v-if="p.id === 'chapter'" class="absolute inset-y-0 left-0 bg-black/25 dark:bg-white/25" :style="{ width: (total ? p.pos / total * 100 : 0) + '%' }"></div>
            <div v-if="p.id === 'chapter'" class="absolute inset-y-0 w-0.5 bg-black dark:bg-white" :style="{ left: (total ? p.pos / total * 100 : 0) + '%' }"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
