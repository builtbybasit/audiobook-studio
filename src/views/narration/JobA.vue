<script setup>
// Job view A — "Timeline": the chapter as one horizontal strip. Each block is a segment, width ∝ text
// length, colour = status. Click a block for details; the player below scrubs the stitched chapter.
import { computed, ref } from 'vue'
import { useJob, STATUS_BG, fmt } from './shared'
import { usePlayer } from '../../composables/usePlayer'

const props = defineProps({ bookId: String, chapterId: Number })
const { app, chapter, segments, colorOf, voiceOf, epName, stats } = useJob(props)
const { p, play, seek } = usePlayer()
const sel = ref(null)
const totalChars = computed(() => segments.value.reduce((a, s) => a + s.text.length, 0))
const selSeg = computed(() => segments.value.find(s => s.id === sel.value))
const playhead = computed(() => stats.value.duration ? p.pos / stats.value.duration * 100 : 0)
</script>

<template>
  <div class="card flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-4 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div><div class="font-medium">{{ chapter.title }}</div><div class="text-xs text-zinc-500">{{ stats.total }} segments · {{ fmt(stats.duration) }} rendered</div></div>
      <div class="ml-auto flex gap-3 text-xs">
        <span class="flex items-center gap-1"><i class="h-2.5 w-2.5 rounded-sm bg-emerald-500"></i>{{ stats.done }} done</span>
        <span class="flex items-center gap-1"><i class="h-2.5 w-2.5 rounded-sm bg-violet-500"></i>{{ stats.generating }} generating</span>
        <span class="flex items-center gap-1"><i class="h-2.5 w-2.5 rounded-sm bg-zinc-400"></i>{{ stats.queued }} queued</span>
        <span class="flex items-center gap-1"><i class="h-2.5 w-2.5 rounded-sm bg-red-500"></i>{{ stats.failed }} failed</span>
      </div>
      <button v-if="stats.failed && chapter.narration !== 'running'" class="btn-primary btn-xs" @click="app.retryFailed(bookId, chapterId)">Retry {{ stats.failed }} failed</button>
      <button v-if="chapter.narration !== 'running'" class="btn-ghost btn-xs" @click="app.runNarration(bookId, [chapterId])">Re-narrate all</button>
    </div>

    <div class="px-4 pt-4">
      <div class="label mb-1">Segments</div>
      <div class="flex h-12 w-full gap-px overflow-hidden rounded-md">
        <button v-for="s in segments" :key="s.id" class="relative h-full transition-opacity hover:opacity-80" :class="[STATUS_BG[s.audio.status], sel === s.id && 'ring-2 ring-inset ring-black dark:ring-white']"
          :style="{ width: (s.text.length / totalChars * 100) + '%' }" :title="`#${s.id} ${s.speaker}`" @click="sel = s.id">
          <span class="absolute inset-x-0 bottom-0 h-1" :style="{ background: colorOf(s.speaker) }"></span>
        </button>
      </div>
      <div class="mt-1 flex h-3 w-full gap-px">
        <div v-for="s in segments" :key="s.id" class="truncate text-[9px] leading-3 text-zinc-400" :style="{ width: (s.text.length / totalChars * 100) + '%' }">{{ s.speaker.split(' ')[0] }}</div>
      </div>
      <div class="mt-2 text-[11px] text-zinc-500">Top colour = status · bottom stripe = speaker</div>
    </div>

    <div class="flex-1 overflow-auto px-4 py-4">
      <div v-if="selSeg" class="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div class="mb-2 flex items-center gap-2 text-sm">
          <span class="h-3 w-3 rounded-full" :style="{ background: colorOf(selSeg.speaker) }"></span><b>{{ selSeg.speaker }}</b>
          <span class="text-zinc-500">· voice {{ voiceOf(selSeg.speaker) }} · {{ selSeg.type }}</span>
          <span class="ml-auto rounded px-2 py-0.5 text-xs text-white" :class="STATUS_BG[selSeg.audio.status]">{{ selSeg.audio.status }}</span>
        </div>
        <p class="text-[15px]" :class="selSeg.type === 'thought' && 'italic'">“{{ selSeg.text }}”</p>
        <p v-if="selSeg.direction" class="mt-1 text-xs text-violet-500">[{{ selSeg.direction }}]</p>
        <div class="mt-3 flex items-center gap-3 text-xs text-zinc-500">
          <span>endpoint: <b class="text-zinc-700 dark:text-zinc-300">{{ epName(selSeg.audio.endpoint) }}</b></span>
          <span v-if="selSeg.audio.ms">took {{ (selSeg.audio.ms / 1000).toFixed(1) }}s</span>
          <span v-if="selSeg.audio.duration">{{ selSeg.audio.duration.toFixed(1) }}s audio</span>
          <button v-if="selSeg.audio.status === 'done'" class="btn-ghost btn-xs ml-auto" @click="play('seg' + selSeg.id, selSeg.audio.duration)">{{ p.id === 'seg' + selSeg.id && p.playing ? '❚❚' : '▶' }} play segment</button>
          <button v-if="selSeg.audio.status === 'failed'" class="btn-primary btn-xs ml-auto" @click="app.retrySegment(bookId, chapterId, selSeg.id)">↻ Retry</button>
        </div>
      </div>
      <div v-else class="grid h-full place-items-center text-sm text-zinc-500">Click a block above to inspect a segment.</div>
    </div>

    <div class="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div class="flex items-center gap-3">
        <button class="grid h-9 w-9 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40" :disabled="!stats.done" @click="play('chapter', stats.duration)">{{ p.id === 'chapter' && p.playing ? '❚❚' : '▶' }}</button>
        <div class="relative h-2 flex-1 cursor-pointer rounded bg-zinc-200 dark:bg-zinc-800" @click="e => { seek((e.offsetX) / e.currentTarget.clientWidth) }">
          <div class="h-2 rounded bg-violet-500" :style="{ width: (p.id === 'chapter' ? playhead : 0) + '%' }"></div>
        </div>
        <span class="font-mono text-xs text-zinc-500">{{ fmt(p.id === 'chapter' ? p.pos : 0) }} / {{ fmt(stats.duration) }}</span>
      </div>
    </div>
  </div>
</template>
