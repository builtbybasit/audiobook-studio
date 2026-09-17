<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useNarrationStore } from "@/stores/narration";

// "This run" panel: what the current chapter selection will cost before pressing Narrate. Cost and
// request counts are per endpoint, because each speaker's voice pins its lines to one endpoint and
// long segments split against that endpoint's per-request limit.
import { computed } from "vue";
import { runSummary, SCOPE_HELP, SCOPE_LABEL, skipSummary } from "@/lib/runPlan";
import { UiSwitch, UiToggleGroup } from "@/ui";
import { TriangleAlert as WarnIcon } from "@lucide/vue";
import type { NarrationScope } from "@/types";
// `blockers` is worked out by the view, not here: the run strip says how many there are and this
// panel lists them, and one calculation is how those two stay in agreement.
const props = defineProps<{ bookId: string; selected: number[]; blockers: string[] }>();
const scope = defineModel<NarrationScope>("scope", { default: "fill" });
const keepPending = defineModel<boolean>("keepPending", { default: true });
const castStore = useCastStore();
const narrationStore = useNarrationStore();
const est = computed(() =>
  narrationStore.estimate(props.bookId, props.selected, scope.value, keepPending.value),
);
const plan = computed(() =>
  narrationStore.narrationRunPlan(props.bookId, props.selected, scope.value, keepPending.value),
);
const scopes: { value: NarrationScope; label: string }[] = (
  ["fill", "failed", "all"] as NarrationScope[]
).map((value) => ({ value, label: SCOPE_LABEL[value] }));
const cast = computed(() => castStore.charactersOf(props.bookId));
const voiced = computed(() => cast.value.filter((c) => c.voice).length);
const expressions = computed(() =>
  narrationStore.expressionIssues(
    props.bookId,
    plan.value.chapters.map((c) => c.id),
  ),
);
const fmt = (s: number) =>
  s >= 3600
    ? `~${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
    : `~${Math.round(s / 60)}m`;
const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
defineExpose({ scope, keepPending, plan });
</script>
<template>
  <div class="text-xs">
    <div class="label mb-1.5">This run</div>
    <!-- what the run is for. The estimate below counts this scope, not every line in the book. -->
    <UiToggleGroup v-model="scope" :options="scopes" block size="xs" />
    <p class="mb-2 mt-1 text-[11px] leading-snug text-zinc-500">{{ SCOPE_HELP[scope] }}</p>
    <!-- only shown when this scope actually reaches lines with a retake waiting, and shown in
         both switch positions: the count is what the choice is about, not what it left behind. -->
    <div v-if="est.pending" class="mb-2">
      <UiSwitch v-model="keepPending" label="Keep retakes waiting for a verdict" />
      <p class="mt-1 text-[11px] leading-snug text-zinc-500">
        {{
          keepPending
            ? `${est.pending} line${est.pending === 1 ? "" : "s"} this scope would render ${est.pending === 1 ? "has" : "have"} a retake to judge, and ${est.pending === 1 ? "is" : "are"} left out of this run.`
            : `${est.pending} retake${est.pending === 1 ? "" : "s"} waiting for a verdict ${est.pending === 1 ? "joins" : "join"} that line’s take list, still playable, and the line is rendered again — the clip in the book keeps playing until its replacement lands.`
        }}
      </p>
    </div>
    <div class="grid grid-cols-2 gap-x-4 gap-y-1">
      <span class="text-zinc-500">Chapters</span
      ><span class="text-right font-mono">{{ est.chapters }}</span>
      <span class="text-zinc-500">Clips to render</span
      ><span class="text-right font-mono">{{ est.segments }}</span>
      <span class="text-zinc-500">Characters</span
      ><span class="text-right font-mono">{{ k(est.chars) }}</span>
      <span class="text-zinc-500">Requests</span
      ><span class="text-right font-mono"
        >{{ est.requests
        }}<span
          v-if="est.split"
          class="text-amber-600"
          :title="`${est.split} segments exceed their endpoint’s per-request limit and are sent in parts`"
        >
          · {{ est.split }} split</span
        ></span
      >
      <span class="text-zinc-500">Audio</span
      ><span class="text-right font-mono">{{ est.chapters ? fmt(est.seconds) : "—" }}</span>
      <span class="text-zinc-500">Voices set</span
      ><span class="text-right font-mono">{{ voiced }}/{{ cast.length }}</span>
      <span class="text-zinc-500">Est. cost</span
      ><span class="text-right font-mono font-semibold text-amber-600"
        >${{ est.cost.toFixed(2) }}</span
      >
    </div>
    <p v-if="plan.chapters.length" class="mt-1.5 leading-snug text-zinc-500">
      {{ runSummary(plan).join(" · ") }}.
      <span v-if="est.replacing"
        >{{ est.replacing }} clip{{ est.replacing === 1 ? "" : "s" }} already
        {{ est.replacing === 1 ? "plays" : "play" }} in the book — each keeps playing until its
        replacement succeeds, and the clip it displaces joins that line’s take list.</span
      >
    </p>
    <p v-if="skipSummary(plan)" class="mt-1 leading-snug text-amber-700 dark:text-amber-400">
      {{ skipSummary(plan) }}
    </p>
    <div v-if="est.per.length" class="mt-2 border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
      <div class="mb-1 text-[10px] uppercase tracking-wider text-zinc-400">By endpoint</div>
      <div v-for="e in est.per" :key="e.endpoint.id" class="flex items-center gap-2 py-0.5">
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          :class="e.endpoint.enabled ? 'bg-emerald-500' : 'bg-zinc-400'"
        ></span>
        <span
          class="min-w-0 flex-1 truncate"
          :class="!e.endpoint.enabled && 'text-zinc-400 line-through'"
          >{{ e.endpoint.name }}</span
        >
        <span
          class="font-mono text-zinc-500"
          :title="`${e.segments} segments · ${e.requests} requests${e.endpoint.maxChars ? ' · limit ' + e.endpoint.maxChars : ''}`"
          >{{ e.requests }} req</span
        >
        <span class="w-12 text-right font-mono text-zinc-500">{{
          e.endpoint.price ? "$" + ((e.chars / 1e6) * e.endpoint.price).toFixed(2) : "free"
        }}</span>
      </div>
      <div v-if="est.unrouted" class="mt-0.5 text-amber-600">
        {{ est.unrouted }} segments have no endpoint (voice missing).
      </div>
    </div>
    <div v-for="b in blockers" :key="b" class="mt-2 text-amber-600">
      <WarnIcon class="icon-sm" /> {{ b }}
    </div>
    <div
      v-if="expressions.length"
      class="mt-2 rounded bg-amber-50 p-2 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
    >
      <WarnIcon class="icon-sm" /> {{ expressions.length }} expressions need review. Press Narrate
      to resolve them before any work is queued.
    </div>
  </div>
</template>
