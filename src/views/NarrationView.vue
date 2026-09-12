<script setup>
// Narration stage: voices + endpoints on top, chapter picker + run estimate + job ledger below.
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useApp, isScripted, isNarrated } from '../stores/app'
import EmptyState from '../components/EmptyState.vue'
import ChapterPicker from '../components/ChapterPicker.vue'
import VoiceTable from './narration/VoiceTable.vue'
import EndpointPanel from './narration/EndpointPanel.vue'
import RunEstimate from './narration/RunEstimate.vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import JobLedger from './narration/JobLedger.vue'
const app = useApp()
const bookId = useRoute().params.bookId
const tab = ref('voices')
const collapsed = ref(false)
const selected = ref([])
const opened = ref(app.chaptersOf(bookId).find(c => c.narration === 'stale')?.id ?? app.chaptersOf(bookId).find(c => c.narration === 'failed')?.id ?? app.chaptersOf(bookId).find(isNarrated)?.id ?? 1)
const anyScripted = computed(() => app.chaptersOf(bookId).some(isScripted))
const chapter = computed(() => app.chapter(bookId, opened.value))
const ready = computed(() => chapter.value && isScripted(chapter.value) && chapter.value.narration !== 'none')
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <TabsRoot v-model="tab" class="card shrink-0" @update:model-value="collapsed = false">
      <TabsList class="flex items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
        <TabsTrigger value="voices" class="border-b-2 border-transparent px-3 py-2 text-sm text-zinc-500 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-100">Voices <span class="text-zinc-400">{{ app.charactersOf(bookId).length }}</span></TabsTrigger>
        <TabsTrigger value="endpoints" class="border-b-2 border-transparent px-3 py-2 text-sm text-zinc-500 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-100">Endpoints <span class="text-zinc-400">{{ app.enabledEndpoints.length }}/{{ app.endpoints.length }} on</span></TabsTrigger>
        <button class="ml-auto px-3 py-2 text-xs text-zinc-500" @click="collapsed = !collapsed">{{ collapsed ? '▾ expand' : '▴ collapse' }}</button>
      </TabsList>
      <div v-show="!collapsed" class="max-h-[420px] overflow-auto">
        <TabsContent value="voices"><VoiceTable :book-id="bookId" /></TabsContent>
        <TabsContent value="endpoints"><EndpointPanel /></TabsContent>
      </div>
    </TabsRoot>

    <div class="grid h-[680px] min-h-0 grid-cols-[300px_1fr] gap-4">
      <div class="flex min-h-0 flex-col gap-3">
        <div class="min-h-0 flex-1"><ChapterPicker :book-id="bookId" stage="narration" v-model="selected" :opened-id="opened" run-label="Narrate" :selectable="c => isScripted(c)" @open="id => opened = id" @run="ids => app.runNarration(bookId, ids)" /></div>
        <div class="card shrink-0 p-3"><RunEstimate :book-id="bookId" :selected="selected" /></div>
      </div>
      <div class="min-h-0 min-w-0">
        <JobLedger v-if="ready" :book-id="bookId" :chapter-id="opened" :key="opened" />
        <EmptyState v-else-if="!anyScripted" icon="♪" title="Nothing to narrate yet" body="Narration needs a script. Script at least one chapter first, then assign voices here."
          :steps="['Script chapters in stage 1', 'Assign a voice to the Narrator and the main cast above', 'Enable an endpoint and press Narrate']">
          <RouterLink :to="`/book/${bookId}/scripting`" class="btn-primary">Go to Scripting</RouterLink>
        </EmptyState>
        <EmptyState v-else-if="chapter && !isScripted(chapter)" icon="♪" :title="chapter.title" body="This chapter has no script yet. Script it first, then narrate.">
          <RouterLink :to="`/book/${bookId}/scripting`" class="btn-ghost">Go to Scripting</RouterLink>
        </EmptyState>
        <EmptyState v-else icon="♪" :title="chapter?.title" :body="`${app.segmentsOf(bookId, opened).length} segments ready. They will be spread across ${app.enabledEndpoints.length} enabled endpoint${app.enabledEndpoints.length === 1 ? '' : 's'}.`">
          <button class="btn-primary" @click="app.runNarration(bookId, [opened])">Narrate this chapter</button>
        </EmptyState>
      </div>
    </div>
  </div>
</template>
