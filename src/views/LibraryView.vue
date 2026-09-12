<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useApp } from '../stores/app'
import MiniBar from '../components/MiniBar.vue'
const app = useApp()
const router = useRouter()
const dragging = ref(false)

function open(b) { app.currentBookId = b.id; router.push(`/book/${b.id}/scripting`) }
function addFake() {
  const id = 'new' + Date.now()
  app.books.push({ id, title: 'Untitled Upload.epub', author: 'Unknown', cover: ['#1e293b', '#94a3b8'], addedAt: 'just now' })
  app.chapters[id] = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, index: i + 1, title: `Chapter ${i + 1}`, words: 3000, scripting: 'none', scriptingProgress: 0, narration: 'none', narrationProgress: 0, duration: 0 }))
  app.characters[id] = [{ name: 'Narrator', aliases: [], gender: 'n', voice: 'alloy', style: '', color: '#a78bfa' }]
}
function stageOf(p) {
  if (p.exported) return { label: 'Exported', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' }
  if (p.narrated) return { label: 'Narrating', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' }
  if (p.scripted) return { label: 'Scripting', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' }
  return { label: 'New', cls: 'bg-zinc-500/15 text-zinc-500' }
}
</script>

<template>
  <div class="mx-auto max-w-6xl p-6">
    <div class="mb-5 flex items-end justify-between">
      <div>
        <h1 class="text-2xl font-semibold">Library</h1>
        <p class="text-sm text-zinc-500">{{ app.books.length }} books · pick one to start scripting</p>
      </div>
      <label class="btn-primary cursor-pointer">＋ Add EPUB<input type="file" accept=".epub" class="hidden" @change="addFake" /></label>
    </div>

    <div class="mb-6 grid place-items-center rounded-xl border-2 border-dashed px-6 py-8 text-sm text-zinc-500 transition-colors"
      :class="dragging ? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10' : 'border-zinc-300 dark:border-zinc-700'"
      @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="dragging = false; addFake()">
      Drop .epub files here
    </div>

    <div class="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
      <button v-for="b in app.books" :key="b.id" class="card group overflow-hidden text-left transition-shadow hover:shadow-lg hover:shadow-violet-500/10" @click="open(b)">
        <div class="relative aspect-[3/4] p-4" :style="{ background: `linear-gradient(160deg, ${b.cover[0]}, ${b.cover[1]})` }">
          <div class="font-serif text-lg font-semibold leading-tight text-white drop-shadow">{{ b.title }}</div>
          <div class="mt-1 text-xs text-white/80">{{ b.author }}</div>
          <span class="absolute bottom-3 left-3 rounded-full px-2 py-0.5 text-[11px] font-semibold backdrop-blur" :class="stageOf(app.progress(b.id)).cls">{{ stageOf(app.progress(b.id)).label }}</span>
          <span v-if="app.progress(b.id).running" class="absolute bottom-3 right-3 h-2 w-2 animate-pulse rounded-full bg-emerald-400"></span>
        </div>
        <div class="space-y-1.5 p-3 text-xs">
          <div class="flex justify-between"><span class="text-zinc-500">Chapters</span><span>{{ app.progress(b.id).total }}</span></div>
          <MiniBar label="Scripted" :n="app.progress(b.id).scripted" :of="app.progress(b.id).total" color="bg-amber-500" />
          <MiniBar label="Narrated" :n="app.progress(b.id).narrated" :of="app.progress(b.id).total" color="bg-sky-500" />
          <div class="flex justify-between"><span class="text-zinc-500">Exports</span><span>{{ app.progress(b.id).exported }}</span></div>
        </div>
      </button>
    </div>
  </div>
</template>
