<script setup>
// Narration stage: voices + endpoints on top, chapter picker + run estimate + job ledger below.
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useApp } from '../stores/app'
import ChapterPicker from '../components/ChapterPicker.vue'
import VoiceTable from './narration/VoiceTable.vue'
import EndpointPanel from './narration/EndpointPanel.vue'
import RunEstimate from './narration/RunEstimate.vue'
import JobLedger from './narration/JobLedger.vue'
const app = useApp()
const bookId = useRoute().params.bookId
const tab = ref('voices')
const collapsed = ref(false)
const selected = ref([])
const opened = ref(app.chaptersOf(bookId).find(c => c.narration === 'failed')?.id ?? app.chaptersOf(bookId).find(c => c.narration === 'done')?.id ?? 1)
const chapter = computed(() => app.chapter(bookId, opened.value))
const ready = computed(() => chapter.value?.scripting === 'done' && chapter.value.narration !== 'none')
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <div class="card shrink-0">
      <div class="flex items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
        <button class="px-3 py-2 text-sm" :class="tab === 'voices' ? 'border-b-2 border-violet-500 font-semibold' : 'text-zinc-500'" @click="tab = 'voices'; collapsed = false">Voices <span class="text-zinc-400">{{ app.charactersOf(bookId).length }}</span></button>
        <button class="px-3 py-2 text-sm" :class="tab === 'endpoints' ? 'border-b-2 border-violet-500 font-semibold' : 'text-zinc-500'" @click="tab = 'endpoints'; collapsed = false">Endpoints <span class="text-zinc-400">{{ app.enabledEndpoints.length }}/{{ app.endpoints.length }} on</span></button>
        <button class="ml-auto px-3 py-2 text-xs text-zinc-500" @click="collapsed = !collapsed">{{ collapsed ? '▾ expand' : '▴ collapse' }}</button>
      </div>
      <div v-show="!collapsed" class="max-h-[420px] overflow-auto">
        <VoiceTable v-if="tab === 'voices'" :book-id="bookId" />
        <EndpointPanel v-else />
      </div>
    </div>

    <div class="grid h-[680px] min-h-0 grid-cols-[300px_1fr] gap-4">
      <div class="flex min-h-0 flex-col gap-3">
        <div class="min-h-0 flex-1"><ChapterPicker :book-id="bookId" stage="narration" v-model="selected" :opened-id="opened" run-label="Narrate" :selectable="c => c.scripting === 'done'" @open="id => opened = id" @run="ids => app.runNarration(bookId, ids)" /></div>
        <div class="card shrink-0 p-3"><RunEstimate :book-id="bookId" :selected="selected" /></div>
      </div>
      <div class="min-h-0 min-w-0">
        <JobLedger v-if="ready" :book-id="bookId" :chapter-id="opened" :key="opened" />
        <div v-else class="card grid h-full place-items-center text-center">
          <div class="max-w-sm">
            <div class="mb-1 text-lg font-medium">{{ chapter?.title }}</div>
            <p v-if="chapter?.scripting !== 'done'" class="text-sm text-zinc-500">This chapter has no script yet. Script it first.</p>
            <template v-else>
              <p class="text-sm text-zinc-500">{{ app.segmentsOf(bookId, opened).length }} segments ready. Narration will spread them across {{ app.enabledEndpoints.length }} enabled endpoint(s).</p>
              <button class="btn-primary mt-4" @click="app.runNarration(bookId, [opened])">Narrate this chapter</button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
