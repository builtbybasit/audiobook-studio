<script setup>
import { useApp } from '../../stores/app'
const app = useApp()
function add() { app.endpoints.push({ id: 'ep' + Date.now(), name: 'New endpoint', baseUrl: 'https://', apiKey: '', model: 'gpt-4o-mini-tts', concurrency: 1, enabled: false, latency: 1500, failRate: 0.03, price: 12, needsKey: true }) }
</script>
<template>
  <div class="p-3">
    <div class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
      <div v-for="e in app.endpoints" :key="e.id" class="rounded-lg border p-3 text-sm" :class="e.enabled ? 'border-emerald-400/60' : 'border-zinc-200 opacity-70 dark:border-zinc-800'">
        <div class="mb-2 flex items-center gap-2">
          <input v-model="e.name" class="min-w-0 flex-1 bg-transparent font-medium focus:outline-none" />
          <span v-if="e.needsKey && !e.apiKey" class="rounded bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-500">no key</span>
          <span class="rounded bg-zinc-100 px-1.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{{ e.price ? '$' + e.price + '/1M chars' : 'free' }}</span>
          <label class="flex cursor-pointer items-center gap-1 text-xs"><input type="checkbox" v-model="e.enabled" class="accent-emerald-500" /> {{ e.enabled ? 'on' : 'off' }}</label>
        </div>
        <div class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
          <span class="text-zinc-500">Base URL</span><input v-model="e.baseUrl" class="input py-0.5 font-mono" />
          <span class="text-zinc-500">API key</span><input v-model="e.apiKey" type="password" class="input py-0.5 font-mono" placeholder="none" />
          <span class="text-zinc-500">Model</span><input v-model="e.model" class="input py-0.5 font-mono" />
          <span class="text-zinc-500">Price</span><div class="flex items-center gap-1"><span>$</span><input v-model.number="e.price" type="number" class="input w-20 py-0.5" /><span class="text-zinc-400">per 1M chars</span></div>
          <span class="text-zinc-500">Concurrency</span>
          <div class="flex items-center gap-2"><input type="range" v-model.number="e.concurrency" min="1" max="8" class="flex-1 accent-violet-600" /><span class="w-4 font-mono">{{ e.concurrency }}</span></div>
        </div>
      </div>
      <button class="grid min-h-28 place-items-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700" @click="add">＋ Add endpoint</button>
    </div>
  </div>
</template>
