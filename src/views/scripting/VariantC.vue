<script setup>
// Variant C — "Cast-first": characters are the primary object. Pick one, see only their lines
// as a stack with surrounding context, and reattribute each with one click. Built for cleanup:
// spotting a mis-tagged line is easier when everything on screen should sound like one person.
import { computed, ref } from 'vue'
import { useScript } from './shared'
import { useApp } from '../../stores/app'

const props = defineProps({ bookId: String, chapterId: Number })
const { app, segments, cast, counts, inChapter, colorOf } = useScript(props)
const who = ref(inChapter.value.find(c => c.isNew)?.name ?? inChapter.value[1]?.name ?? 'Narrator')
const lines = computed(() => segments.value.map((s, i) => ({ s, prev: segments.value[i - 1], next: segments.value[i + 1] })).filter(x => x.s.speaker === who.value))
const character = computed(() => cast.value.find(c => c.name === who.value))
const showCtx = ref(true)
const others = computed(() => inChapter.value.filter(c => c.name !== who.value))
const renaming = ref(false); const draft = ref('')
function rename() { app.renameCharacter(props.bookId, who.value, draft.value); who.value = draft.value; renaming.value = false }
function merge(into) { app.mergeCharacter(props.bookId, who.value, into); who.value = into }
</script>

<template>
  <div class="grid h-full grid-cols-[260px_1fr] gap-4">
    <div class="card flex min-h-0 flex-col">
      <div class="label px-3 pt-3">Cast · this chapter</div>
      <div class="min-h-0 flex-1 overflow-auto p-2">
        <button v-for="c in inChapter" :key="c.name" class="mb-1 flex w-full items-center gap-3 rounded-lg border p-2.5 text-left transition-colors"
          :class="who === c.name ? 'border-violet-400 bg-violet-50 dark:bg-violet-500/10' : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60'" @click="who = c.name">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold text-black/70" :style="{ background: c.color }">{{ c.name.split(' ').map(w => w[0]).join('').slice(0, 2) }}</span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ c.name }} <span v-if="c.isNew" class="ml-1 rounded bg-amber-400/20 px-1 text-[10px] text-amber-600">new</span></span>
            <span class="block truncate text-[11px] text-zinc-500">{{ counts[c.name] }} lines<span v-if="c.aliases.length"> · aka {{ c.aliases.join(', ') }}</span></span>
          </span>
          <span class="h-8 w-1 rounded" :style="{ background: c.color, opacity: Math.min(1, (counts[c.name] ?? 0) / 12 + .2) }"></span>
        </button>
      </div>
    </div>

    <div class="card flex min-h-0 min-w-0 flex-col">
      <div class="flex items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <span class="h-4 w-4 rounded-full" :style="{ background: colorOf(who) }"></span>
        <template v-if="renaming"><input v-model="draft" class="input" autofocus @keydown.enter="rename" @keydown.esc="renaming = false" /><button class="btn-primary btn-xs" @click="rename">Save</button></template>
        <h2 v-else class="text-lg font-semibold">{{ who }}</h2>
        <span class="text-sm text-zinc-500">{{ lines.length }} lines in this chapter</span>
        <div class="ml-auto flex items-center gap-1">
          <button class="btn-ghost btn-xs" @click="renaming = true; draft = who">Rename</button>
          <select v-if="who !== 'Narrator'" class="input py-0.5 text-xs" @change="merge($event.target.value)"><option disabled selected>Merge into…</option><option v-for="c in cast.filter(c => c.name !== who)" :key="c.name">{{ c.name }}</option></select>
          <label class="ml-2 flex items-center gap-1 text-xs text-zinc-500"><input type="checkbox" v-model="showCtx" class="accent-violet-600" /> context</label>
        </div>
      </div>

      <div class="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <div v-for="{ s, prev, next } in lines" :key="s.id" class="rounded-xl border border-zinc-200 dark:border-zinc-800">
          <div v-if="showCtx && prev" class="truncate border-b border-dashed border-zinc-200 px-4 py-1.5 text-xs text-zinc-400 dark:border-zinc-800"><b :style="{ color: colorOf(prev.speaker) }">{{ prev.speaker }}</b> · {{ prev.text }}</div>
          <div class="flex gap-3 px-4 py-3">
            <div class="min-w-0 flex-1">
              <p class="text-[15px] leading-relaxed" :class="s.type === 'thought' && 'italic'"><span v-if="s.type === 'dialogue'">“{{ s.text }}”</span><span v-else>{{ s.text }}</span></p>
              <div class="mt-2 flex items-center gap-2 text-xs">
                <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-500 dark:bg-zinc-800">#{{ s.id }} · {{ s.type }}</span>
                <input v-model="s.direction" class="input flex-1 py-0.5 text-xs" placeholder="voice direction…" />
              </div>
            </div>
            <div class="flex w-36 shrink-0 flex-col gap-1 border-l border-zinc-100 pl-3 dark:border-zinc-800">
              <div class="label">Not {{ who.split(' ')[0] }}? →</div>
              <button v-for="o in others.slice(0, 4)" :key="o.name" class="flex items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800" @click="app.setSpeaker(bookId, chapterId, s.id, o.name)">
                <span class="h-2 w-2 shrink-0 rounded-full" :style="{ background: o.color }"></span>{{ o.name }}
              </button>
              <select class="input py-0.5 text-xs" @change="app.setSpeaker(bookId, chapterId, s.id, $event.target.value)"><option disabled selected>other…</option><option v-for="c in cast" :key="c.name">{{ c.name }}</option></select>
            </div>
          </div>
          <div v-if="showCtx && next" class="truncate border-t border-dashed border-zinc-200 px-4 py-1.5 text-xs text-zinc-400 dark:border-zinc-800"><b :style="{ color: colorOf(next.speaker) }">{{ next.speaker }}</b> · {{ next.text }}</div>
        </div>
        <div v-if="!lines.length" class="py-10 text-center text-sm text-zinc-500">No lines attributed to {{ who }} in this chapter.</div>
      </div>
    </div>
  </div>
</template>
