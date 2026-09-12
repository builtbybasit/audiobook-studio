<script setup>
// Variant B — "Grid": every segment is a row; speaker/type/direction are editable cells.
// Row selection + a bulk bar for reassigning many lines at once. ↑/↓ moves focus.
import { computed, ref } from 'vue'
import { useScript, TYPES, TYPE_GLYPH } from './shared'
import CastPanel from './CastPanel.vue'
import { DIRECTIONS } from '../../mock/data'

const props = defineProps({ bookId: String, chapterId: Number })
const { app, segments, cast, counts, inChapter, colorOf } = useScript(props)
const sel = ref(new Set())
const filter = ref(null)
const focus = ref(null)
const rows = computed(() => filter.value ? segments.value.filter(s => s.speaker === filter.value) : segments.value)

function toggle(id, e) {
  const set = new Set(sel.value)
  if (e?.shiftKey && focus.value) {
    const ids = rows.value.map(r => r.id); const a = ids.indexOf(focus.value), b = ids.indexOf(id)
    ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(i => set.add(i))
  } else set.has(id) ? set.delete(id) : set.add(id)
  sel.value = set; focus.value = id
}
function bulk(speaker) { for (const id of sel.value) app.setSpeaker(props.bookId, props.chapterId, id, speaker); sel.value = new Set() }
function bulkDir(d) { for (const id of sel.value) app.updateSegment(props.bookId, props.chapterId, id, { direction: d }) }
function onKey(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return
  const ids = rows.value.map(r => r.id); const i = ids.indexOf(focus.value)
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); focus.value = ids[Math.min(ids.length - 1, i + 1)] }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); focus.value = ids[Math.max(0, i - 1)] }
  if (e.key === ' ' && focus.value) { e.preventDefault(); toggle(focus.value) }
  const n = parseInt(e.key); if (n && sel.value.size && inChapter.value[n - 1]) bulk(inChapter.value[n - 1].name)
}
</script>

<template>
  <div class="card flex h-full min-h-0 flex-col" tabindex="0" @keydown="onKey">
    <div class="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div class="flex flex-wrap items-center gap-1">
        <button class="rounded-full border px-2 py-0.5 text-xs" :class="!filter ? 'border-violet-500 bg-violet-500/10' : 'border-zinc-300 dark:border-zinc-700'" @click="filter = null">All · {{ segments.length }}</button>
        <button v-for="(c, i) in inChapter" :key="c.name" class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs" :class="filter === c.name ? 'border-violet-500 bg-violet-500/10' : 'border-zinc-300 dark:border-zinc-700'" @click="filter = filter === c.name ? null : c.name">
          <kbd class="rounded bg-zinc-200 px-1 font-mono text-[10px] dark:bg-zinc-700">{{ i + 1 }}</kbd>
          <span class="h-2 w-2 rounded-full" :style="{ background: c.color }"></span>{{ c.name }} <span class="text-zinc-400">{{ counts[c.name] }}</span>
          <span v-if="c.isNew" class="text-amber-500">●</span>
        </button>
      </div>
      <details class="relative ml-auto">
        <summary class="btn-ghost btn-xs cursor-pointer list-none">Manage cast ▾</summary>
        <div class="card absolute right-0 top-8 z-20 w-72 p-2 shadow-xl"><CastPanel :book-id="bookId" :characters="cast" :counts="app.lineCounts(bookId)" /></div>
      </details>
    </div>

    <div v-if="sel.size" class="flex items-center gap-2 border-b border-violet-300 bg-violet-50 px-3 py-1.5 text-xs dark:border-violet-500/40 dark:bg-violet-500/10">
      <b>{{ sel.size }} selected</b> → assign to
      <button v-for="c in inChapter" :key="c.name" class="btn-ghost btn-xs" @click="bulk(c.name)"><span class="h-2 w-2 rounded-full" :style="{ background: c.color }"></span>{{ c.name }}</button>
      <select class="input ml-2 py-0.5 text-xs" @change="bulk($event.target.value)"><option disabled selected>other…</option><option v-for="c in cast" :key="c.name">{{ c.name }}</option></select>
      <input class="input ml-2 w-44 py-0.5 text-xs" placeholder="set direction…" list="dirs" @change="bulkDir($event.target.value)" />
      <button class="ml-auto text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100" @click="sel = new Set()">clear</button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900">
          <tr><th class="w-8 px-3 py-2"></th><th class="w-8">#</th><th class="w-40">Speaker</th><th class="w-24">Type</th><th class="w-44">Direction</th><th>Text</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in rows" :key="s.id" class="border-t border-zinc-100 dark:border-zinc-800/70"
            :class="[sel.has(s.id) && 'bg-violet-50 dark:bg-violet-500/10', focus === s.id && 'outline outline-1 -outline-offset-1 outline-violet-400']"
            @click="focus = s.id">
            <td class="px-3 py-1"><input type="checkbox" class="accent-violet-600" :checked="sel.has(s.id)" @click.stop="toggle(s.id, $event)" /></td>
            <td class="font-mono text-[11px] text-zinc-400">{{ s.id }}</td>
            <td class="py-1 pr-2">
              <div class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: colorOf(s.speaker) }"></span>
                <select :value="s.speaker" class="w-full bg-transparent py-0.5 focus:outline-none" @change="app.setSpeaker(bookId, chapterId, s.id, $event.target.value)"><option v-for="c in cast" :key="c.name">{{ c.name }}</option></select></div>
            </td>
            <td class="pr-2"><select v-model="s.type" class="w-full bg-transparent py-0.5 text-xs focus:outline-none"><option v-for="t in TYPES" :key="t" :value="t">{{ TYPE_GLYPH[t] }} {{ t }}</option></select></td>
            <td class="pr-2"><input v-model="s.direction" list="dirs" class="w-full bg-transparent py-0.5 text-xs text-violet-500 placeholder-zinc-300 focus:outline-none dark:placeholder-zinc-700" placeholder="—" /></td>
            <td class="py-1 pr-3" :class="s.type === 'thought' && 'italic text-zinc-500'"><span v-if="s.type === 'dialogue'">“{{ s.text }}”</span><span v-else>{{ s.text }}</span></td>
          </tr>
        </tbody>
      </table>
      <datalist id="dirs"><option v-for="d in DIRECTIONS" :key="d" :value="d" /></datalist>
    </div>
    <div class="border-t border-zinc-200 px-3 py-1 text-[11px] text-zinc-500 dark:border-zinc-800">↑↓ / j k move · space select · shift-click range · 1-9 assign selection to that speaker</div>
  </div>
</template>
