<script setup lang="ts">
// A dialogue or thought line's speaker pill, then a chip for each of its line effects. A linked
// persona is the speaker — their own name and colour — with a mask, and says whose persona they are
// on hover, unless the scripting model made the link (`masked`), which would spoil it. A chapter
// has hundreds of these, so each is a lookup in maps the stores already keep.
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
/** in the library's order, which is the order they run in; an id no effect has is passed over */
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
