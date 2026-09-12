<script setup>
// "Aa" popover (reka Popover): font family, size, line height, column width. Reset restores defaults.
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { useReader } from '../stores/reader'
import { UiSlider, UiToggleGroup } from '../ui'
const reader = useReader()
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger class="btn-ghost btn-xs font-serif data-[state=open]:bg-zinc-200 dark:data-[state=open]:bg-zinc-800" title="Reader settings">Aa</PopoverTrigger>
    <PopoverPortal>
      <PopoverContent align="end" :side-offset="6" class="ui-popup w-64 p-3 text-xs">
        <div class="label mb-2">Reader</div>

        <div class="label mb-1 font-normal">Font</div>
        <UiToggleGroup v-model="reader.font" block class="mb-3" :options="[{ value: 'serif', label: 'Serif', class: 'font-serif' }, { value: 'sans', label: 'Sans', class: 'font-sans' }, { value: 'mono', label: 'Mono', class: 'font-mono' }]" />

        <div class="mb-1 flex justify-between"><span>Size</span><span class="font-mono text-zinc-500">{{ reader.size }}px</span></div>
        <UiSlider v-model="reader.size" :min="13" :max="24" :step="1" label="Font size" class="mb-3" />

        <div class="mb-1 flex justify-between"><span>Line height</span><span class="font-mono text-zinc-500">{{ reader.lineHeight.toFixed(2) }}</span></div>
        <UiSlider v-model="reader.lineHeight" :min="1.3" :max="2.2" :step="0.05" label="Line height" class="mb-3" />

        <div class="label mb-1 font-normal">Width</div>
        <UiToggleGroup v-model="reader.width" block class="mb-3" :options="[{ value: 'narrow', label: 'Narrow' }, { value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }]" />

        <div class="rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/60" :class="reader.fontClass" :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }">The elder did not look up from his scroll.</div>

        <button class="btn-ghost btn-xs mt-3 w-full justify-center" :disabled="reader.isDefault" @click="reader.reset()">Reset to defaults</button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
