<script setup>
// "?" anywhere outside a field, or the palette entry, opens the shortcut reference.
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
const open = defineModel('open', { type: Boolean })
const mod = /Mac|iPhone/.test(navigator.platform) ? '⌘' : 'Ctrl'
const groups = [
  { title: 'Anywhere', keys: [[`${mod} K`, 'command palette'], [`${mod} Z`, 'undo the last merge / rename / removal'], ['?', 'this list'], ['Esc', 'close popups and editors']] },
  { title: 'Script reader', keys: [['j / k · ↑ ↓', 'move between lines'], ['↵', 'edit the focused line'], ['1 – 9', 'assign speaker (chapter order)'], ['c', 'toggle the cast rail'], ['/', 'focus the chapter search']] },
  { title: 'Chapter picker', keys: [['↑ ↓', 'move between chapters'], ['space', 'tick / untick'], ['↵', 'open the chapter'], ['shift-click', 'select a range']] },
  { title: 'Narration ledger', keys: [['j / k', 'move between segments'], ['↵ / p', 'play the segment'], ['r', 'retry a failed segment'], ['i', 'show render details']] },
  { title: 'Cast table', keys: [['j / k', 'move between speakers'], ['v', 'open the voice picker'], ['↵', 'rename'], ['x', 'tick for bulk merge']] },
]
</script>
<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/40" />
      <DialogContent class="card fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto p-5 text-sm shadow-2xl focus:outline-none">
        <DialogTitle class="mb-1 text-lg font-semibold">Keyboard shortcuts</DialogTitle>
        <DialogDescription class="mb-4 text-xs text-zinc-500">Shortcuts are ignored while you type in a field.</DialogDescription>
        <div class="grid gap-4 sm:grid-cols-2">
          <div v-for="g in groups" :key="g.title">
            <div class="label mb-1.5">{{ g.title }}</div>
            <div v-for="[k, d] in g.keys" :key="k" class="flex items-baseline gap-2 py-0.5"><kbd class="shrink-0 rounded border border-zinc-200 bg-zinc-50 px-1.5 font-mono text-[11px] dark:border-zinc-700 dark:bg-zinc-800">{{ k }}</kbd><span class="text-xs text-zinc-600 dark:text-zinc-400">{{ d }}</span></div>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
