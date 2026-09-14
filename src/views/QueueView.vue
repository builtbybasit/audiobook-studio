<script setup>
// Queue: every job across every book. Running now (with live detail), the pending queue (cancellable),
// endpoint utilisation, and history with retry. A clock tick keeps elapsed times moving.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useApp } from '../stores/app'
import StatusDot from '../components/StatusDot.vue'

const app = useApp()
const now = ref(Date.now())
let t
onMounted(() => { t = setInterval(() => now.value = Date.now(), 500) })
onUnmounted(() => clearInterval(t))

const icon = { scripting: '✎', narration: '♪', export: '⤓' }
const running = computed(() => app.jobs.filter(j => j.status === 'running'))
const queued = computed(() => app.jobs.filter(j => j.status === 'queued'))
const history = computed(() => app.jobs.filter(j => j.finishedAt).sort((a, b) => b.finishedAt - a.finishedAt))
const counts = computed(() => ({ running: running.value.length, queued: queued.value.length, done: app.jobs.filter(j => j.status === 'done').length, failed: app.jobs.filter(j => j.status === 'failed').length }))
const filter = ref('all')
const retryable = computed(() => history.value.filter(j => j.status === 'failed' && j.kind !== 'export' && chapter(j)?.[j.kind] === 'failed').length)
const shown = computed(() => filter.value === 'all' ? history.value : history.value.filter(j => j.status === filter.value))

const book = (j) => app.bookById(j.bookId)
const chapter = (j) => j.chapterId ? app.chapter(j.bookId, j.chapterId) : null
const elapsed = (j) => fmtDur(((j.finishedAt ?? now.value) - (j.startedAt ?? now.value)) / 1000)
const fmtDur = (s) => s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
function segStats(j) {
  const segs = app.segmentsOf(j.bookId, j.chapterId)
  return { total: segs.length, done: segs.filter(s => s.audio.status === 'done').length, gen: segs.filter(s => s.audio.status === 'generating').length, failed: segs.filter(s => s.audio.status === 'failed').length }
}
const stageLink = (j) => `/book/${j.bookId}/${j.kind === 'export' ? 'export' : j.kind}`
const eta = computed(() => { now.value; return app.eta })
const finishAt = computed(() => eta.value ? new Date(eta.value.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null)
const canNotify = 'Notification' in window
async function toggleNotify() {
  if (app.notify) { app.notify = false; return }
  if (canNotify && Notification.permission !== 'granted') { const r = await Notification.requestPermission(); if (r !== 'granted') { app.toast('Browser notifications are blocked — you will still get in-app toasts', { kind: 'warn' }); } }
  app.notify = true
}
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Queue</h1>
        <p class="text-sm text-zinc-500">Every job across the library. Chapters of one book run in order; endpoints work in parallel within a chapter.</p>
      </div>
      <div class="flex items-center gap-3 text-xs">
        <span v-if="eta" class="rounded-md bg-violet-50 px-2 py-1 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">≈ finishes at <b>{{ finishAt }}</b> · in {{ fmtDur(eta.seconds) }}<span v-if="eta.books > 1"> · {{ eta.books }} books in parallel</span></span>
        <button class="btn-ghost btn-xs" :class="app.notify && 'border-violet-400 text-violet-600'" @click="toggleNotify">{{ app.notify ? '🔔 notifying when a book finishes' : '🔕 notify me when a book finishes' }}</button>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="card p-4"><div class="label">Running</div><div class="text-2xl font-semibold text-violet-500">{{ counts.running }}</div></div>
      <div class="card p-4"><div class="label">Queued</div><div class="text-2xl font-semibold">{{ counts.queued }}</div></div>
      <div class="card p-4"><div class="label">Done</div><div class="text-2xl font-semibold text-emerald-500">{{ counts.done }}</div></div>
      <div class="card p-4"><div class="label">Failed</div><div class="text-2xl font-semibold" :class="counts.failed ? 'text-red-500' : ''">{{ counts.failed }}</div></div>
    </div>

    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div class="min-w-0 space-y-5">
        <!-- running -->
        <section class="card">
          <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"><span class="label">Running now</span><span class="text-xs text-zinc-400">{{ running.length }}</span>
            <button v-if="app.activeJobs.length" class="ml-auto whitespace-nowrap text-xs text-zinc-400 hover:text-red-500" @click="app.cancelAll()">cancel all ({{ app.activeJobs.length }})</button></div>
          <div v-if="!running.length" class="px-4 py-6 text-sm text-zinc-500">Idle. Start scripting, narration, or an export from a book.</div>
          <div v-for="j in running" :key="j.id" class="border-b border-zinc-100 px-4 py-3 last:border-0 dark:border-zinc-800/70">
            <div class="flex items-center gap-3">
              <span class="grid h-8 w-8 place-items-center rounded-lg bg-violet-500/15 text-violet-500">{{ icon[j.kind] }}</span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 text-sm"><b class="capitalize">{{ j.kind }}</b><span class="truncate text-zinc-500">· {{ book(j)?.title }}<span v-if="chapter(j)"> · ch {{ chapter(j).id }} {{ chapter(j).title }}</span></span></div>
                <div class="mt-1.5 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800"><div class="h-1.5 rounded bg-violet-500 transition-all" :style="{ width: j.progress + '%' }"></div></div>
              </div>
              <div class="w-24 text-right font-mono text-xs text-zinc-500">{{ Math.round(j.progress) }}% · {{ elapsed(j) }}</div>
              <RouterLink :to="stageLink(j)" class="btn-ghost btn-xs">Open</RouterLink>
              <button class="btn-ghost btn-xs text-red-500" @click="app.cancelJob(j.id)">Cancel</button>
            </div>
            <div v-if="j.kind === 'narration'" class="mt-2 flex gap-3 pl-11 text-xs text-zinc-500">
              <span><b class="text-emerald-500">{{ segStats(j).done }}</b> done</span>
              <span><b class="text-violet-500">{{ segStats(j).gen }}</b> generating</span>
              <span><b :class="segStats(j).failed && 'text-red-500'">{{ segStats(j).failed }}</b> failed</span>
              <span>of {{ segStats(j).total }} segments</span>
            </div>
          </div>
        </section>

        <!-- queued -->
        <section class="card">
          <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"><span class="label">Up next</span><span class="text-xs text-zinc-400">{{ queued.length }}</span>
            <button v-if="queued.length" class="ml-auto whitespace-nowrap text-xs text-zinc-400 hover:text-red-500" @click="queued.forEach(j => app.cancelJob(j.id))">cancel queued</button></div>
          <div v-if="!queued.length" class="px-4 py-4 text-sm text-zinc-500">Nothing waiting.</div>
          <div v-for="(j, i) in queued" :key="j.id" class="flex items-center gap-3 border-b border-zinc-100 px-4 py-2 text-sm last:border-0 dark:border-zinc-800/70">
            <span class="w-5 font-mono text-xs text-zinc-400">{{ i + 1 }}</span>
            <span class="w-4 text-center text-zinc-400">{{ icon[j.kind] }}</span>
            <span class="min-w-0 flex-1 truncate">{{ j.label }} <span class="text-zinc-500">· {{ book(j)?.title }}</span></span>
            <button class="text-xs text-zinc-400 hover:text-red-500" @click="app.cancelJob(j.id)">cancel</button>
            <button class="text-xs text-zinc-400 hover:text-red-500" title="Cancel and remove" @click="app.removeJob(j.id)">✕</button>
          </div>
        </section>

        <!-- history -->
        <section class="card">
          <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
            <span class="label">History</span>
            <div class="ml-3 flex gap-1">
              <button v-for="f in ['all', 'done', 'failed', 'cancelled']" :key="f" class="rounded px-2 py-0.5 text-xs capitalize" :class="filter === f ? 'bg-zinc-200 dark:bg-zinc-700' : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'" @click="filter = f">{{ f }}</button>
            </div>
            <div class="ml-auto flex items-center gap-3 whitespace-nowrap text-xs">
              <button v-if="retryable" class="text-violet-500 hover:underline" @click="app.retryAllFailed()">↻ retry failed ({{ retryable }})</button>
              <button v-if="history.length" class="text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" @click="app.clearFinished()">clear</button>
            </div>
          </div>
          <div v-if="!shown.length" class="px-4 py-4 text-sm text-zinc-500">No {{ filter === 'all' ? '' : filter }} jobs yet.</div>
          <table v-else class="w-full text-sm">
            <tbody>
              <tr v-for="j in shown" :key="j.id" class="border-b border-zinc-100 last:border-0 dark:border-zinc-800/70">
                <td class="w-8 py-2 pl-4"><StatusDot :status="j.status === 'cancelled' ? 'none' : j.status" /></td>
                <td class="w-6 text-zinc-400">{{ icon[j.kind] }}</td>
                <td class="py-2"><div>{{ j.label }}</div><div class="text-xs text-zinc-500">{{ book(j)?.title }}</div></td>
                <td class="w-24 text-xs capitalize" :class="{ 'text-emerald-500': j.status === 'done', 'text-red-500': j.status === 'failed', 'text-zinc-400': j.status === 'cancelled' }">{{ j.status }}</td>
                <td class="w-20 text-right font-mono text-xs text-zinc-500">{{ elapsed(j) }}</td>
                <td class="w-24 text-right font-mono text-xs text-zinc-400">{{ clock(j.finishedAt) }}</td>
                <td class="w-28 pr-4 text-right">
                  <button v-if="j.status !== 'done' && j.kind !== 'export'" class="btn-ghost btn-xs" @click="app.retryJob(j.id)">↻ Retry</button>
                  <button class="ml-1 rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-red-500 dark:hover:bg-zinc-800" title="Remove from history" @click="app.removeJob(j.id)">✕</button>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <!-- endpoints -->
      <aside class="space-y-3">
        <div class="card p-4">
          <div class="label mb-3">Endpoint pool</div>
          <div v-for="e in app.endpoints" :key="e.id" class="mb-3 last:mb-0">
            <div class="flex items-center gap-2 text-sm">
              <span class="h-2 w-2 rounded-full" :class="e.enabled ? 'bg-emerald-500' : 'bg-zinc-400'"></span>
              <span class="min-w-0 flex-1 truncate" :class="!e.enabled && 'text-zinc-400'">{{ e.name }}</span>
              <span v-if="e.backoffUntil > Date.now()" class="text-[10px] text-violet-500">backing off</span>
              <span class="font-mono text-xs text-zinc-500">{{ app.endpointLoad[e.id].active }}/{{ e.concurrency }}</span>
            </div>
            <div class="mt-1 flex gap-0.5">
              <div v-for="i in e.concurrency" :key="i" class="h-1.5 flex-1 rounded-sm" :class="i <= app.endpointLoad[e.id].active ? 'bg-violet-500 animate-pulse' : 'bg-zinc-200 dark:bg-zinc-800'"></div>
            </div>
            <div class="mt-1 text-[11px] text-zinc-500">{{ app.endpointLoad[e.id].done }} segments done · {{ app.endpointLoad[e.id].failed }} failed · {{ e.price ? '$' + e.price + '/1M' : 'free' }}</div>
          </div>
          <RouterLink v-if="app.currentBookId" :to="`/book/${app.currentBookId}/narration`" class="btn-ghost btn-xs mt-2 w-full justify-center">Manage endpoints</RouterLink>
        </div>
        <div class="card p-4 text-xs leading-relaxed text-zinc-500">
          <div class="label mb-1">Rules</div>
          One book's chapters run <b>sequentially</b> so roster and recap carry forward. Different books can run at the same time. Within a chapter, each segment goes to the endpoint that owns its speaker’s voice, up to that endpoint’s concurrency; segments over an endpoint’s character limit are sent in parts.
        </div>
      </aside>
    </div>
  </div>
</template>
