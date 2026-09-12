<script setup>
// Endpoint pool with health: latency sparkline, failure & rate-limit counts, backoff state, pause/resume.
// Each endpoint owns its voice list (what the character pickers offer) and a per-request character
// limit — longer segments are split into several requests and joined, since many TTS servers degrade
// or truncate past a few hundred characters.
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useApp } from '../../stores/app'
import { speak } from '../../composables/usePlayer'
import { UiSlider, UiSelect, UiTooltip } from '../../ui'
import { SPLIT_MODES, splitText } from '../../lib/split'
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui'
const props = defineProps({ bookId: String })
const app = useApp()
const now = ref(Date.now()); let t
onMounted(() => { t = setInterval(() => now.value = Date.now(), 500) }); onUnmounted(() => clearInterval(t))

// per-endpoint "add voice" mini form
const draft = reactive({})
const form = (e) => draft[e.id] ??= { id: '', label: '', gender: 'n', open: false }
const GENDERS = [{ value: 'f', label: 'female' }, { value: 'm', label: 'male' }, { value: 'n', label: 'neutral' }]
const LIMITS = [{ value: 0, label: 'no limit' }, { value: 300, label: '300' }, { value: 500, label: '500' }, { value: 1000, label: '1,000' }, { value: 2000, label: '2,000' }, { value: 4096, label: '4,096' }]
function submit(e) {
  const f = form(e)
  if (app.addVoice(e, f)) { f.id = ''; f.label = '' }
}
const splitOf = (e) => app.splitCount(props.bookId, e)
const MODE_OPTS = SPLIT_MODES.map(m => ({ value: m.value, label: m.label, hint: m.hint }))
const AT = { sentence: 'sentence end', clause: 'clause', word: 'word', char: 'hard cut' }
// the longest segment of the open book routed to this endpoint, cut with its current settings
const longest = (e) => {
  let best = null
  for (const k of Object.keys(app.segments)) if (k.startsWith(props.bookId + ':')) for (const s of app.segments[k]) if (app.effectiveVoice(props.bookId, s.speaker).endpoint?.id === e.id && (!best || s.text.length > best.text.length)) best = s
  return best
}
const preview = (e) => { const s = longest(e); return s ? { seg: s, parts: splitText(s.text, e.maxChars, e.splitAt) } : null }
const usedBy = (e, v) => (app.characters[props.bookId] ?? []).filter(c => c.voice === `${e.id}/${v.id}`).map(c => c.name)
const GENDER_CH = { m: '♂', f: '♀', n: '◦' }

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
const inUse = computed(() => { const m = {}; for (const c of app.characters[props.bookId] ?? []) if (c.voice) m[c.voice.split('/')[0]] = (m[c.voice.split('/')[0]] ?? 0) + 1; return m })
</script>
<template>
  <div class="p-3">
    <div class="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-3">
      <div v-for="e in app.endpoints" :key="e.id" class="rounded-lg border p-3 text-sm" :class="e.enabled ? 'border-emerald-400/60' : 'border-zinc-200 dark:border-zinc-800'">
        <div class="mb-1 flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" :class="{ 'bg-emerald-500': health(e) === 'healthy', 'bg-amber-500': health(e) === 'degraded', 'bg-violet-500 animate-pulse': health(e) === 'backing off', 'bg-zinc-400': health(e) === 'paused' }"></span>
          <input v-model="e.name" class="min-w-0 flex-1 bg-transparent font-medium focus:outline-none" />
          <span v-if="e.needsKey && !e.apiKey" class="rounded bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-500">no key</span>
          <span class="rounded bg-zinc-100 px-1.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{{ e.price ? '$' + e.price + '/1M chars' : 'free' }}</span>
          <button class="btn-ghost btn-xs" @click="e.enabled = !e.enabled">{{ e.enabled ? '❚❚ Pause' : '▶ Resume' }}</button>
        </div>
        <div v-if="!e.enabled && inUse[e.id]" class="mb-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">{{ inUse[e.id] }} speaker{{ inUse[e.id] === 1 ? '' : 's' }} in this book use a voice from this endpoint — their lines can’t render while it’s paused.</div>

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
          <span class="self-center text-zinc-500">Max chars / request</span>
          <div class="flex items-center gap-2">
            <input v-model.number="e.maxChars" type="number" min="0" step="50" class="input w-20 py-0.5 font-mono" placeholder="0" />
            <UiSelect :model-value="LIMITS.some(l => l.value === e.maxChars) ? e.maxChars : undefined" :options="LIMITS" placeholder="preset" size="xs" class="w-24" @update:model-value="v => e.maxChars = v" />
            <UiTooltip text="Segments longer than this are cut, sent as several requests, and the audio joined. 0 = send whole segments.">
              <span class="text-zinc-400">
                <template v-if="!e.maxChars">whole segments</template>
                <template v-else-if="splitOf(e)"><span class="text-amber-600">{{ splitOf(e) }} segment{{ splitOf(e) === 1 ? '' : 's' }} in this book would be split</span></template>
                <template v-else>nothing in this book exceeds it</template>
              </span>
            </UiTooltip>
          </div>
          <template v-if="e.maxChars">
            <span class="self-center text-zinc-500">Cut at</span>
            <div class="flex items-center gap-2">
              <UiSelect v-model="e.splitAt" :options="MODE_OPTS" size="xs" class="w-36" />
              <span class="text-zinc-400">falls back to the next finer boundary when none fits</span>
            </div>
          </template>
        </div>
        <CollapsibleRoot v-if="e.maxChars && preview(e)?.parts.length > 1" class="mt-2 text-xs">
          <CollapsibleTrigger class="text-zinc-400 hover:text-violet-500 data-[state=open]:text-violet-500">▸ preview: longest routed segment ({{ preview(e).seg.text.length }} chars, {{ preview(e).seg.speaker }}) → {{ preview(e).parts.length }} requests</CollapsibleTrigger>
          <CollapsibleContent>
            <ol class="mt-1 space-y-1">
              <li v-for="(pt, i) in preview(e).parts" :key="i" class="rounded border border-zinc-200 px-2 py-1 dark:border-zinc-800">
                <div class="mb-0.5 flex gap-2 font-mono text-[10px] text-zinc-400"><span>part {{ i + 1 }}</span><span>{{ pt.text.length }} ch</span><span v-if="pt.at" :class="pt.fallback && 'text-amber-600'">cut at {{ AT[pt.at] }}{{ pt.fallback ? ' (no ' + AT[e.splitAt] + ' in range)' : '' }}</span></div>
                <div class="line-clamp-2 text-zinc-600 dark:text-zinc-400">{{ pt.text }}</div>
              </li>
            </ol>
          </CollapsibleContent>
        </CollapsibleRoot>

        <!-- voices -->
        <div class="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <div class="mb-1.5 flex items-center gap-2 text-xs">
            <b>Voices</b><span class="text-zinc-400">{{ e.voices.length }}</span>
            <span v-if="inUse[e.id]" class="text-zinc-400">· {{ inUse[e.id] }} in use here</span>
            <span class="ml-auto flex gap-1">
              <button class="btn-ghost btn-xs" :disabled="e.fetching" @click="app.fetchVoices(e)">{{ e.fetching ? 'fetching…' : '⇣ Fetch from server' }}</button>
              <button class="btn-ghost btn-xs" @click="form(e).open = !form(e).open">{{ form(e).open ? 'close' : '＋ Add voice' }}</button>
            </span>
          </div>
          <div v-if="!e.voices.length" class="rounded border border-dashed border-zinc-300 px-2 py-2 text-[11px] text-zinc-400 dark:border-zinc-700">No voices yet — fetch the server’s list or add one by its id. Characters can only pick voices that exist here.</div>
          <div class="flex flex-wrap gap-1">
            <span v-for="v in e.voices" :key="v.id" class="group inline-flex items-center gap-1 rounded-full border border-zinc-200 py-0.5 pl-2 pr-1 text-[11px] dark:border-zinc-700" :class="usedBy(e, v).length && 'border-violet-400 bg-violet-50 dark:bg-violet-500/10'" :title="usedBy(e, v).length ? 'used by ' + usedBy(e, v).join(', ') : v.id">
              <span class="text-zinc-400">{{ GENDER_CH[v.gender] ?? '◦' }}</span>
              <span>{{ v.label }}</span><span v-if="v.label !== v.id" class="font-mono text-[9px] text-zinc-400">{{ v.id }}</span>
              <span v-if="usedBy(e, v).length" class="rounded bg-violet-500/15 px-1 font-mono text-[9px] text-violet-600 dark:text-violet-300">{{ usedBy(e, v).length }}</span>
              <button class="rounded px-1 text-zinc-400 hover:bg-zinc-100 hover:text-violet-500 dark:hover:bg-zinc-800" title="demo (browser voice)" @click="speak('The mountain mist thinned as dawn crept over the outer sect grounds.', v.id)">▶</button>
              <button class="rounded px-1 text-zinc-400 hover:bg-red-500/10 hover:text-red-500" :title="usedBy(e, v).length ? 'remove — ' + usedBy(e, v).length + ' speaker(s) will show a missing voice' : 'remove'" @click="app.removeVoice(e, v.id)">✕</button>
            </span>
          </div>
          <form v-if="form(e).open" class="mt-2 flex flex-wrap items-center gap-1.5 text-xs" @submit.prevent="submit(e)">
            <input v-model="form(e).id" class="input w-28 py-0.5 font-mono" placeholder="voice id" required />
            <input v-model="form(e).label" class="input w-24 py-0.5" placeholder="label (optional)" />
            <UiSelect v-model="form(e).gender" :options="GENDERS" size="xs" class="w-24" />
            <button class="btn-primary btn-xs" type="submit">Add</button>
            <span v-if="form(e).id && e.voices.some(v => v.id === form(e).id.trim())" class="text-amber-600">already exists</span>
          </form>
        </div>
        <div class="mt-2 text-right"><button class="text-[11px] text-zinc-400 hover:text-red-500" @click="app.removeEndpoint(e.id)">remove endpoint</button></div>
      </div>
      <button class="grid min-h-28 place-items-center rounded-lg border border-dashed border-zinc-300 text-sm text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700" @click="app.addEndpoint()">＋ Add endpoint</button>
    </div>
  </div>
</template>
