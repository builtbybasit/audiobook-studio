<script setup>
// Book overview: volumes, pipeline progress per stage, cast summary, latest exports, and what to do next.
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useApp, isScripted, isNarrated } from '../stores/app'

const app = useApp()
const bookId = useRoute().params.bookId
const router = useRouter()
const book = computed(() => app.bookById(bookId))
const chapters = computed(() => app.chaptersOf(bookId))
const p = computed(() => app.progress(bookId))
const cast = computed(() => app.charactersOf(bookId))
const unreviewed = computed(() => cast.value.filter(c => c.isNew).length)
const unvoiced = computed(() => cast.value.filter(c => !c.voice && c.major).length)
const suggestions = computed(() => app.mergeSuggestions(bookId).length)
const exportsHere = computed(() => app.exports.filter(e => e.bookId === bookId && e.status === 'done'))
const editing = ref(null), draft = ref(''), removing = ref(null)
const dragging = ref(null), dragOver = ref(null)
function drop(toIndex) { if (dragging.value != null) app.moveVolume(bookId, dragging.value, toIndex); dragging.value = null; dragOver.value = null }
function saveName(v) { app.renameVolume(bookId, v.id, draft.value); editing.value = null }
function remove(v) { const r = app.removeVolume(bookId, v.id); removing.value = null; if (r === 'book') router.push('/library') }
const budget = computed(() => book.value.budget ?? { cap: null, paused: false })
const spent = computed(() => app.spent(bookId))
const capInput = ref(book.value.budget?.cap ?? '')
function setCap() { app.setBudgetCap(bookId, Number(capInput.value) || null) }
const volStats = (v) => { const chs = chapters.value.filter(c => c.volumeId === v.id); return { n: chs.length, scripted: chs.filter(isScripted).length, narrated: chs.filter(isNarrated).length } }
const fmt = (s) => s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m` : `${Math.floor(s / 60)}m`
const runtime = computed(() => chapters.value.reduce((a, c) => a + c.duration, 0))

// the single most useful next action
const next = computed(() => {
  const failedS = chapters.value.filter(c => c.scripting === 'failed').length
  const failedN = chapters.value.filter(c => c.narration === 'failed').length
  if (p.value.scripted === 0) return { text: 'Nothing is scripted yet. Run scripting on the first few chapters to extract the cast.', to: 'scripting', label: 'Start scripting' }
  if (unreviewed.value) return { text: `${unreviewed.value} newly detected speaker${unreviewed.value > 1 ? 's' : ''} need${unreviewed.value > 1 ? '' : 's'} review — probably aliases to merge.`, to: 'cast', label: 'Review cast' }
  if (failedS) return { text: `${failedS} chapter${failedS > 1 ? 's' : ''} failed scripting.`, to: 'scripting', label: 'Retry scripting' }
  if (p.value.fallback) return { text: `${p.value.fallback} chapter${p.value.fallback > 1 ? 's' : ''} kept a chunk as plain narration because it didn’t verify.`, to: 'scripting', label: 'Inspect fallbacks' }
  if (unvoiced.value) return { text: `${unvoiced.value} main character${unvoiced.value > 1 ? 's' : ''} still use${unvoiced.value > 1 ? '' : 's'} the Narrator’s voice.`, to: 'narration', label: 'Assign voices' }
  if (p.value.stale) return { text: `${p.value.stale} chapter${p.value.stale > 1 ? 's' : ''} edited after narration — audio is stale.`, to: 'narration', label: 'Re-narrate changes' }
  if (failedN) return { text: `${failedN} chapter${failedN > 1 ? 's' : ''} have failed segments.`, to: 'narration', label: 'Retry narration' }
  if (p.value.narrated < p.value.scripted) return { text: `${p.value.scripted - p.value.narrated} scripted chapter${p.value.scripted - p.value.narrated > 1 ? 's are' : ' is'} not narrated yet.`, to: 'narration', label: 'Narrate' }
  if (p.value.scripted < p.value.total) return { text: `${p.value.total - p.value.scripted} chapter${p.value.total - p.value.scripted > 1 ? 's' : ''} still to script.`, to: 'scripting', label: 'Continue scripting' }
  const fresh = exportsHere.value.some(e => app.newSince(e).length)
  if (!exportsHere.value.length || fresh) return { text: fresh ? 'New chapters narrated since the last audiobook build.' : 'Everything is narrated. Build the audiobook.', to: 'export', label: fresh ? 'Rebuild audiobook' : 'Build audiobook' }
  return { text: 'This book is complete and exported.', to: 'export', label: 'Exports' }
})
</script>

<template>
  <div v-if="book" class="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
    <div class="flex flex-col gap-5 sm:flex-row">
      <div class="h-40 w-28 shrink-0 rounded-lg shadow-lg" :style="{ background: `linear-gradient(160deg, ${book.cover[0]}, ${book.cover[1]})` }"></div>
      <div class="min-w-0 flex-1">
        <h1 class="font-serif text-3xl">{{ book.title }}</h1>
        <div class="text-zinc-500">{{ book.author }} · {{ chapters.length }} chapters · {{ book.volumes.length }} volume{{ book.volumes.length > 1 ? 's' : '' }} · {{ cast.length }} speakers<span v-if="runtime"> · {{ fmt(runtime) }} narrated</span></div>
        <div class="mt-4 flex items-center gap-3 rounded-lg border border-violet-300 bg-violet-50 px-4 py-3 dark:border-violet-500/40 dark:bg-violet-500/10">
          <span class="text-lg">→</span>
          <span class="flex-1 text-sm">{{ next.text }}</span>
          <RouterLink :to="`/book/${bookId}/${next.to}`" class="btn-primary whitespace-nowrap">{{ next.label }}</RouterLink>
        </div>
      </div>
    </div>

    <div class="grid gap-4 sm:grid-cols-3">
      <RouterLink :to="`/book/${bookId}/scripting`" class="card p-4 hover:border-violet-400">
        <div class="flex items-baseline justify-between"><span class="label">1 · Scripting</span><span class="font-mono text-xs text-zinc-500">{{ p.scripted }}/{{ p.total }}</span></div>
        <div class="mt-2 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800"><div class="h-1.5 rounded bg-amber-500" :style="{ width: p.scripted / p.total * 100 + '%' }"></div></div>
        <div class="mt-2 text-xs text-zinc-500"><span v-if="p.fallback" class="text-amber-600">{{ p.fallback }} with fallback chunks · </span>{{ chapters.filter(c => c.scripting === 'failed').length }} failed</div>
      </RouterLink>
      <RouterLink :to="`/book/${bookId}/narration`" class="card p-4 hover:border-violet-400">
        <div class="flex items-baseline justify-between"><span class="label">2 · Narration</span><span class="font-mono text-xs text-zinc-500">{{ p.narrated }}/{{ p.total }}</span></div>
        <div class="mt-2 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800"><div class="h-1.5 rounded bg-sky-500" :style="{ width: p.narrated / p.total * 100 + '%' }"></div></div>
        <div class="mt-2 text-xs text-zinc-500"><span v-if="p.stale" class="text-amber-600">{{ p.stale }} stale · </span>{{ chapters.filter(c => c.narration === 'failed').length }} failed · {{ cast.filter(c => c.voice).length }}/{{ cast.length }} voiced</div>
      </RouterLink>
      <RouterLink :to="`/book/${bookId}/export`" class="card p-4 hover:border-violet-400">
        <div class="flex items-baseline justify-between"><span class="label">3 · Export</span><span class="font-mono text-xs text-zinc-500">{{ exportsHere.length }} file{{ exportsHere.length === 1 ? '' : 's' }}</span></div>
        <div v-if="exportsHere.length" class="mt-2 truncate font-mono text-xs">{{ exportsHere[0].filename }} <span class="text-zinc-400">v{{ exportsHere[0].version }}</span></div>
        <div v-else class="mt-2 text-xs text-zinc-500">No audiobook built yet.</div>
        <div class="mt-2 text-xs" :class="exportsHere.some(e => app.newSince(e).length) ? 'text-violet-500' : 'text-zinc-500'">{{ exportsHere.some(e => app.newSince(e).length) ? 'new chapters since last build' : (exportsHere.length ? 'up to date' : '') }}</div>
      </RouterLink>
    </div>

    <div class="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div class="card">
        <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"><span class="label">Volumes</span><span class="hidden text-[11px] text-zinc-400 sm:inline">drag or ▲▼ to reorder · chapters renumber to match</span><label class="ml-auto cursor-pointer text-xs text-zinc-400 hover:text-violet-500">＋ add volume<input type="file" accept=".epub" class="hidden" @change="e => app.addVolume(bookId, e.target.files?.[0]?.name ?? 'volume.epub')" /></label></div>
        <div v-for="(v, vi) in book.volumes" :key="v.id" class="border-b border-zinc-100 px-4 py-3 last:border-0 dark:border-zinc-800/70" :class="[dragOver === v.id && dragging !== v.id && 'bg-violet-50 dark:bg-violet-500/10', dragging === v.id && 'opacity-40']"
          draggable="true" @dragstart="dragging = v.id" @dragend="dragging = null; dragOver = null" @dragover.prevent="dragOver = v.id" @dragleave="dragOver === v.id && (dragOver = null)" @drop.prevent="drop(vi)">
          <div class="flex flex-wrap items-center gap-3">
          <span class="flex flex-col items-center text-zinc-300 dark:text-zinc-600">
            <button class="text-[10px] leading-none hover:text-violet-500 disabled:invisible" :disabled="vi === 0" title="move up" @click="app.moveVolume(bookId, v.id, vi - 1)">▲</button>
            <span class="cursor-grab select-none text-sm leading-none" title="drag to reorder">⋮⋮</span>
            <button class="text-[10px] leading-none hover:text-violet-500 disabled:invisible" :disabled="vi === book.volumes.length - 1" title="move down" @click="app.moveVolume(bookId, v.id, vi + 1)">▼</button>
          </span>
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-zinc-100 font-mono text-sm dark:bg-zinc-800">{{ vi + 1 }}</span>
          <div class="group min-w-0 flex-1">
            <form v-if="editing === v.id" class="flex items-center gap-1" @submit.prevent="saveName(v)">
              <input v-model="draft" class="input w-64 py-0.5 text-sm" autofocus @keydown.esc="editing = null" />
              <button class="btn-primary btn-xs" type="submit">Save</button><button class="btn-ghost btn-xs" type="button" @click="editing = null">Cancel</button>
            </form>
            <div v-else class="flex items-center gap-2"><span class="truncate text-sm font-medium">{{ v.name }}</span><button class="text-[11px] text-zinc-400 opacity-0 hover:text-violet-500 group-hover:opacity-100" title="rename volume" @click="editing = v.id; draft = v.name">rename</button></div>
            <div class="truncate font-mono text-[11px] text-zinc-400">{{ v.file }} · ch {{ v.from }}–{{ v.to }}</div>
          </div>
          <div class="w-full text-xs text-zinc-500 sm:w-40">
            <div class="flex justify-between"><span>scripted</span><span>{{ volStats(v).scripted }}/{{ volStats(v).n }}</span></div>
            <div class="h-1 rounded bg-zinc-200 dark:bg-zinc-800"><div class="h-1 rounded bg-amber-500" :style="{ width: volStats(v).scripted / volStats(v).n * 100 + '%' }"></div></div>
            <div class="mt-1 flex justify-between"><span>narrated</span><span>{{ volStats(v).narrated }}/{{ volStats(v).n }}</span></div>
            <div class="h-1 rounded bg-zinc-200 dark:bg-zinc-800"><div class="h-1 rounded bg-sky-500" :style="{ width: volStats(v).narrated / volStats(v).n * 100 + '%' }"></div></div>
          </div>
          <button class="text-[11px] text-zinc-400 hover:text-red-500" title="remove this volume (wrong EPUB?)" @click="removing = removing === v.id ? null : v.id">remove</button>
          </div>
          <div v-if="removing === v.id" class="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-red-300 bg-red-500/5 px-3 py-2 text-xs dark:border-red-500/40">
            <span>Remove <b>{{ v.name }}</b> ({{ v.file }})? Its {{ volStats(v).n }} chapters<template v-if="volStats(v).scripted"> · {{ volStats(v).scripted }} scripted</template><template v-if="volStats(v).narrated"> · {{ volStats(v).narrated }} narrated</template> are deleted and the rest are renumbered.<template v-if="book.volumes.length === 1"> This is the only volume, so the novel is removed from the library.</template></span>
            <span class="ml-auto flex gap-1"><button class="btn-ghost btn-xs" @click="removing = null">Keep</button><button class="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500" @click="remove(v)">Remove volume</button></span>
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <RouterLink :to="`/book/${bookId}/cast`" class="card block p-4 hover:border-violet-400">
          <div class="flex items-baseline justify-between"><span class="label">Cast</span><span class="text-xs text-zinc-500">open →</span></div>
          <div class="mt-2 flex flex-wrap gap-1">
            <span v-for="c in cast.filter(c => c.major).slice(0, 8)" :key="c.name" class="rounded-full px-2 py-0.5 text-xs" :style="{ background: c.color + '33', color: c.color }">{{ c.name }}</span>
            <span class="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">+{{ cast.filter(c => !c.major).length }} minor</span>
          </div>
          <div class="mt-2 text-xs text-zinc-500">
            <span v-if="unreviewed" class="text-amber-600">{{ unreviewed }} unreviewed · </span>
            <span v-if="suggestions" class="text-violet-500">{{ suggestions }} merge suggestion{{ suggestions > 1 ? 's' : '' }} · </span>
            {{ cast.filter(c => c.voice).length }} voiced
          </div>
        </RouterLink>
        <div class="card p-4">
          <div class="flex items-center justify-between"><span class="label">Budget</span><span class="text-xs" :class="budget.paused ? 'text-amber-600' : 'text-zinc-500'">{{ budget.paused ? '❚❚ paused' : 'running normally' }}</span></div>
          <div class="mt-2 flex items-baseline gap-2 text-sm"><b class="text-lg">${{ spent.toFixed(2) }}</b><span class="text-zinc-500">spent on narration so far</span></div>
          <div v-if="budget.cap" class="mt-1"><div class="h-1.5 rounded bg-zinc-200 dark:bg-zinc-800"><div class="h-1.5 rounded" :class="spent / budget.cap > 0.9 ? 'bg-red-500' : 'bg-amber-500'" :style="{ width: Math.min(100, spent / budget.cap * 100) + '%' }"></div></div><div class="mt-0.5 text-[11px] text-zinc-500">{{ Math.round(spent / budget.cap * 100) }}% of the ${{ budget.cap }} cap · runs that would cross it are blocked</div></div>
          <div class="mt-2 flex items-center gap-2 text-xs"><span class="text-zinc-500">Cap $</span><input v-model="capInput" type="number" min="0" step="1" class="input w-20 py-0.5" placeholder="none" @change="setCap" /><span class="text-zinc-400">per book, narration only</span></div>
          <button class="btn-ghost btn-xs mt-3 w-full justify-center" :class="budget.paused ? 'border-emerald-400 text-emerald-600' : 'border-amber-400 text-amber-600'" @click="budget.paused ? app.resumeBook(bookId) : app.pauseBook(bookId)">{{ budget.paused ? '▶ Resume this book' : '❚❚ Pause everything on this book' }}</button>
        </div>
        <div class="card p-4 text-xs text-zinc-500">
          <div class="label mb-1">Scripting profile</div>
          <div class="text-sm text-zinc-900 dark:text-zinc-100">{{ app.profiles.find(x => x.id === app.scriptSettings.profile)?.name }} · <span class="font-mono">{{ app.profiles.find(x => x.id === app.scriptSettings.profile)?.model }}</span></div>
          <div class="mt-1">{{ app.scriptSettings.chunkChars.toLocaleString() }} chars/chunk · watermarks {{ app.scriptSettings.stripWatermarks ? 'stripped' : 'kept' }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
