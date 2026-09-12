<script setup>
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useApp } from '../stores/app'
import ChapterPicker from '../components/ChapterPicker.vue'

const app = useApp()
const bookId = useRoute().params.bookId
const book = computed(() => app.bookById(bookId))
const selected = ref(app.chaptersOf(bookId).filter(c => c.narration === 'done').map(c => c.id))
const meta = reactive({ title: book.value.title, author: book.value.author, narrator: 'OpenAI TTS · multi-voice', bitrate: 96, gapSeg: 0.35, gapCh: 2.0, cover: true })
const exportsHere = computed(() => app.exports.filter(e => e.bookId === bookId))
const totalDur = computed(() => app.chaptersOf(bookId).filter(c => selected.value.includes(c.id)).reduce((a, c) => a + c.duration, 0))
const fmt = (s) => `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
const estSize = computed(() => Math.round(totalDur.value * meta.bitrate / 8 / 1024 * 1.04))
</script>

<template>
  <div class="grid h-full grid-cols-[300px_1fr] gap-4 p-4">
    <ChapterPicker :book-id="bookId" stage="export" v-model="selected" run-label="Build audiobook" :selectable="c => c.narration === 'done'" @run="ids => app.buildExport(bookId, ids, meta)" />

    <div class="grid min-h-0 grid-cols-[1fr_320px] gap-4">
      <div class="card space-y-5 overflow-auto p-5">
        <div>
          <div class="label mb-2">Metadata</div>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-sm">Title<input v-model="meta.title" class="input mt-1 w-full" /></label>
            <label class="text-sm">Author<input v-model="meta.author" class="input mt-1 w-full" /></label>
            <label class="col-span-2 text-sm">Narrator credit<input v-model="meta.narrator" class="input mt-1 w-full" /></label>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <div class="h-28 w-20 shrink-0 rounded-md" :style="{ background: `linear-gradient(160deg, ${book.cover[0]}, ${book.cover[1]})` }"></div>
          <div class="text-sm">
            <div class="font-medium">Cover</div>
            <div class="text-zinc-500">Taken from the EPUB. Embedded in the M4B.</div>
            <label class="btn-ghost btn-xs mt-2 cursor-pointer">Replace…<input type="file" class="hidden" /></label>
          </div>
        </div>
        <div>
          <div class="label mb-2">Build options</div>
          <div class="grid grid-cols-3 gap-3 text-sm">
            <label>Format<select class="input mt-1 w-full"><option>M4B (AAC)</option><option disabled>MP3 (soon)</option></select></label>
            <label>Bitrate<select v-model.number="meta.bitrate" class="input mt-1 w-full"><option :value="64">64 kbps</option><option :value="96">96 kbps</option><option :value="128">128 kbps</option></select></label>
            <label>Gap between segments<input v-model.number="meta.gapSeg" type="number" step="0.05" class="input mt-1 w-full" /></label>
            <label>Gap between chapters<input v-model.number="meta.gapCh" type="number" step="0.5" class="input mt-1 w-full" /></label>
          </div>
        </div>
        <div>
          <div class="label mb-2">Chapter titles</div>
          <div class="max-h-56 overflow-auto rounded-md border border-zinc-200 text-sm dark:border-zinc-800">
            <div v-for="c in app.chaptersOf(bookId).filter(c => selected.includes(c.id))" :key="c.id" class="flex items-center gap-2 border-b border-zinc-100 px-2 py-1 last:border-0 dark:border-zinc-800">
              <span class="font-mono text-[11px] text-zinc-400">{{ String(c.id).padStart(2, '0') }}</span>
              <input v-model="c.title" class="flex-1 bg-transparent focus:outline-none" />
            </div>
            <div v-if="!selected.length" class="p-3 text-zinc-500">No chapters selected.</div>
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <div class="card p-4 text-sm">
          <div class="label mb-2">Summary</div>
          <div class="flex justify-between py-0.5"><span class="text-zinc-500">Chapters</span><span>{{ selected.length }}</span></div>
          <div class="flex justify-between py-0.5"><span class="text-zinc-500">Runtime</span><span>{{ fmt(totalDur) }}</span></div>
          <div class="flex justify-between py-0.5"><span class="text-zinc-500">Est. size</span><span>{{ estSize }} MB</span></div>
        </div>
        <div class="card p-4">
          <div class="label mb-2">Exports</div>
          <div v-if="!exportsHere.length" class="text-sm text-zinc-500">None yet.</div>
          <div v-for="e in exportsHere" :key="e.id" class="mb-2 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <div class="truncate font-medium">{{ e.title }}.m4b</div>
            <div class="text-xs text-zinc-500">{{ e.chapters }} ch · {{ e.bitrate }} kbps · {{ e.createdAt }}</div>
            <div v-if="e.status === 'building'" class="mt-2 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800"><div class="h-1.5 rounded bg-violet-500 transition-all" :style="{ width: e.progress + '%' }"></div></div>
            <div v-else class="mt-2 flex items-center justify-between">
              <span class="text-xs text-zinc-500">{{ e.size }} MB</span>
              <button class="btn-ghost btn-xs">⤓ Download</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
