<script setup>
// Book-wide cast: every speaker across all chapters with line counts, first appearance, chapter spread,
// aliases and voice. Merge suggestions for near-duplicate names; bulk merge; rename inline.
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useApp } from '../stores/app'
import { UiSelect, UiCombobox, UiCheckbox } from '../ui'
import VoicePicker from '../components/VoicePicker.vue'
const castOpts = computed(() => cast.value.map(c => ({ value: c.name, label: c.name, color: c.color, keywords: c.aliases.join(' ') })))

const app = useApp()
const voiceOpts = computed(() => app.voiceOptions)
const bookId = useRoute().params.bookId
const cast = computed(() => app.charactersOf(bookId))
const stats = computed(() => app.castStats(bookId))
const suggestions = computed(() => app.mergeSuggestions(bookId))
const q = ref('')
const sort = ref('lines')
const onlyNew = ref(false)
const sel = ref(new Set())
const editing = ref(null); const draft = ref('')
const total = computed(() => app.chaptersOf(bookId).length)

const rows = computed(() => cast.value
  .filter(c => !q.value || c.name.toLowerCase().includes(q.value.toLowerCase()) || c.aliases.some(a => a.toLowerCase().includes(q.value.toLowerCase())))
  .filter(c => !onlyNew.value || c.isNew)
  .map(c => ({ c, st: stats.value[c.name] ?? { lines: 0, chapters: new Set(), first: null } }))
  .sort((a, b) => sort.value === 'lines' ? b.st.lines - a.st.lines : sort.value === 'first' ? (a.st.first ?? 999) - (b.st.first ?? 999) : a.c.name.localeCompare(b.c.name)))

function toggle(name) { const s = new Set(sel.value); s.has(name) ? s.delete(name) : s.add(name); sel.value = s }
function mergeSelectedInto(into) { app.mergeMany(bookId, [...sel.value], into); sel.value = new Set() }
const pickers = ref({})
function onRowKey(e, c) {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.closest('[role=dialog],[role=listbox]')) return
  const list = [...e.currentTarget.parentElement.querySelectorAll('tr[data-row]')]; const i = list.indexOf(e.currentTarget)
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); list[i + 1]?.focus() }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); list[i - 1]?.focus() }
  else if (e.key === 'v') { e.preventDefault(); const pk = pickers.value[c.name]; if (pk) pk.open = true }
  else if (e.key === 'Enter') { e.preventDefault(); startRename(c) }
  else if (e.key === 'x' && c.name !== 'Narrator') { e.preventDefault(); toggle(c.name) }
}
function startRename(c) { editing.value = c.name; draft.value = c.name }
function commit() { if (editing.value) app.renameCharacter(bookId, editing.value, draft.value); editing.value = null }
const genderLabel = { m: 'male', f: 'female', n: 'neutral', '?': 'unknown' }
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-4 p-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div><h1 class="text-2xl font-semibold">Cast</h1><p class="text-sm text-zinc-500">{{ cast.length }} speakers across {{ total }} chapters · {{ cast.filter(c => c.isNew).length }} unreviewed · {{ cast.filter(c => c.voice).length }} voiced · <kbd class="rounded border border-zinc-200 px-1 font-mono text-[10px] dark:border-zinc-700">j</kbd>/<kbd class="rounded border border-zinc-200 px-1 font-mono text-[10px] dark:border-zinc-700">k</kbd> <kbd class="rounded border border-zinc-200 px-1 font-mono text-[10px] dark:border-zinc-700">v</kbd> voice <kbd class="rounded border border-zinc-200 px-1 font-mono text-[10px] dark:border-zinc-700">x</kbd> tick</p></div>
      <div class="flex flex-wrap items-center gap-2">
        <input v-model="q" class="input w-48" placeholder="Find a speaker…" />
        <label class="flex items-center gap-1.5 text-xs"><UiCheckbox v-model="onlyNew" /> unreviewed only</label>
        <UiSelect v-model="sort" :options="[{ value: 'lines', label: 'Most lines' }, { value: 'first', label: 'First appearance' }, { value: 'name', label: 'Name' }]" />
      </div>
    </div>

    <div v-if="suggestions.length" class="card border-violet-300 dark:border-violet-500/40">
      <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"><span class="label">Merge suggestions</span><span class="text-xs text-zinc-400">{{ suggestions.length }}</span>
        <button class="ml-auto text-xs text-violet-500 hover:underline" @click="suggestions.forEach(s => app.mergeCharacter(bookId, s.from, s.into))">accept all</button></div>
      <div v-for="s in suggestions" :key="s.from" class="flex items-center gap-3 border-b border-zinc-100 px-4 py-2 text-sm last:border-0 dark:border-zinc-800/70">
        <span class="rounded-full px-2 py-0.5 text-xs" :style="{ background: (cast.find(c => c.name === s.from)?.color ?? '#999') + '33' }">{{ s.from }}</span>
        <span class="text-zinc-400">→</span>
        <span class="rounded-full px-2 py-0.5 text-xs" :style="{ background: (cast.find(c => c.name === s.into)?.color ?? '#999') + '33' }">{{ s.into }}</span>
        <span class="min-w-0 flex-1 truncate text-xs text-zinc-500">{{ s.reason }} · {{ stats[s.from]?.lines ?? 0 }} lines would move</span>
        <button class="btn-primary btn-xs" @click="app.mergeCharacter(bookId, s.from, s.into)">Merge</button>
        <button class="btn-ghost btn-xs" @click="app.characters[bookId].find(c => c.name === s.from).isNew = false; app.characters[bookId].find(c => c.name === s.from).keep = true">Keep separate</button>
      </div>
    </div>

    <div v-if="sel.size" class="flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-4 py-2 text-sm dark:border-violet-500/40 dark:bg-violet-500/10">
      <b>{{ sel.size }} selected</b> → merge into
      <UiCombobox action :options="castOpts.filter(o => !sel.has(o.value))" placeholder="choose a speaker…" size="xs" class="w-56" @pick="mergeSelectedInto" />
      <button class="ml-auto text-xs text-zinc-500" @click="sel = new Set()">clear</button>
    </div>

    <div class="card overflow-x-auto">
      <table class="w-full min-w-[760px] text-sm">
        <thead class="bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900"><tr><th class="w-8 px-3 py-2"></th><th>Speaker</th><th class="w-20">Gender</th><th class="w-16 pr-4 text-right">Lines</th><th class="w-44 pl-2">Chapters</th><th class="w-52">Voice</th><th class="w-24"></th></tr></thead>
        <tbody>
          <tr v-for="{ c, st } in rows" :key="c.name" data-row tabindex="0" class="border-t border-zinc-100 outline-none focus-visible:bg-zinc-100 dark:border-zinc-800/70 dark:focus-visible:bg-zinc-800" :class="c.isNew && 'bg-amber-400/5'" @keydown="onRowKey($event, c)">
            <td class="px-3"><UiCheckbox v-if="c.name !== 'Narrator'" :model-value="sel.has(c.name)" @update:model-value="toggle(c.name)" /></td>
            <td class="py-2">
              <div class="flex items-center gap-2">
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: c.color }"></span>
                <input v-if="editing === c.name" v-model="draft" class="input py-0" autofocus @keydown.enter="commit" @keydown.esc="editing = null" @blur="commit" />
                <b v-else class="cursor-text" @dblclick="startRename(c)">{{ c.name }}</b>
                <span v-if="c.isNew" class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600">new</span>
                <span v-if="!c.major && !c.isNew" class="rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800">minor</span>
              </div>
              <div class="pl-4.5 text-[11px] text-zinc-500"><span v-if="c.aliases.length">a.k.a. {{ c.aliases.join(', ') }}</span><span v-if="c.description" class="ml-1 italic opacity-70">· {{ c.description.slice(0, 70) }}{{ c.description.length > 70 ? '…' : '' }}</span></div>
            </td>
            <td class="text-xs text-zinc-500">{{ genderLabel[c.gender] ?? 'unknown' }}</td>
            <td class="pr-4 text-right font-mono text-xs">{{ st.lines }}</td>
            <td class="pl-2">
              <div class="flex h-3 gap-px" :title="`in ${st.chapters.size} chapters, first in ch ${st.first ?? '—'}`">
                <span v-for="i in total" :key="i" class="flex-1 rounded-sm" :class="st.chapters.has(i) ? 'bg-violet-500' : 'bg-zinc-200 dark:bg-zinc-800'"></span>
              </div>
              <div class="text-[10px] text-zinc-400">{{ st.chapters.size }} ch · first ch {{ st.first ?? '—' }}</div>
            </td>
            <td class="py-1 pr-2"><VoicePicker :ref="el => pickers[c.name] = el" v-model="c.voice" :book-id="bookId" :speaker="c.name" size="xs" block /></td>
            <td class="pr-3 text-right">
              <button class="text-xs text-zinc-400 hover:text-violet-500" @click="startRename(c)">rename</button>
              <button v-if="c.name !== 'Narrator'" class="ml-2 text-xs text-zinc-400 hover:text-red-500" @click="app.deleteCharacter(bookId, c.name)" title="Merge into Narrator">✕</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
