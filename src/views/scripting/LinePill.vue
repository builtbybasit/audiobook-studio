<script setup lang="ts">
// A line's speaker pill and effect chips. A persona hides whose it is when the model made the link
// (`masked`), to avoid spoilers. Hundreds per chapter, so only store-map lookups here.
import { computed } from "vue";
import { AudioLines as EffectIcon, VenetianMask as MaskIcon } from "@lucide/vue";
import { personaOwner } from "@/lib/cast";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import type { Segment } from "@/types";

const props = defineProps<{ bookId: string; s: Segment; color: string }>();
const castStore = useCastStore();
const effectsStore = useEffectsStore();
const persona = computed(() => {
  const byName = castStore.byName[props.bookId];
  const c = byName?.get(props.s.speaker);
  const owner = byName && personaOwner(c, byName);
  return owner && { of: owner.name, masked: !!c?.masked };
});
/** library order is run order; unknown ids are skipped */
const effects = computed(() =>
  props.s.effects?.length
    ? effectsStore.effects.filter((e) => props.s.effects!.includes(e.id))
    : [],
);
</script>

<template>
  <span
    class="flex items-center gap-1 rounded-full px-2 py-0.5 font-medium"
    :style="{ background: color + '33', color }"
    :title="persona && !persona.masked ? `${persona.of} as ${s.speaker}` : undefined"
  >
    <span class="opacity-70">{{ s.type === "thought" ? "…" : "“" }}</span>
    <MaskIcon v-if="persona" class="icon-sm" aria-hidden="true" />
    {{ s.speaker }}
  </span>
  <span
    v-for="e in effects"
    :key="e.id"
    class="flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-300"
    :title="e.useWhen ? `Line effect · use when ${e.useWhen}` : 'Line effect'"
    ><EffectIcon class="icon-sm" aria-hidden="true" />{{ e.name }}</span
  >
</template>
