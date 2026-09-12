<script setup>
// Shared chapter selector: checkboxes + per-stage status. Chapters are grouped by volume when a
// novel spans several EPUBs; each volume header can collapse and select/deselect its chapters.
import { computed, ref } from 'vue'
import { useApp } from '../stores/app'
import StatusDot from './StatusDot.vue'

const props = defineProps({
  bookId: String,
  stage: String,                 // 'scripting' | 'narration' | 'export'
  modelValue: { type: Array, default: () => [] },
  openedId: Number,
  runLabel: { type: String, default: 'Run' },
  selectable: { type: Function, default: () => true },
})
const emit = defineEmits(['update:modelValue', 'open', 'run'])
const app = useApp()
const chapters = computed(() => app.chaptersOf(props.bookId))
const volumes = computed(() => app.volumesOf(props.bookId))
const grouped = computed(() => volumes.value.map(v => ({ ...v, chapters: chapters.value.filter(c => c.volumeId === v.id) })))
const multi = computed(() => volumes.value.length > 1)
const collapsed = ref(new Set())

function statusOf(c) {
  if (props.stage === 'scripting') return c.scripting
  if (props.stage === 'narration') return c.narration
  return c.narration === 'done' ? 'done' : 'none'
}
function progressOf(c) { return props.stage === 'scripting' ? c.scriptingProgress : c.narrationProgress }
function toggle(id) {
  const set = new Set(props.modelValue)
  set.has(id) ? set.delete(id) : set.add(id)
  emit('update:modelValue', [...set])
}
function all() { emit('update:modelValue', chapters.value.filter(props.selectable).map(c => c.id)) }
function none() { emit('update:modelValue', []) }
function pending() { emit('update:modelValue', chapters.value.filter(c => props.selectable(c) && statusOf(c) !== 'done').map(c => c.id)) }
function volState(v) {
  const ids = v.chapters.filter(props.selectable).map(c => c.id)
  const n = ids.filter(id => props.modelValue.includes(id)).length
  return { all: ids.length > 0 && n === ids.length, some: n > 0 && n < ids.length, done: v.chapters.filter(c => statusOf(c) === 'done').length }
}
function toggleVol(v) {
  const ids = v.chapters.filter(props.selectable).map(c => c.id)
  const set = new Set(props.modelValue)
  volState(v).all ? ids.forEach(id => set.delete(id)) : ids.forEach(id => set.add(id))
  emit('update:modelValue', [...set])
}
function toggleCollapse(id) { const s = new Set(collapsed.value); s.has(id) ? s.delete(id) : s.add(id); collapsed.value = s }
const counts = computed(() => {
  const out = { done: 0, failed: 0, running: 0 }
  for (const c of chapters.value) { const s = statusOf(c); if (s in out) out[s]++ }
  return out
})
</script>

<template>
  <div class="card flex h-full flex-col">
    <div class="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <div>
        <div class="label">Chapters<span v-if="multi" class="font-normal normal-case tracking-normal text-zinc-400"> · {{ volumes.length }} volumes</span></div>
        <div class="text-xs text-zinc-500">{{ counts.done }} done · {{ counts.failed }} failed · {{ modelValue.length }} selected</div>
      </div>
      <div class="flex gap-1">
        <button class="btn-ghost btn-xs" @click="all">All</button>
        <button class="btn-ghost btn-xs" @click="pending">Pending</button>
        <button class="btn-ghost btn-xs" @click="none">None</button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto py-1">
      <template v-for="v in grouped" :key="v.id">
        <div v-if="multi" class="sticky top-0 z-10 flex items-center gap-2 border-y border-zinc-100 bg-zinc-50 px-3 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900">
          <input type="checkbox" class="accent-violet-600" :checked="volState(v).all" :indeterminate.prop="volState(v).some" @change="toggleVol(v)" />
          <button class="min-w-0 flex-1 truncate text-left font-semibold" @click="toggleCollapse(v.id)">
            <span class="mr-1 text-zinc-400">{{ collapsed.has(v.id) ? '▸' : '▾' }}</span>{{ v.name }}
          </button>
          <span class="shrink-0 font-mono text-[10px] text-zinc-400" :title="v.file">{{ volState(v).done }}/{{ v.chapters.length }}</span>
        </div>
        <template v-if="!collapsed.has(v.id)">
          <div v-for="c in v.chapters" :key="c.id"
            class="group flex items-center gap-2 px-3 py-1.5 text-sm"
            :class="[openedId === c.id ? 'bg-violet-50 dark:bg-violet-500/10' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60', !selectable(c) && 'opacity-50']">
            <input type="checkbox" class="accent-violet-600" :checked="modelValue.includes(c.id)" :disabled="!selectable(c)" @change="toggle(c.id)" />
            <StatusDot :status="statusOf(c)" />
            <button class="min-w-0 flex-1 truncate text-left" :class="openedId === c.id && 'font-semibold'" @click="emit('open', c.id)">
              <span class="mr-1.5 font-mono text-[11px] text-zinc-400">{{ String(c.id).padStart(2, '0') }}</span>{{ c.title }}
            </button>
            <span v-if="statusOf(c) === 'running'" class="w-9 text-right font-mono text-[11px] text-violet-500">{{ Math.round(progressOf(c)) }}%</span>
            <span v-else-if="statusOf(c) === 'failed'" class="text-[11px] text-red-500">failed</span>
            <span v-else-if="stage === 'scripting' && c.scripting === 'done'" class="font-mono text-[11px] text-zinc-400" title="segments">{{ app.segmentsOf(bookId, c.id).length }}</span>
            <span v-else-if="stage !== 'scripting' && c.duration" class="font-mono text-[11px] text-zinc-400">{{ Math.floor(c.duration / 60) }}:{{ String(Math.round(c.duration % 60)).padStart(2, '0') }}</span>
          </div>
        </template>
      </template>
    </div>

    <div class="border-t border-zinc-200 p-2 dark:border-zinc-800">
      <button class="btn-primary w-full justify-center" :disabled="!modelValue.length" @click="emit('run', modelValue)">
        {{ runLabel }} <span class="opacity-70">({{ modelValue.length }})</span>
      </button>
    </div>
  </div>
</template>
