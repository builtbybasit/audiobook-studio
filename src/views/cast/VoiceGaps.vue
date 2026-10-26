<script setup lang="ts">
// What the voice library lacks for this book: kinds of speaker (gender and age) with no profiled
// voice of that kind. Counts only, never names. Says nothing until enough voices have a profile.
import { computed, ref } from "vue";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui";
import { ChevronRight as ExpandIcon } from "@lucide/vue";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { FIT_MIN, voiceGaps } from "@/lib/voiceMatch";
import { plural } from "@/lib/contents";
import { UiHint } from "@/ui";
import type { CastStat } from "@/types";

const props = defineProps<{ bookId: string; stats: Record<string, CastStat> }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const pool = computed(() => castStore.matchPool);
const weak = computed(() => pool.value.profiled < FIT_MIN);
const gaps = computed(() =>
  weak.value ? [] : voiceGaps(castStore.charactersOf(props.bookId), pool.value.voices, props.stats),
);
const open = ref(false);
/** The Voices tab of the first endpoint with voices, where profiles are filled and voices cloned. */
const voicesTab = computed(() => {
  const ep = endpointsStore.enabledEndpoints.find((e) => e.voices.length);
  return ep
    ? { path: "/endpoints", query: { endpoint: `tts:${ep.id}`, tab: "voices" } }
    : "/endpoints";
});
</script>

<template>
  <p v-if="weak && pool.voices.length" class="text-xs text-zinc-400">
    Profile a few voices on
    <RouterLink :to="voicesTab" class="underline hover:text-violet-500"
      >Endpoints → Voices</RouterLink
    >
    for voice suggestions and to see what this book lacks.
  </p>
  <CollapsibleRoot v-else-if="gaps.length" v-model:open="open" class="card">
    <div class="flex items-center gap-2 px-4 py-2.5">
      <CollapsibleTrigger class="flex min-w-0 flex-1 items-center gap-2 text-left">
        <ExpandIcon
          class="icon-sm shrink-0 text-zinc-400 transition-transform"
          :class="open && 'rotate-90'"
          aria-hidden="true"
        />
        <span class="label shrink-0">Voice gaps</span>
        <span class="min-w-0 truncate text-xs text-zinc-500"
          >{{
            gaps
              .slice(0, 3)
              .map((g) => `${g.label} ${g.speakers}`)
              .join(" · ")
          }}<template v-if="gaps.length > 3"> · {{ gaps.length - 3 }} more</template></span
        >
      </CollapsibleTrigger>
      <UiHint
        label="voice gaps"
        text="Speakers in this book with no voice of that kind in your library — clone some to cover them."
      />
    </div>
    <CollapsibleContent>
      <div
        v-for="g in gaps"
        :key="`${g.gender}|${g.age}`"
        class="flex items-center gap-3 border-t border-zinc-100 px-4 py-1.5 text-xs dark:border-zinc-800/70"
      >
        <span class="w-36 font-medium">{{ g.label }}</span>
        <span class="text-zinc-500">{{ plural(g.speakers, "speaker") }}</span>
        <span class="text-zinc-400">{{
          g.voices ? `only ${plural(g.voices, "voice")}` : "no voice of this kind"
        }}</span>
      </div>
      <div class="border-t border-zinc-100 px-4 py-2 text-xs dark:border-zinc-800/70">
        <RouterLink :to="voicesTab" class="text-violet-600 hover:underline dark:text-violet-300"
          >Clone or add voices →</RouterLink
        >
      </div>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
