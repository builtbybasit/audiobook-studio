<script setup>
// Endpoint pool with health: latency sparkline, failure & rate-limit counts, backoff state, pause/resume.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useApp } from '../../stores/app'
import { UiSlider } from '../../ui'
const app = useApp()
const now = ref(Date.now()); let t
onMounted(() => { t = setInterval(() => now.value = Date.now(), 500) }); onUnmounted(() => clearInterval(t))
function add() { app.endpoints.push({ id: 'ep' + Date.now(), name: 'New endpoint', baseUrl: 'https://', apiKey: '', model: 'gpt-4o-mini-tts', concurrency: 1, enabled: false, latency: 1500, failRate: 0.03, price: 12, needsKey: true, history: [], failures: 0, rateLimits: 0, backoffUntil: 0 }) }
function spark(e) {
  const h = (e.history ?? []).slice(-30); if (!h.length) return ''
  const max = Math.max(...h.map(x => x.ms)) || 1
  return h.map((x, i) => `${(i / Math.max(1, h.length - 1) * 100).toFixed(1)},${(28 - x.ms / max * 26).toFixed(1)}`).join(' ')
}
const avg = (e) => { const h = (e.history ?? []).slice(-30); return h.length ? Math.round(h.reduce((a, x) => a + x.ms, 0) / h.length) : null }
const okRate = (e) => { const h = (e.history ?? []).slice(-30); return h.length ? Math.round(h.filter(x => x.ok).length / h.length * 100) : null }
const backoff = (e) => Math.max(0, Math.ceil((e.backoffUntil - now.value) / 1000))
const health = (e) => !e.enabled ? 'paused' : backoff(e) ? 'backing off' : (okRate(e) ?? 100) < 85 ? 'degraded' : 'healthy'
const healthCls = { healthy: 'text-emerald-500', degraded: 'text-amber-500', 'backing off': 'text-violet-500', paused: 'text-zinc-400' }
</script>
<template>
  <div class="p-3">
    <div class="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
      <div v-for="e in app.endpoints" :key="e.id" class="rounded-lg border p-3 text-sm" :class="e.enabled ? 'border-emerald-400/60' : 'border-zinc-200 dark:border-zinc-800'">
        <div class="mb-1 flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" :class="{ 'bg-emerald-500': health(e) === 'healthy', 'bg-amber-500': health(e) === 'degraded', 'bg-violet-500 animate-pulse': health(e) === 'backing off', 'bg-zinc-400': health(e) === 'paused' }"></span>
          <input v-model="e.name" class="min-w-0 flex-1 bg-transparent font-medium focus:outline-none" />
          <span v-if="e.needsKey && !e.apiKey" class="rounded bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-500">no key</span>
          <span class="rounded bg-zinc-100 px-1.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{{ e.price ? '$' + e.price + '/1M chars' : 'free' }}</span>
          <button class="btn-ghost btn-xs" @click="e.enabled = !e.enabled">{{ e.enabled ? '❚❚ Pause' : '▶ Resume' }}</button>
        </div>

        <!-- health strip -->
        <div class="mb-2 flex items-center gap-3 rounded-md bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/60">
          <svg viewBox="0 0 100 30" class="h-7 w-24 shrink-0" preserveAspectRatio="none"><polyline :points="spark(e)" fill="none" stroke="currentColor" stroke-width="1.5" class="text-violet-500" vector-effect="non-scaling-stroke" /></svg>
          <div class="grid flex-1 grid-cols-3 gap-2 text-[11px] leading-tight">
            <div><div class="text-zinc-400">latency</div><div class="font-mono">{{ avg(e) ? (avg(e) / 1000).toFixed(1) + 's' : '—' }}</div></div>
            <div><div class="text-zinc-400">ok rate</div><div class="font-mono" :class="(okRate(e) ?? 100) < 85 && 'text-amber-500'">{{ okRate(e) != null ? okRate(e) + '%' : '—' }}</div></div>
            <div><div class="text-zinc-400">failed · 429</div><div class="font-mono">{{ e.failures ?? 0 }} · {{ e.rateLimits ?? 0 }}</div></div>
          </div>
          <div class="w-20 text-right text-[11px] font-semibold capitalize" :class="healthCls[health(e)]">{{ health(e) }}<div v-if="backoff(e)" class="font-mono font-normal text-zinc-400">{{ backoff(e) }}s</div></div>
        </div>

        <div class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
          <span class="text-zinc-500">Base URL</span><input v-model="e.baseUrl" class="input py-0.5 font-mono" />
          <span class="text-zinc-500">API key</span><input v-model="e.apiKey" type="password" class="input py-0.5 font-mono" placeholder="none" />
          <span class="text-zinc-500">Model</span><input v-model="e.model" class="input py-0.5 font-mono" />
          <span class="text-zinc-500">Price</span><div class="flex items-center gap-1"><span>$</span><input v-model.number="e.price" type="number" class="input w-20 py-0.5" /><span class="text-zinc-400">per 1M chars</span></div>
          <span class="text-zinc-500">Concurrency</span>
          <div class="flex items-center gap-2"><UiSlider v-model="e.concurrency" :min="1" :max="8" label="Concurrency" /><span class="w-4 font-mono">{{ e.concurrency }}</span></div>
        </div>
      </div>
      <button class="grid min-h-28 place-items-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700" @click="add">＋ Add endpoint</button>
    </div>
  </div>
</template>
