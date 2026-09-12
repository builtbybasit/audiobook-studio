<script setup>
// "Aa" popover: font family, size, line height, column width. Reset restores defaults.
import { ref } from 'vue'
import { useReader, READER_DEFAULTS } from '../stores/reader'
const reader = useReader()
const open = ref(false)
</script>

<template>
  <div class="relative">
    <button class="btn-ghost btn-xs font-serif" :class="open && 'bg-zinc-200 dark:bg-zinc-800'" title="Reader settings" @click="open = !open">Aa</button>
    <div v-if="open" class="card absolute right-0 top-8 z-30 w-64 p-3 text-xs shadow-xl">
      <div class="mb-2 flex items-center justify-between"><span class="label">Reader</span><button class="text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" @click="open = false">✕</button></div>

      <div class="label mb-1 font-normal">Font</div>
      <div class="mb-3 grid grid-cols-3 overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
        <button v-for="f in ['serif', 'sans', 'mono']" :key="f" class="py-1.5 capitalize" :class="[reader.font === f ? 'bg-violet-600 text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800', { serif: 'font-serif', sans: 'font-sans', mono: 'font-mono' }[f]]" @click="reader.font = f">{{ f }}</button>
      </div>

      <div class="mb-1 flex justify-between"><span>Size</span><span class="font-mono text-zinc-500">{{ reader.size }}px</span></div>
      <input type="range" min="13" max="24" step="1" v-model.number="reader.size" class="mb-3 w-full accent-violet-600" />

      <div class="mb-1 flex justify-between"><span>Line height</span><span class="font-mono text-zinc-500">{{ reader.lineHeight.toFixed(2) }}</span></div>
      <input type="range" min="1.3" max="2.2" step="0.05" v-model.number="reader.lineHeight" class="mb-3 w-full accent-violet-600" />

      <div class="label mb-1 font-normal">Width</div>
      <div class="mb-3 grid grid-cols-3 overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
        <button v-for="w in ['narrow', 'normal', 'wide']" :key="w" class="py-1.5 capitalize" :class="reader.width === w ? 'bg-violet-600 text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'" @click="reader.width = w">{{ w }}</button>
      </div>

      <div class="rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/60" :class="reader.fontClass" :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }">The elder did not look up from his scroll.</div>

      <button class="btn-ghost btn-xs mt-3 w-full justify-center" :disabled="reader.isDefault" @click="reader.reset()">Reset to defaults</button>
    </div>
  </div>
</template>
