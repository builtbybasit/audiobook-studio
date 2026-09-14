<script setup>
// Run settings + estimate for scripting: LLM profile, chunk size, watermark stripping, cost/time.
import { computed } from "vue";
import { useApp } from "../../stores/app";
import { UiSelect, UiSlider, UiSwitch } from "../../ui";
import { keyring } from "../../lib/keyring";
const props = defineProps({ bookId: String, selected: Array });
const app = useApp();
const est = computed(() => app.scriptEstimate(props.bookId, props.selected));
const fmt = (s) =>
  s >= 3600
    ? `~${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
    : s >= 60
      ? `~${Math.round(s / 60)} min`
      : `~${Math.round(s)}s`;
</script>
<template>
  <div class="text-xs">
    <div class="label mb-1.5">Run settings</div>
    <div class="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
      <span class="text-zinc-500">Profile</span>
      <UiSelect
        v-model="app.scriptSettings.profile"
        :options="app.profiles.map((p) => ({ value: p.id, label: p.name, hint: p.model }))"
        size="xs"
        block
      />
      <span class="text-zinc-500">Chunk</span>
      <div class="flex items-center gap-2">
        <UiSlider
          v-model="app.scriptSettings.chunkChars"
          :min="2000"
          :max="12000"
          :step="500"
          label="Chunk size"
        /><span class="w-12 font-mono"
          >{{ (app.scriptSettings.chunkChars / 1000).toFixed(1) }}k</span
        >
      </div>
      <span class="text-zinc-500">Watermarks</span>
      <UiSwitch v-model="app.scriptSettings.stripWatermarks" label="strip site boilerplate" />
    </div>
    <div v-if="est.profile?.needsKey" class="mt-1.5 flex items-center gap-2">
      <span class="text-zinc-500">Key</span
      ><input
        :value="keyring.get('profile:' + est.profile.id)"
        type="password"
        class="input min-w-0 flex-1 py-0.5 font-mono"
        :placeholder="
          keyring.has('profile:' + est.profile.id) ? '' : 'paste API key (kept in memory only)'
        "
        @input="keyring.set('profile:' + est.profile.id, $event.target.value)"
      /><span v-if="!keyring.has('profile:' + est.profile.id)" class="text-amber-600"
        >⚠ no key</span
      >
    </div>
    <div class="label mb-1 mt-3">This run</div>
    <div class="grid grid-cols-2 gap-x-4 gap-y-0.5">
      <span class="text-zinc-500">Chapters</span
      ><span class="text-right font-mono">{{ est.chapters }}</span>
      <span class="text-zinc-500">Chunks</span
      ><span class="text-right font-mono">{{ est.chunks }}</span>
      <span class="text-zinc-500">Text</span
      ><span class="text-right font-mono">{{ (est.chars / 1000).toFixed(0) }}k chars</span>
      <span class="text-zinc-500">Time</span
      ><span class="text-right font-mono">{{ est.chapters ? fmt(est.seconds) : "—" }}</span>
      <span class="text-zinc-500">Est. cost</span
      ><span class="text-right font-mono font-semibold text-amber-600">{{
        est.cost ? "$" + est.cost.toFixed(2) : "free"
      }}</span>
    </div>
    <div class="mt-1 text-[10px] text-zinc-400">
      Sequential per book: chapters wait on each other so roster and recap carry forward.
    </div>
  </div>
</template>
