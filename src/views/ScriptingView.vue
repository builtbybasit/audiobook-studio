<script setup>
// PROTOTYPE — Scripting stage. Three structural variants for the review panel, switchable via ?variant=
//   A Reader      — prose + dialogue cards, in-chapter cast rail with aliases/descriptions
//   B Grid        — dense table, keyboard-driven, bulk reassignment
//   C Cast-first  — pick a character, see only their lines, fix attribution per character
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApp } from '../stores/app'
import ChapterPicker from '../components/ChapterPicker.vue'
import PrototypeSwitcher from '../prototype/PrototypeSwitcher.vue'
import { useVariant } from '../prototype/useVariant'
import VariantA from './scripting/VariantA.vue'
import VariantB from './scripting/VariantB.vue'
import VariantC from './scripting/VariantC.vue'

const VARIANTS = [
  { key: 'A', name: 'Reader', comp: VariantA },
  { key: 'B', name: 'Grid', comp: VariantB },
  { key: 'C', name: 'Cast-first', comp: VariantC },
]
const app = useApp()
const bookId = useRoute().params.bookId
const { current } = useVariant(VARIANTS)

const selected = ref([])
const opened = ref(app.chaptersOf(bookId).find(c => c.scripting === 'done')?.id ?? 1)
const chapter = computed(() => app.chapter(bookId, opened.value))
const hasScript = computed(() => chapter.value?.scripting === 'done')
</script>

<template>
  <div class="grid h-full grid-cols-[300px_1fr] gap-4 p-4">
    <ChapterPicker :book-id="bookId" stage="scripting" v-model="selected" :opened-id="opened" run-label="Run scripting" @open="id => opened = id" @run="ids => app.runScripting(bookId, ids)" />

    <div class="min-h-0 min-w-0">
      <component v-if="hasScript" :is="current.comp" :book-id="bookId" :chapter-id="opened" :key="current.key + ':' + opened" />
      <div v-else class="card grid h-full place-items-center text-center">
        <div class="max-w-sm">
          <div class="mb-1 text-lg font-medium">{{ chapter?.title }}</div>
          <p v-if="chapter?.scripting === 'running'" class="text-sm text-zinc-500">Extracting segments… {{ Math.round(chapter.scriptingProgress) }}%</p>
          <p v-else-if="chapter?.scripting === 'failed'" class="text-sm text-red-500">Scripting failed: the model's output didn't reconstruct the chapter text. Re-run to retry.</p>
          <p v-else class="text-sm text-zinc-500">Not scripted yet. Tick it on the left and run scripting to extract characters and segments.</p>
          <button v-if="chapter?.scripting !== 'running'" class="btn-primary mt-4" @click="app.runScripting(bookId, [opened])">Script this chapter</button>
        </div>
      </div>
    </div>

    <PrototypeSwitcher :variants="VARIANTS" screen="Scripting review" />
  </div>
</template>
