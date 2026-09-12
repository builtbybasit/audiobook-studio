<script setup>
// Select built on reka-ui. Options: [{ value, label, group?, disabled?, color? }]. `nullValue` lets a
// v-model of null map to a real option (reka needs a concrete value), e.g. "Narrator’s voice".
import { computed } from 'vue'
import { SelectContent, SelectGroup, SelectItem, SelectItemIndicator, SelectItemText, SelectLabel, SelectPortal, SelectRoot, SelectTrigger, SelectValue, SelectViewport } from 'reka-ui'

const props = defineProps({
  modelValue: { default: undefined },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: 'Choose…' },
  nullValue: { default: undefined },          // option value that stands for null
  size: { type: String, default: 'sm' },      // 'xs' | 'sm'
  disabled: Boolean,
  block: Boolean,
})
const emit = defineEmits(['update:modelValue'])
const NULL = '__null__'
const EMPTY = '__empty__'   // reka forbids '' as an item value; map it
const key = (v) => v === '' ? EMPTY : String(v)
const inner = computed({
  get: () => props.modelValue == null ? (props.nullValue !== undefined ? NULL : undefined) : key(props.modelValue),
  set: (v) => {
    if (v === NULL) return emit('update:modelValue', null)
    const opt = props.options.find(o => key(o.value) === v)
    emit('update:modelValue', opt ? opt.value : v)
  },
})
const groups = computed(() => {
  const map = new Map()
  for (const o of props.options) { const g = o.group ?? ''; if (!map.has(g)) map.set(g, []); map.get(g).push(o) }
  return [...map.entries()]
})
const currentLabel = computed(() => props.modelValue == null ? (props.nullValue !== undefined ? String(props.nullValue) : '') : props.options.find(o => o.value === props.modelValue)?.label ?? String(props.modelValue))
</script>

<template>
  <SelectRoot v-model="inner" :disabled="disabled">
    <SelectTrigger class="ui-select-trigger" :class="[size === 'xs' ? 'py-0.5 text-xs' : 'py-1 text-sm', block && 'w-full', modelValue == null && nullValue !== undefined && 'italic text-zinc-400']">
      <SelectValue :placeholder="placeholder" class="min-w-0 flex-1 truncate text-left">
        <slot name="value" :label="currentLabel">{{ currentLabel || placeholder }}</slot>
      </SelectValue>
      <span class="ml-1 shrink-0 text-zinc-400" aria-hidden>▾</span>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent position="popper" :side-offset="4" class="ui-popup" :style="{ minWidth: 'var(--reka-select-trigger-width)', maxHeight: 'min(320px, var(--reka-select-content-available-height))' }">
        <SelectViewport class="p-1">
          <SelectItem v-if="nullValue !== undefined" :value="NULL" class="ui-item italic text-zinc-500"><SelectItemText>{{ nullValue }}</SelectItemText><SelectItemIndicator class="ml-auto text-violet-500">✓</SelectItemIndicator></SelectItem>
          <template v-for="[g, opts] in groups" :key="g">
            <SelectGroup>
              <SelectLabel v-if="g" class="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{{ g }}</SelectLabel>
              <SelectItem v-for="o in opts" :key="key(o.value)" :value="key(o.value)" :disabled="o.disabled" class="ui-item">
                <span v-if="o.color" class="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full" :style="{ background: o.color }"></span>
                <SelectItemText>{{ o.label }}</SelectItemText>
                <span v-if="o.hint" class="ml-2 text-[10px] text-zinc-400">{{ o.hint }}</span>
                <SelectItemIndicator class="ml-auto pl-2 text-violet-500">✓</SelectItemIndicator>
              </SelectItem>
            </SelectGroup>
          </template>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
