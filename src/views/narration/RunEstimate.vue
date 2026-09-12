<script setup>
// "This run" panel: what the current chapter selection will cost before pressing Narrate.
import { computed } from 'vue'
import { useApp } from '../../stores/app'
const props = defineProps({ bookId: String, selected: Array })
const app = useApp()
const est = computed(() => app.estimate(props.bookId, props.selected))
const cast = computed(() => app.charactersOf(props.bookId))
const voiced = computed(() => cast.value.filter(c => c.voice).length)
const narratorOk = computed(() => !!cast.value.find(c => c.name === 'Narrator')?.voice)
const blockers = computed(() => {
  const b = []
  if (!narratorOk.value) b.push('Assign the Narrator’s voice to start.')
  if (!est.value.endpoints) b.push('Enable at least one endpoint.')
  if (app.endpoints.some(e => e.enabled && e.needsKey && !e.apiKey)) b.push('An enabled endpoint has no API key.')
  return b
})
const fmt = (s) => s >= 3600 ? `~${Math.floor(s / 3600)}h ${Math.round(s % 3600 / 60)}m` : `~${Math.round(s / 60)}m`
defineExpose({ blockers })
</script>
<template>
  <div class="text-xs">
    <div class="label mb-1.5">This run</div>
    <div class="grid grid-cols-2 gap-x-4 gap-y-1">
      <span class="text-zinc-500">Chapters</span><span class="text-right font-mono">{{ est.chapters }}</span>
      <span class="text-zinc-500">Characters</span><span class="text-right font-mono">{{ est.chars >= 1000 ? (est.chars / 1000).toFixed(0) + 'k' : est.chars }}</span>
      <span class="text-zinc-500">Audio</span><span class="text-right font-mono">{{ est.chapters ? fmt(est.seconds) : '—' }}</span>
      <span class="text-zinc-500">Voices set</span><span class="text-right font-mono">{{ voiced }}/{{ cast.length }}</span>
      <span class="text-zinc-500">Endpoints</span><span class="text-right font-mono">{{ est.endpoints }} on</span>
      <span class="text-zinc-500">Est. cost</span><span class="text-right font-mono font-semibold text-amber-600">${{ est.cost.toFixed(2) }}</span>
    </div>
    <div v-for="b in blockers" :key="b" class="mt-2 text-amber-600">⚠ {{ b }}</div>
  </div>
</template>
