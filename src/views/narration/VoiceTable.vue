<script setup>
// Cast → voice assignment. Main cast as cards; minor cast collapsed and falling back to the
// Narrator's voice unless given one. Search, "unassigned only", auto-assign by gender.
import { computed, ref } from 'vue'
import { useApp } from '../../stores/app'
import { VOICES } from '../../mock/data'
import { speak } from '../../composables/usePlayer'
import { UiSelect, UiCheckbox, UiTooltip } from '../../ui'
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui'
const voiceOpts = VOICES.map(v => ({ value: v, label: v }))

const props = defineProps({ bookId: String })
const app = useApp()
const q = ref('')
const unassignedOnly = ref(false)
const showMinor = ref(false)
const revealed = ref(new Set())

const all = computed(() => app.charactersOf(props.bookId))
const counts = computed(() => app.lineCounts(props.bookId))
const match = (c) => (!q.value || c.name.toLowerCase().includes(q.value.toLowerCase()) || c.aliases.some(a => a.toLowerCase().includes(q.value.toLowerCase()))) && (!unassignedOnly.value || !c.voice)
const major = computed(() => all.value.filter(c => c.major || c.isNew).filter(match))
const minor = computed(() => all.value.filter(c => !c.major && !c.isNew).sort((a, b) => (counts.value[b.name] ?? 0) - (counts.value[a.name] ?? 0)).filter(match))
const assigned = computed(() => all.value.filter(c => c.voice).length)
const narrator = computed(() => all.value.find(c => c.name === 'Narrator'))
const genderLabel = { m: 'male', f: 'female', n: 'neutral', '?': 'unknown' }
const sample = (c) => c.name === 'Narrator' ? 'The mountain mist thinned as dawn crept over the outer sect grounds.' : 'I have not come to fight. Give me three days, that is all I ask.'
</script>

<template>
  <div class="p-3">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="text-sm"><b>{{ assigned }}</b> of {{ all.length }} voices assigned <span class="text-zinc-500">· the rest fall back to the Narrator’s voice ({{ narrator?.voice ?? 'unset' }})</span></div>
      <div class="ml-auto flex items-center gap-2">
        <input v-model="q" class="input w-44 py-1" placeholder="Find a speaker…" />
        <label class="flex items-center gap-1.5 text-xs"><UiCheckbox v-model="unassignedOnly" /> Unassigned only</label>
        <button class="btn-ghost btn-xs" @click="app.autoAssignByGender(bookId)">Auto-assign all by gender</button>
        <RouterLink :to="`/book/${bookId}/cast`" class="btn-ghost btn-xs">Full cast →</RouterLink>
      </div>
    </div>

    <div v-if="!narrator?.voice" class="mb-3 rounded-md border border-amber-400 bg-amber-400/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">Assign the Narrator’s voice first: every unvoiced character borrows it.</div>

    <div class="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-3">
      <div v-for="c in major" :key="c.name" class="rounded-lg border p-3 text-sm" :class="c.isNew ? 'border-dashed border-amber-400' : 'border-zinc-200 dark:border-zinc-800'" :style="{ borderTopColor: c.color, borderTopWidth: '3px' }">
        <div class="flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full" :style="{ background: c.color }"></span>
          <b class="min-w-0 flex-1 truncate">{{ c.name }}</b>
          <span class="text-[11px] text-zinc-400">{{ genderLabel[c.gender] ?? 'unknown' }}</span>
        </div>
        <div class="mt-1 text-[11px] text-zinc-500">{{ counts[c.name] ?? 0 }} segments<span v-if="c.aliases.length"> · a.k.a. {{ c.aliases.join(', ') }}</span></div>
        <div class="mt-2 min-h-8 text-xs leading-snug text-zinc-600 dark:text-zinc-400">
          <template v-if="!c.description"><span class="italic text-zinc-400">No description.</span></template>
          <template v-else-if="revealed.has(c.name) || c.name === 'Narrator'">{{ c.description }}</template>
          <button v-else class="rounded border border-dashed border-zinc-300 px-2 py-0.5 italic text-zinc-400 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700" @click="revealed = new Set([...revealed, c.name])">description hidden — spoilers · show</button>
        </div>
        <div class="mt-2 flex items-center gap-1.5">
          <UiSelect v-model="c.voice" :options="voiceOpts" null-value="Narrator’s voice" class="min-w-0 flex-1" block />
          <UiTooltip text="Prototype: plays a browser voice, not the real TTS voice"><button class="btn-ghost btn-xs" :disabled="!app.effectiveVoice(bookId, c.name).voice" @click="speak(sample(c), app.effectiveVoice(bookId, c.name).voice)">▶<span class="text-[9px] text-zinc-400">demo</span></button></UiTooltip>
        </div>
        <input v-model="c.style" class="input mt-1.5 w-full py-1 text-xs" placeholder="style: e.g. gravelly, elderly; speaks slowly" />
      </div>
    </div>

    <CollapsibleRoot v-model:open="showMinor" class="mt-3">
      <CollapsibleTrigger class="flex w-full items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm hover:bg-zinc-50 data-[state=open]:rounded-b-none dark:border-zinc-800 dark:hover:bg-zinc-800/60">
        <span class="text-zinc-400">{{ showMinor ? '▾' : '▸' }}</span><b>Minor cast ({{ minor.length }})</b>
        <span class="text-xs text-zinc-500">{{ minor.filter(c => c.voice).length }} assigned · rest use the Narrator’s voice</span>
      </CollapsibleTrigger>
      <CollapsibleContent class="rounded-b-lg border border-t-0 border-zinc-200 dark:border-zinc-800">
        <table class="w-full text-sm">
          <tr v-for="c in minor" :key="c.name" class="border-t border-zinc-100 first:border-0 dark:border-zinc-800/70">
            <td class="py-1 pl-3"><span class="rounded-full px-2 py-0.5 text-xs" :style="{ background: c.color + '33', color: c.color }">{{ c.name }}</span></td>
            <td class="w-20 text-xs text-zinc-500">{{ genderLabel[c.gender] ?? 'unknown' }}</td>
            <td class="w-16 font-mono text-xs text-zinc-400">{{ counts[c.name] ?? 0 }} seg</td>
            <td class="w-52 py-1 pr-3 text-right"><UiSelect v-model="c.voice" :options="voiceOpts" null-value="Narrator’s voice" size="xs" block /></td>
          </tr>
        </table>
      </CollapsibleContent>
    </CollapsibleRoot>
  </div>
</template>
