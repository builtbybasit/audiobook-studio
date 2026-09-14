<script setup>
// Job ledger: one row per segment, filterable. Sticky player at the bottom plays the stitched chapter:
// a scrubber drawn from segment boundaries (colour = speaker), the current row highlighted and kept in
// view. Stale rows (edited after narration) can be re-rendered on their own. Each rendered row expands
// (i) to its audit trail — voice, model, direction and style it was rendered with, cost, cuts — and, for
// failures, the HTTP status + body with a "copy request" for debugging.
// Keyboard: j/k move, ↵/p play, r retry, i details.
import { computed, ref, watch } from 'vue'
import { useJob, STATUS_BG, fmt } from './shared'
import { usePlayer } from '../../composables/usePlayer'

const props = defineProps({ bookId: String, chapterId: Number })
const { app, chapter, segments, colorOf, voiceOf, epName, stats } = useJob(props)
const { p, play, pause, seek } = usePlayer()
const filter = ref('all')
const expanded = ref(new Set())
const toggleDetails = (id) => { const n = new Set(expanded.value); n.has(id) ? n.delete(id) : n.add(id); expanded.value = n }
const AT = { sentence: 'sentence', clause: 'clause', word: 'word', char: 'hard cut' }
const rows = computed(() => filter.value === 'all' ? segments.value : segments.value.filter(s => s.audio.status === filter.value))
const FILTERS = ['all', 'done', 'generating', 'queued', 'failed', 'stale']
const count = (f) => f === 'all' ? stats.value.total : segments.value.filter(s => s.audio.status === f).length

const timeline = computed(() => { let t = 0; return segments.value.filter(s => s.audio.duration > 0).map(s => { const start = t; t += s.audio.duration; return { s, start, end: t } }) })
const total = computed(() => timeline.value.at(-1)?.end ?? 0)
const currentId = computed(() => p.id === 'chapter' ? timeline.value.find(x => p.pos >= x.start && p.pos < x.end)?.s.id ?? null : p.id?.startsWith('seg') ? Number(p.id.slice(3)) : null)
watch(currentId, id => { if (id && p.playing) document.getElementById('row-' + id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) })
function playFrom(s) { const x = timeline.value.find(x => x.s.id === s.id); if (!x) return; play('chapter', total.value); p.pos = x.start }
function scrub(e) { const frac = e.offsetX / e.currentTarget.clientWidth; if (p.id !== 'chapter') { play('chapter', total.value); pause() } seek(frac) }

// what differs between the clip and the script now (the reason a row is stale, made explicit)
function drift(s) {
  const a = s.audio; if (!a.at) return []
  const out = []
  if ((a.direction || '') !== (s.direction || '')) out.push(`direction: “${a.direction || '—'}” → “${s.direction || '—'}”`)
  if (a.type && a.type !== s.type) out.push(`type: ${a.type} → ${s.type}`)
  const now = app.effectiveVoice(props.bookId, s.speaker); if (a.voiceRef && now.ref !== a.voiceRef) out.push(`voice: ${app.voiceLabel(a.voiceRef)} → ${app.voiceLabel(now.ref) || 'unset'}`)
  const who = app.charactersOf(props.bookId).find(c => c.name === s.speaker); if ((a.style ?? '') !== (who?.style ?? '')) out.push(`style: “${a.style || '—'}” → “${who?.style || '—'}”`)
  return out
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
function requestOf(s) {
  const ep = app.endpoints.find(e => e.id === s.audio.endpoint)
  return JSON.stringify({ POST: (ep?.baseUrl ?? '') + '/audio/speech', headers: { Authorization: 'Bearer <key>' }, body: { model: s.audio.model, voice: s.audio.voice, input: s.text, instructions: [s.audio.style, s.audio.direction].filter(Boolean).join('; ') || undefined, response_format: 'wav' }, error: s.audio.error }, null, 2)
}
function copyReq(s) { navigator.clipboard?.writeText(requestOf(s)); app.toast('Request copied as JSON', { timeout: 2000 }) }
function onRowKey(e, s) {
  const list = [...e.currentTarget.parentElement.querySelectorAll('tr[data-row]')]; const i = list.indexOf(e.currentTarget)
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); list[i + 1]?.focus() }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); list[i - 1]?.focus() }
  else if ((e.key === 'Enter' || e.key === 'p') && s.audio.duration) { e.preventDefault(); play('seg' + s.id, s.audio.duration) }
  else if (e.key === 'r' && s.audio.status === 'failed') app.retrySegment(props.bookId, props.chapterId, s.id)
  else if (e.key === 'i') toggleDetails(s.id)
}
</script>

<template>
  <div class="card flex h-full min-h-0 flex-col">
    <div class="grid grid-cols-3 divide-x divide-zinc-200 border-b border-zinc-200 sm:grid-cols-6 dark:divide-zinc-800 dark:border-zinc-800">
      <button v-for="f in FILTERS" :key="f" class="px-4 py-3 text-left" :class="filter === f ? 'bg-zinc-50 dark:bg-zinc-800/60' : ''" @click="filter = f">
        <div class="text-[11px] uppercase tracking-wider text-zinc-500">{{ f }}</div>
        <div class="text-xl font-semibold" :class="{ 'text-red-500': f === 'failed' && count(f), 'text-emerald-500': f === 'done', 'text-violet-500': f === 'generating', 'text-amber-500': f === 'stale' && count(f) }">{{ count(f) }}</div>
      </button>
    </div>
    <div class="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800">
      <span class="text-zinc-500">{{ chapter.title }} · {{ fmt(total) }} · {{ chapter.narration }}</span>
      <span class="ml-auto flex gap-2">
        <button v-if="count('stale') && chapter.narration !== 'running'" class="btn-primary btn-xs" @click="app.renarrateStale(bookId, chapterId)">↻ Re-narrate changed ({{ count('stale') }})</button>
        <button v-if="stats.failed && chapter.narration !== 'running'" class="btn-ghost btn-xs" @click="app.retryFailed(bookId, chapterId)">Retry failed ({{ stats.failed }})</button>
        <button v-if="chapter.narration !== 'running'" class="btn-ghost btn-xs" @click="app.runNarration(bookId, [chapterId])">Re-narrate all</button>
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full min-w-[640px] table-fixed text-sm">
        <thead class="sticky top-0 bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900"><tr><th class="w-10 px-3 py-2">#</th><th class="w-6"></th><th class="w-32">Speaker</th><th>Text</th><th class="w-28">Endpoint</th><th class="w-14 text-right">Took</th><th class="w-14 text-right">Audio</th><th class="w-28"></th></tr></thead>
        <tbody>
          <template v-for="s in rows" :key="s.id">
          <tr :id="'row-' + s.id" data-row tabindex="0" class="border-t border-zinc-100 outline-none focus-visible:bg-zinc-100 dark:border-zinc-800/70 dark:focus-visible:bg-zinc-800" :class="currentId === s.id && 'bg-violet-50 dark:bg-violet-500/10'" @keydown="onRowKey($event, s)">
            <td class="px-3 font-mono text-[11px] text-zinc-400">{{ s.id }}</td>
            <td><span class="inline-block h-2.5 w-2.5 rounded-full" :class="STATUS_BG[s.audio.status]" :title="s.audio.status"></span></td>
            <td class="py-1.5"><div class="flex items-center gap-1.5"><span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: colorOf(s.speaker) }"></span><span class="truncate">{{ s.speaker }}</span></div><div class="truncate pl-3.5 text-[10px] text-zinc-400">{{ voiceOf(s.speaker) }}</div></td>
            <td class="truncate py-1.5 pr-3 text-zinc-600 dark:text-zinc-300" :class="s.type === 'thought' && 'italic'"><div class="line-clamp-1">{{ s.text }}</div><div class="flex flex-wrap gap-2 text-[10px]"><span v-if="s.direction" class="text-violet-500">[{{ s.direction }}]</span><span v-if="s.audio.status === 'stale'" class="text-amber-600">{{ drift(s)[0] ?? 'edited after narration — audio is from the old script' }}</span><span v-if="s.fallback" class="text-amber-600">unverified chunk</span><span v-if="s.audio.error" class="text-red-500">{{ s.audio.error.code ? 'HTTP ' + s.audio.error.code + ' · ' : '' }}{{ s.audio.error.message }}<span v-if="s.audio.error.part"> (part {{ s.audio.error.part }}/{{ s.audio.parts }})</span></span></div></td>
            <td class="text-xs"><div class="truncate">{{ epName(s.audio.endpoint) }}</div><div v-if="s.audio.parts > 1" class="text-[10px] text-zinc-400">{{ s.audio.parts }} parts · {{ s.text.length }} ch</div></td>
            <td class="text-right font-mono text-xs text-zinc-500">{{ s.audio.ms ? (s.audio.ms / 1000).toFixed(1) + 's' : '' }}</td>
            <td class="text-right font-mono text-xs text-zinc-500">{{ s.audio.duration ? s.audio.duration.toFixed(1) + 's' : '' }}</td>
            <td class="pr-3 text-right whitespace-nowrap">
              <template v-if="s.audio.status === 'done' || s.audio.status === 'stale'">
                <button class="btn-ghost btn-xs" :title="'play this segment'" @click="play('seg' + s.id, s.audio.duration)">{{ p.id === 'seg' + s.id && p.playing ? '❚❚' : '▶' }}</button>
                <button class="ml-1 text-[11px] text-zinc-400 hover:text-violet-500" title="play chapter from here" @click="playFrom(s)">⇥</button>
              </template>
              <button v-else-if="s.audio.status === 'failed'" class="btn-primary btn-xs" @click="app.retrySegment(bookId, chapterId, s.id)">↻ retry</button>
              <span v-else-if="s.audio.status === 'generating'" class="text-[11px] text-violet-500">…</span>
              <button v-if="s.audio.at || s.audio.error || s.audio.cuts" class="ml-1 rounded border px-1 text-[10px]" :class="expanded.has(s.id) ? 'border-violet-400 text-violet-500' : 'border-zinc-300 text-zinc-400 hover:text-violet-500 dark:border-zinc-700'" title="render details (i)" @click="toggleDetails(s.id)">i</button>
            </td>
          </tr>
          <tr v-if="expanded.has(s.id)" class="bg-zinc-50 dark:bg-zinc-900/60">
            <td></td><td></td>
            <td colspan="6" class="px-2 py-2 pr-4 text-xs">
              <div v-if="s.audio.at" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <span class="text-zinc-400">rendered</span><span>{{ clock(s.audio.at) }} · {{ epName(s.audio.endpoint) }} · <span class="font-mono">{{ s.audio.model }}</span> · {{ s.audio.ms ? (s.audio.ms / 1000).toFixed(1) + 's' : '' }}<span v-if="s.audio.cost"> · ${{ s.audio.cost.toFixed(4) }}</span></span>
                <span class="text-zinc-400">voice</span><span>{{ app.voiceLabel(s.audio.voiceRef) || s.audio.voice }}</span>
                <span class="text-zinc-400">direction</span><span>{{ s.audio.direction || '—' }}<span v-if="s.audio.style" class="text-zinc-500"> · style: {{ s.audio.style }}</span> · {{ s.audio.type }}</span>
                <template v-if="drift(s).length"><span class="text-amber-600">differs now</span><span class="text-amber-600">{{ drift(s).join(' · ') }}</span></template>
              </div>
              <div v-if="s.audio.error" class="mt-1 rounded border border-red-300 bg-red-500/5 p-2 dark:border-red-500/40">
                <div class="flex items-center gap-2"><b class="text-red-600">{{ s.audio.error.code ? 'HTTP ' + s.audio.error.code : 'not sent' }}</b><span>{{ s.audio.error.message }}</span><span v-if="s.audio.error.at" class="text-zinc-400">· {{ clock(s.audio.error.at) }}</span><button class="ml-auto text-violet-500 hover:underline" @click="copyReq(s)">copy request</button></div>
                <pre v-if="s.audio.error.body" class="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-1.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{{ s.audio.error.body }}</pre>
              </div>
              <div v-if="s.audio.cuts" class="mt-1">
                <div class="mb-1 text-[10px] uppercase tracking-wider text-zinc-400">sent as {{ s.audio.cuts.length }} requests · cut at {{ AT[s.audio.splitAt] ?? s.audio.splitAt }} · joined after</div>
                <ol class="space-y-1">
                  <li v-for="(c, i) in s.audio.cuts" :key="i" class="flex gap-3"><span class="w-16 shrink-0 whitespace-nowrap font-mono text-[10px] text-zinc-400">{{ i + 1 }} · {{ c.to - c.from }} ch</span><span class="min-w-0 flex-1 text-zinc-600 dark:text-zinc-300">{{ s.text.slice(c.from, c.to) }}<span v-if="c.at" class="ml-2 font-mono text-[10px]" :class="c.fallback ? 'text-amber-600' : 'text-zinc-400'">⌁ {{ AT[c.at] }}{{ c.fallback ? ' (fallback)' : '' }}</span></span></li>
                </ol>
              </div>
            </td>
          </tr>
          </template>
        </tbody>
      </table>
      <div v-if="!rows.length" class="p-8 text-center text-sm text-zinc-500">No {{ filter }} segments.</div>
    </div>

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
