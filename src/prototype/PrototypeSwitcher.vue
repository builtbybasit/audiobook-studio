<script setup>
// PROTOTYPE — throwaway. Floating bottom bar that cycles ?variant= (arrows + ← → keys).
// Hidden in production builds.
import { onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useVariant } from './useVariant'

const props = defineProps({ variants: { type: Array, required: true }, screen: { type: String, default: '' } })
const route = useRoute()
const router = useRouter()
const { current } = useVariant(props.variants)
const dev = import.meta.env.DEV

function go(delta) {
  const i = props.variants.indexOf(current.value)
  const next = props.variants[(i + delta + props.variants.length) % props.variants.length]
  router.replace({ query: { ...route.query, variant: next.key } })
}
function onKey(e) {
  const t = e.target
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return
  if (e.key === 'ArrowLeft') go(-1)
  if (e.key === 'ArrowRight') go(1)
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="dev" class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 select-none">
    <div class="flex items-center gap-1 rounded-full bg-amber-400 px-1.5 py-1 font-mono text-xs text-black shadow-[0_8px_30px_rgba(0,0,0,.35)] ring-2 ring-black/80">
      <button class="rounded-full px-2 py-1 hover:bg-black/10" @click="go(-1)" title="Previous variant (←)">◀</button>
      <span class="px-2">
        <span class="opacity-60">{{ screen }}</span>
        <b class="mx-1">{{ current.key }}</b> — {{ current.name }}
        <span class="opacity-60"> ({{ variants.map(v => v.key).join('/') }})</span>
      </span>
      <button class="rounded-full px-2 py-1 hover:bg-black/10" @click="go(1)" title="Next variant (→)">▶</button>
    </div>
  </div>
</template>
