<script setup>
// Variant A — "Reader": narration flows as prose; dialogue and thought are lifted into cards with a
// speaker pill and the voice direction. Right rail = the cast *in this chapter* with aliases,
// spoiler-hidden descriptions and inline rename/merge; the rest of the book's cast is collapsed.
// Any segment can be clicked to edit speaker / type / direction in place.
import { computed, ref } from 'vue'
import { useScript, TYPES } from './shared'
import { DIRECTIONS } from '../../mock/data'

const props = defineProps({ bookId: String, chapterId: Number })
const { app, segments, cast, counts, inChapter, colorOf } = useScript(props)

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
</script>

<template>
  <div class="grid h-full grid-cols-[1fr_300px] gap-4">
    <!-- reader -->
    <div class="card flex min-h-0 min-w-0 flex-col">
      <div class="border-b border-zinc-200 px-6 pb-3 pt-4 dark:border-zinc-800">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="label">Chapter {{ chapter.id }}</div>
            <h2 class="truncate font-serif text-2xl">{{ chapter.title }}</h2>
            <div class="mt-0.5 text-xs text-zinc-500">{{ segments.length }} segments · {{ inChapter.length }} speakers · {{ (chars / 1000).toFixed(1) }}k chars · <span class="font-mono">chapter_{{ String(chapter.id).padStart(3, '0') }}.json</span></div>
          </div>
          <button v-if="unresolved" class="btn-ghost btn-xs border-amber-400 text-amber-600" @click="nextNew">⚠ {{ unresolved }} unreviewed speaker{{ unresolved > 1 ? 's' : '' }} → jump</button>
        </div>
        <div class="mt-3 flex items-center gap-2">
          <div class="flex overflow-hidden rounded-md border border-zinc-300 text-xs dark:border-zinc-700">
            <button class="px-2.5 py-1" :class="mode === 'all' ? 'bg-violet-600 text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'" @click="mode = 'all'">Everything</button>
            <button class="px-2.5 py-1" :class="mode === 'dialogue' ? 'bg-violet-600 text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'" @click="mode = 'dialogue'">Dialogue only</button>
          </div>
          <select v-model="speaker" class="input py-1 text-xs"><option value="">All speakers</option><option v-for="c in inChapter" :key="c.name" :value="c.name">{{ c.name }} ({{ counts[c.name] }})</option></select>
          <span class="ml-auto text-[11px] text-zinc-400">{{ rows.length }} shown · click any line to edit</span>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div class="mx-auto max-w-2xl">
          <template v-for="s in rows" :key="s.id">
            <!-- narration: plain prose -->
            <p v-if="s.type === 'narration'" :id="'seg-' + s.id"
              class="-mx-2 mb-3 cursor-text rounded px-2 py-0.5 font-serif text-[16px] leading-7 transition-colors"
              :class="open === s.id ? 'bg-violet-50 ring-1 ring-violet-300 dark:bg-violet-500/10 dark:ring-violet-500/40' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'"
              @click="open = open === s.id ? null : s.id">
              {{ s.text }}<span v-if="s.direction" class="ml-2 font-sans text-[11px] text-violet-500/80">[{{ s.direction }}]</span>
            </p>
            <!-- dialogue / thought: card -->
            <div v-else :id="'seg-' + s.id" class="mb-3 cursor-pointer rounded-lg border-l-[3px] bg-zinc-50 px-4 py-2.5 transition-colors dark:bg-zinc-800/50"
              :style="{ borderLeftColor: colorOf(s.speaker) }"
              :class="open === s.id ? 'ring-1 ring-violet-300 dark:ring-violet-500/40' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'"
              @click="open = open === s.id ? null : s.id">
              <div class="mb-1 flex items-center gap-2 text-xs">
                <span class="rounded-full px-2 py-0.5 font-medium" :style="{ background: colorOf(s.speaker) + '33', color: colorOf(s.speaker) }">
                  <span class="opacity-70">{{ s.type === 'thought' ? '…' : '“' }}</span> {{ s.speaker }}
                </span>
                <span v-if="cast.find(c => c.name === s.speaker)?.isNew" class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600">unreviewed</span>
                <span v-if="s.direction" class="truncate font-serif italic text-zinc-500">— {{ s.direction }}</span>
                <span v-else class="font-serif italic text-zinc-300 dark:text-zinc-600">— no direction</span>
              </div>
              <p class="font-serif text-[16px] leading-7" :class="s.type === 'thought' ? 'italic text-zinc-600 dark:text-zinc-300' : ''">
                <template v-if="s.type === 'dialogue'">‘{{ s.text }}’</template><template v-else>{{ s.text }}</template>
              </p>
            </div>
            <!-- inline editor -->
            <div v-if="open === s.id" class="-mt-1 mb-4 grid grid-cols-[1fr_1fr_2fr_auto] items-end gap-2 rounded-md border border-violet-300 bg-white p-2 text-xs dark:border-violet-500/40 dark:bg-zinc-900" @click.stop>
              <label>Speaker<select :value="s.speaker" class="input mt-1 w-full py-0.5" @change="app.setSpeaker(bookId, chapterId, s.id, $event.target.value)">
                <optgroup label="In this chapter"><option v-for="c in inChapter" :key="c.name">{{ c.name }}</option></optgroup>
                <optgroup label="Rest of cast"><option v-for="c in rest" :key="c.name">{{ c.name }}</option></optgroup></select></label>
              <label>Type<select v-model="s.type" class="input mt-1 w-full py-0.5"><option v-for="t in TYPES" :key="t">{{ t }}</option></select></label>
              <label>Direction<input v-model="s.direction" list="dirs" class="input mt-1 w-full py-0.5" placeholder="e.g. whispered, hesitant" /></label>
              <button class="btn-ghost btn-xs" @click="open = null">Done</button>
            </div>
          </template>
          <div v-if="!rows.length" class="py-10 text-center text-sm text-zinc-500">Nothing matches this filter.</div>
        </div>
      </div>
      <datalist id="dirs"><option v-for="d in DIRECTIONS" :key="d" :value="d" /></datalist>
    </div>

    <!-- cast rail -->
    <div class="card min-h-0 overflow-auto p-3">
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
          <span class="mr-auto text-zinc-500">voice: <b class="text-zinc-700 dark:text-zinc-300">{{ app.effectiveVoice(bookId, c.name).voice }}</b><span v-if="!app.effectiveVoice(bookId, c.name).own"> (Narrator’s)</span></span>
          <button class="rounded px-1.5 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="startRename(c)">rename</button>
          <select v-if="c.name !== 'Narrator'" class="rounded bg-transparent px-1 py-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800" @change="app.mergeCharacter(bookId, c.name, $event.target.value)">
            <option disabled selected>merge into…</option><option v-for="o in cast.filter(x => x.name !== c.name)" :key="o.name">{{ o.name }}</option>
          </select>
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
