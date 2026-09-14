<script setup>
// Bottom-right toasts. A toast with `undo` reverts a destructive action (merge, rename, remove volume…);
// Ctrl/⌘+Z anywhere outside a field undoes the most recent one.
import { useApp } from '../stores/app'
const app = useApp()
</script>
<template>
  <div class="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
    <TransitionGroup name="toast">
      <div v-for="t in app.toasts" :key="t.id" class="pointer-events-auto flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm shadow-xl" :class="t.kind === 'warn' ? 'border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100' : t.kind === 'error' ? 'border-red-400 bg-red-50 text-red-900 dark:bg-red-500/15 dark:text-red-100' : 'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900'">
        <span class="min-w-0 flex-1 leading-snug">{{ t.msg }}</span>
        <button v-if="t.undo" class="shrink-0 rounded border border-violet-400 px-2 py-0.5 text-xs font-semibold text-violet-600 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-500/10" @click="app.undoToast(t.id)">Undo</button>
        <button v-if="t.action" class="shrink-0 rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-600" @click="t.action.run(); app.dismissToast(t.id)">{{ t.action.label }}</button>
        <button class="shrink-0 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100" @click="app.dismissToast(t.id)">✕</button>
      </div>
    </TransitionGroup>
  </div>
</template>
<style scoped>
.toast-enter-active, .toast-leave-active { transition: all .18s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>
