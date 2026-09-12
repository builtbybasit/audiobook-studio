<script setup>
// Script reader: narration flows as prose; dialogue and thought are lifted into cards with a
// speaker pill and the voice direction. Right rail (toggleable) = the cast *in this chapter* with
// aliases, spoiler-hidden descriptions and inline rename/merge; the rest of the cast is collapsed.
// Any segment can be clicked to edit speaker / type / direction in place. Typography via the Aa menu.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useScript, TYPES } from './shared'
import { DIRECTIONS } from '../../mock/data'
import { useReader } from '../../stores/reader'
import ReaderSettings from '../../components/ReaderSettings.vue'
import { UiSelect, UiCombobox, UiToggleGroup, UiTooltip } from '../../ui'
const typeOpts = TYPES.map(t => ({ value: t, label: t }))
const speakerOpts = computed(() => [...inChapter.value.map(c => ({ value: c.name, label: c.name, color: c.color, group: 'In this chapter', hint: counts.value[c.name] + ' lines', keywords: c.aliases.join(' ') })), ...rest.value.map(c => ({ value: c.name, label: c.name, color: c.color, group: 'Rest of cast', keywords: c.aliases.join(' ') }))])
const filterOpts = computed(() => [{ value: '', label: 'All speakers' }, ...inChapter.value.map(c => ({ value: c.name, label: c.name, color: c.color, hint: counts.value[c.name] + '' }))])

const props = defineProps({ bookId: String, chapterId: Number })
const { app, segments, cast, counts, inChapter, colorOf } = useScript(props)
const reader = useReader()
const volume = computed(() => app.volumeOf(props.bookId, props.chapterId))
const multiVolume = computed(() => app.volumesOf(props.bookId).length > 1)

const mode = ref('all')          // all | dialogue
const speaker = ref('')          // '' = everyone
const open = ref(null)
const showRest = ref(false)
const revealed = ref(new Set())
const editingName = ref(null)
const draft = ref('')

const rows = computed(() => segments.value.filter(s =>
  (mode.value === 'all' || s.type !== 'narration') && (!speaker.value || s.speaker === speaker.value)))
const rest = computed(() => cast.value.filter(c => !counts.value[c.name]))
const chapter = computed(() => app.chapter(props.bookId, props.chapterId))
const chars = computed(() => segments.value.reduce((a, s) => a + s.text.length, 0))

function jumpToSpeaker(name) { speaker.value = speaker.value === name ? '' : name }
function startRename(c) { editingName.value = c.name; draft.value = c.name }
function commitRename() { if (editingName.value) app.renameCharacter(props.bookId, editingName.value, draft.value); editingName.value = null }
function nextNew() {
  const s = segments.value.find(s => cast.value.find(c => c.name === s.speaker)?.isNew)
  if (s) { open.value = s.id; document.getElementById('seg-' + s.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }
}
const unresolved = computed(() => inChapter.value.filter(c => c.isNew).length)
const fallbacks = computed(() => segments.value.filter(s => s.fallback))

// keyboard: j/k or ↑/↓ move, Enter edit, Esc close, 1–9 assign speaker (in-chapter order), c toggles cast
const focus = ref(null)
function moveFocus(d) {
  const ids = rows.value.map(r => r.id); const i = ids.indexOf(focus.value)
  focus.value = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + d))] ?? null
  document.getElementById('seg-' + focus.value)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
function onKey(e) {
  const t = e.target
  // inside a field: let the widget (combobox/select) handle Escape itself; a second Escape closes the editor
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable || t.closest?.('[role=listbox],[role=option]')) { if (e.key === 'Escape' && t.getAttribute('role') !== 'combobox') t.blur(); return }
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveFocus(1) }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveFocus(-1) }
  else if (e.key === 'Enter' && focus.value) { open.value = open.value === focus.value ? null : focus.value }
  else if (e.key === 'Escape') { open.value = null }
  else if (e.key === 'c') { reader.showCast = !reader.showCast }
  else if (/^[1-9]$/.test(e.key) && focus.value) { const c = inChapter.value[Number(e.key) - 1]; if (c) app.setSpeaker(props.bookId, props.chapterId, focus.value, c.name) }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
watch(open, v => { if (v) focus.value = v })
</script>

<template>
  <div class="grid h-full gap-4" :class="reader.showCast ? 'grid-cols-[1fr_300px]' : 'grid-cols-1'">
    <!-- reader -->
    <div class="card flex min-h-0 min-w-0 flex-col">
      <div class="border-b border-zinc-200 px-6 pb-3 pt-4 dark:border-zinc-800">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="label"><span v-if="multiVolume">{{ volume?.name }} · </span>Chapter {{ chapter.id }}<span v-if="multiVolume" class="font-normal normal-case tracking-normal text-zinc-400"> (ch. {{ chapter.volumeIndex }} of this volume)</span></div>
            <h2 class="truncate font-serif text-2xl">{{ chapter.title }}</h2>
            <div class="mt-0.5 text-xs text-zinc-500">{{ segments.length }} segments · {{ inChapter.length }} speakers · {{ (chars / 1000).toFixed(1) }}k chars · <span class="font-mono">chapter_{{ String(chapter.id).padStart(3, '0') }}.json</span></div>
          </div>
          <button v-if="unresolved" class="btn-ghost btn-xs border-amber-400 text-amber-600" @click="nextNew">⚠ {{ unresolved }} unreviewed speaker{{ unresolved > 1 ? 's' : '' }} → jump</button>
          <button class="btn-ghost btn-xs" :class="reader.showCast && 'bg-zinc-200 dark:bg-zinc-800'" @click="reader.showCast = !reader.showCast">☺ Cast <span class="text-zinc-400">{{ inChapter.length }}</span></button>
          <ReaderSettings />
        </div>
        <div class="mt-3 flex items-center gap-2">
          <UiToggleGroup v-model="mode" :options="[{ value: 'all', label: 'Everything' }, { value: 'dialogue', label: 'Dialogue only' }]" />
          <UiSelect v-model="speaker" :options="filterOpts" size="xs" class="w-44" />
          <span class="ml-auto text-[11px] text-zinc-400">{{ rows.length }} shown · click any line to edit</span>
        </div>
      </div>

      <div v-if="fallbacks.length" class="flex items-center gap-3 border-b border-amber-300 bg-amber-400/10 px-6 py-2 text-xs text-amber-700 dark:border-amber-500/40 dark:text-amber-300">
        <span>⚠</span>
        <span class="flex-1"><b>{{ fallbacks.length }} chunk{{ fallbacks.length > 1 ? 's' : '' }} didn’t verify</b> — the model’s split couldn’t be matched back to the source text, so {{ fallbacks.length > 1 ? 'they were' : 'it was' }} kept whole and will be read by the Narrator. Nothing is missing from the audio, but dialogue inside won’t get character voices.</span>
        <button class="btn-ghost btn-xs border-amber-400" @click="document.getElementById('seg-' + fallbacks[0].id)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); focus = fallbacks[0].id">Show</button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div class="mx-auto" :class="[reader.widthClass, reader.fontClass]" :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }">
          <template v-for="s in rows" :key="s.id">
            <!-- unverified chunk kept whole -->
            <div v-if="s.fallback" :id="'seg-' + s.id" class="mb-3 rounded-lg border border-dashed border-amber-400 bg-amber-400/5 px-4 py-3" :class="focus === s.id && 'ring-2 ring-amber-400'">
              <div class="mb-1 flex items-center gap-2 font-sans text-xs leading-normal">
                <span class="rounded bg-amber-400/20 px-1.5 py-0.5 font-semibold text-amber-700 dark:text-amber-300">unverified chunk · read as narration</span>
                <span class="text-zinc-500">~{{ s.fallbackCount }} segments collapsed</span>
                <span v-if="s.fallbackRetrying" class="ml-auto text-violet-500">re-splitting…</span>
                <button v-else class="btn-ghost btn-xs ml-auto" @click="app.retryChunk(bookId, chapterId, s.id)">↻ Re-split this chunk</button>
              </div>
              <p class="text-zinc-700 dark:text-zinc-300">{{ s.text }}</p>
              <details class="mt-2 font-sans text-[11px] leading-normal text-zinc-500"><summary class="cursor-pointer">Why it failed</summary>
                <div class="mt-1 rounded bg-white p-2 font-mono dark:bg-zinc-900">verify: reconstructed text diverged near <span class="bg-red-500/15 text-red-600">“{{ s.fallbackMismatch }}…”</span> after 2 retries → kept chunk whole (no prose dropped)</div>
              </details>
            </div>
            <!-- narration: plain prose -->
            <p v-else-if="s.type === 'narration'" :id="'seg-' + s.id"
              class="-mx-2 mb-3 cursor-text rounded px-2 py-0.5 transition-colors"
              :class="open === s.id ? 'bg-violet-50 ring-1 ring-violet-300 dark:bg-violet-500/10 dark:ring-violet-500/40' : focus === s.id ? 'ring-1 ring-zinc-400' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'"
              @click="open = open === s.id ? null : s.id">
              {{ s.text }}<span v-if="s.direction" class="ml-2 font-sans text-[11px] leading-none text-violet-500/80">[{{ s.direction }}]</span>
            </p>
            <!-- dialogue / thought: card -->
            <div v-else :id="'seg-' + s.id" class="mb-3 cursor-pointer rounded-lg border-l-[3px] bg-zinc-50 px-4 py-2.5 transition-colors dark:bg-zinc-800/50"
              :style="{ borderLeftColor: colorOf(s.speaker) }"
              :class="open === s.id ? 'ring-1 ring-violet-300 dark:ring-violet-500/40' : focus === s.id ? 'ring-1 ring-zinc-400' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'"
              @click="open = open === s.id ? null : s.id">
              <div class="mb-1 flex items-center gap-2 font-sans text-xs leading-normal">
                <span class="rounded-full px-2 py-0.5 font-medium" :style="{ background: colorOf(s.speaker) + '33', color: colorOf(s.speaker) }">
                  <span class="opacity-70">{{ s.type === 'thought' ? '…' : '“' }}</span> {{ s.speaker }}
                </span>
                <span v-if="cast.find(c => c.name === s.speaker)?.isNew" class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600">unreviewed</span>
                <span v-if="s.audio.status === 'stale'" class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600" title="Edited after narration — audio no longer matches">audio stale</span>
                <span v-if="s.direction" class="truncate italic text-zinc-500">— {{ s.direction }}</span>
                <span v-else class="italic text-zinc-300 dark:text-zinc-600">— no direction</span>
              </div>
              <p :class="s.type === 'thought' ? 'italic text-zinc-600 dark:text-zinc-300' : ''">
                <template v-if="s.type === 'dialogue'">‘{{ s.text }}’</template><template v-else>{{ s.text }}</template>
              </p>
            </div>
            <!-- inline editor -->
            <div v-if="open === s.id" class="-mt-1 mb-4 grid grid-cols-[1fr_1fr_2fr_auto] items-end gap-2 rounded-md border border-violet-300 bg-white p-2 font-sans text-xs leading-normal dark:border-violet-500/40 dark:bg-zinc-900" @click.stop>
              <label>Speaker<UiCombobox :model-value="s.speaker" :options="speakerOpts" size="xs" class="mt-1" block @update:model-value="v => app.setSpeaker(bookId, chapterId, s.id, v)" /></label>
              <label>Type<UiSelect :model-value="s.type" :options="typeOpts" size="xs" class="mt-1" block @update:model-value="v => app.updateSegment(bookId, chapterId, s.id, { type: v })" /></label>
              <label>Direction<input :value="s.direction" list="dirs" class="input mt-1 w-full py-0.5" placeholder="e.g. whispered, hesitant" @change="app.updateSegment(bookId, chapterId, s.id, { direction: $event.target.value })" /></label>
              <button class="btn-ghost btn-xs" @click="open = null">Done</button>
            </div>
          </template>
          <div v-if="!rows.length" class="py-10 text-center text-sm text-zinc-500">Nothing matches this filter.</div>
        </div>
      </div>
      <datalist id="dirs"><option v-for="d in DIRECTIONS" :key="d" :value="d" /></datalist>
      <div class="border-t border-zinc-200 px-6 py-1 font-sans text-[11px] text-zinc-400 dark:border-zinc-800">
        <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">j</kbd>/<kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">k</kbd> move · <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">↵</kbd> edit · <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">1</kbd>–<kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">9</kbd> assign speaker
        <span class="ml-1">(<template v-for="(c, i) in inChapter.slice(0, 9)" :key="c.name"><span v-if="i" class="mx-0.5">·</span><b>{{ i + 1 }}</b> {{ c.name.split(' ')[0] }}</template>)</span> · <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">c</kbd> cast
      </div>
    </div>

    <!-- cast rail -->
    <div v-if="reader.showCast" class="card min-h-0 overflow-auto p-3">
      <div class="label mb-2">In this chapter · {{ inChapter.length }} speakers</div>
      <div v-for="c in inChapter" :key="c.name" class="mb-2 rounded-lg border p-3 text-sm transition-colors"
        :class="[speaker === c.name ? 'border-violet-400 bg-violet-50 dark:bg-violet-500/10' : 'border-zinc-200 dark:border-zinc-800', c.isNew && 'border-dashed border-amber-400']">
        <div class="flex items-center gap-2">
          <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: c.color }"></span>
          <input v-if="editingName === c.name" v-model="draft" class="input min-w-0 flex-1 py-0" autofocus @keydown.enter="commitRename" @keydown.esc="editingName = null" @blur="commitRename" />
          <button v-else class="min-w-0 flex-1 truncate text-left font-semibold" @click="jumpToSpeaker(c.name)" @dblclick="startRename(c)">{{ c.name }}</button>
          <span class="text-[11px] text-zinc-400">{{ { m: 'male', f: 'female', n: 'neutral' }[c.gender] ?? 'unknown' }}</span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-1 pl-4 text-[11px] text-zinc-500">
          <span>{{ counts[c.name] }} lines</span>
          <template v-if="c.aliases.length"><span>· a.k.a.</span><span v-for="a in c.aliases" :key="a" class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{{ a }}</span></template>
          <span v-if="c.isNew" class="rounded bg-amber-400/20 px-1 font-semibold text-amber-600">new · alias?</span>
        </div>
        <div class="mt-2 pl-4 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
          <template v-if="!c.description"><span class="italic text-zinc-400">No description yet.</span></template>
          <template v-else-if="revealed.has(c.name) || c.name === 'Narrator'">{{ c.description }}</template>
          <button v-else class="rounded border border-dashed border-zinc-300 px-2 py-1 italic text-zinc-400 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700" @click="revealed = new Set([...revealed, c.name])">description hidden — spoilers · show</button>
        </div>
        <div class="mt-2 flex items-center gap-1 pl-4 text-[11px]">
          <span class="mr-auto truncate text-zinc-500">voice: <b class="text-zinc-700 dark:text-zinc-300">{{ app.voiceLabel(app.effectiveVoice(bookId, c.name).ref) || 'unset' }}</b><span v-if="!app.effectiveVoice(bookId, c.name).own && app.effectiveVoice(bookId, c.name).ref"> (Narrator’s)</span></span>
          <button class="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="startRename(c)">rename</button>
          <UiCombobox v-if="c.name !== 'Narrator'" action :options="cast.filter(x => x.name !== c.name).map(o => ({ value: o.name, label: o.name, color: o.color, keywords: o.aliases.join(' ') }))" placeholder="merge into…" size="xs" class="w-32" @pick="v => app.mergeCharacter(bookId, c.name, v)" />
        </div>
      </div>

      <button class="mt-1 w-full rounded-lg border border-dashed border-zinc-300 py-2 text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700" @click="showRest = !showRest">
        {{ showRest ? 'Hide' : 'Show' }} the rest of the cast ({{ rest.length }})
      </button>
      <div v-if="showRest" class="mt-2 space-y-0.5">
        <div v-for="c in rest" :key="c.name" class="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <span class="h-2 w-2 rounded-full" :style="{ background: c.color }"></span>
          <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
          <span class="font-mono text-zinc-400">{{ app.lineCounts(bookId)[c.name] ?? 0 }}</span>
        </div>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-zinc-400">Click a name to filter the reader to their lines. Double-click to rename. Characters without a voice of their own are read in the Narrator’s voice.</p>
    </div>
  </div>
</template>
