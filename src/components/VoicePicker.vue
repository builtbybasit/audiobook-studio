<script setup>
// Voice picker for a character: a popover with search, gender filter, voices grouped by endpoint
// (paused ones listed but disabled), "used by N" and an inline demo button. Built on reka Popover +
// Listbox so arrows/Enter work. v-model is the voice ref (`endpointId/voiceId`) or null.
import { computed, ref, watch } from 'vue'
import { useApp } from '../stores/app'
import { speak } from '../composables/usePlayer'
import { ListboxContent, ListboxFilter, ListboxGroup, ListboxGroupLabel, ListboxItem, ListboxRoot, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger, useFilter } from 'reka-ui'
import { UiToggleGroup } from '../ui'

const props = defineProps({ modelValue: { default: null }, bookId: String, nullLabel: { type: String, default: 'Narrator’s voice' }, size: { type: String, default: 'sm' }, block: Boolean, speaker: String })
const emit = defineEmits(['update:modelValue'])
const app = useApp()
const open = ref(false); const q = ref(''); const gender = ref('all')
const { contains } = useFilter({ sensitivity: 'base' })
watch(open, o => { if (o) { q.value = ''; gender.value = 'all' } })

const current = computed(() => app.resolveVoice(props.modelValue))
const missing = computed(() => props.modelValue && !current.value)
const usedBy = computed(() => { const m = {}; for (const c of app.charactersOf(props.bookId)) if (c.voice) (m[c.voice] ??= []).push(c.name); return m })
const rows = computed(() => app.endpoints.map(e => ({
  endpoint: e,
  voices: e.voices.filter(v => (gender.value === 'all' || v.gender === gender.value) && (!q.value || contains(v.label, q.value) || contains(v.id, q.value) || contains(e.name, q.value))),
})).filter(g => g.voices.length))
const G = { m: '♂', f: '♀', n: '◦' }
function pick(v) { emit('update:modelValue', v === '__null__' ? null : v); open.value = false }
const sample = props.speaker === 'Narrator' ? 'The mountain mist thinned as dawn crept over the outer sect grounds.' : 'I have not come to fight. Give me three days, that is all I ask.'
defineExpose({ open })
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger class="ui-select-trigger" :class="[size === 'xs' ? 'py-0.5 text-xs' : 'py-1 text-sm', block && 'w-full', !modelValue && 'italic text-zinc-400', missing && 'ring-1 ring-amber-400']">
      <span class="min-w-0 flex-1 truncate text-left">
        <template v-if="missing"><span class="not-italic text-amber-600">{{ modelValue.split('/')[1] }} — missing</span></template>
        <template v-else-if="current">{{ current.voice.label }} <span class="text-zinc-400">· {{ current.endpoint.name }}</span></template>
        <template v-else>{{ nullLabel }}</template>
      </span>
      <span class="ml-1 shrink-0 text-zinc-400" aria-hidden>▾</span>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent :side-offset="4" align="start" class="ui-popup w-[min(360px,92vw)]" @open-auto-focus.prevent>
        <ListboxRoot :model-value="undefined" highlight-on-hover @update:model-value="pick">
          <div class="flex items-center gap-2 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
            <ListboxFilter v-model="q" auto-focus class="min-w-0 flex-1 bg-transparent text-sm focus:outline-none" placeholder="Search voices…" />
            <UiToggleGroup v-model="gender" :options="[{ value: 'all', label: 'all' }, { value: 'f', label: '♀' }, { value: 'm', label: '♂' }, { value: 'n', label: '◦' }]" />
          </div>
          <ListboxContent class="max-h-[300px] overflow-auto p-1">
            <ListboxItem value="__null__" class="ui-item italic text-zinc-500">{{ nullLabel }}<span v-if="!modelValue" class="ml-auto text-violet-500">✓</span></ListboxItem>
            <ListboxGroup v-for="g in rows" :key="g.endpoint.id">
              <ListboxGroupLabel class="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400"><span class="h-1.5 w-1.5 rounded-full" :class="g.endpoint.enabled ? 'bg-emerald-500' : 'bg-zinc-400'"></span>{{ g.endpoint.name }}<span v-if="!g.endpoint.enabled" class="font-normal normal-case">· paused</span><span v-if="g.endpoint.maxChars" class="font-normal normal-case">· splits over {{ g.endpoint.maxChars }}</span></ListboxGroupLabel>
              <ListboxItem v-for="v in g.voices" :key="v.id" :value="`${g.endpoint.id}/${v.id}`" :disabled="!g.endpoint.enabled" class="ui-item">
                <span class="w-4 text-zinc-400">{{ G[v.gender] ?? '◦' }}</span>
                <span class="min-w-0 truncate">{{ v.label }}</span><span v-if="v.label !== v.id" class="ml-1 font-mono text-[10px] text-zinc-400">{{ v.id }}</span>
                <span v-if="usedBy[`${g.endpoint.id}/${v.id}`]" class="ml-2 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800" :title="usedBy[`${g.endpoint.id}/${v.id}`].join(', ')">{{ usedBy[`${g.endpoint.id}/${v.id}`].length }} using</span>
                <span class="ml-auto flex items-center gap-1 pl-2">
                  <button class="rounded px-1 text-zinc-400 hover:bg-zinc-200 hover:text-violet-500 dark:hover:bg-zinc-700" title="demo (browser voice — the real one needs the backend)" @click.stop.prevent="speak(sample, v.id)">▶</button>
                  <span v-if="modelValue === `${g.endpoint.id}/${v.id}`" class="text-violet-500">✓</span>
                </span>
              </ListboxItem>
            </ListboxGroup>
            <div v-if="!rows.length" class="p-4 text-center text-xs text-zinc-500">No voice matches. Voices come from the Endpoints tab.</div>
          </ListboxContent>
        </ListboxRoot>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
