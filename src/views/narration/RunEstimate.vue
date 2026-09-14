<script setup lang="ts">
// "This run" panel: what the current chapter selection will cost before pressing Narrate. Cost and
// request counts are per endpoint, because each speaker's voice pins its lines to one endpoint and
// long segments split against that endpoint's per-request limit.
import { computed } from "vue";
import { useApp, keyring } from "@/stores/app";
import { TriangleAlert as WarnIcon } from "@lucide/vue";
const props = defineProps<{ bookId: string; selected: number[] }>();
const app = useApp();
const est = computed(() => app.estimate(props.bookId, props.selected));
const cast = computed(() => app.charactersOf(props.bookId));
const voiced = computed(() => cast.value.filter((c) => c.voice).length);
const narratorOk = computed(() => !!cast.value.find((c) => c.name === "Narrator")?.voice);
const issues = computed(() => app.routingIssues(props.bookId));
const blockers = computed(() => {
  const b = [];
  if (!narratorOk.value) b.push("Assign the Narrator’s voice to start.");
  if (!est.value.endpoints) b.push("Enable at least one endpoint.");
  const book = app.bookById(props.bookId);
  if (book?.budget?.paused) b.push("This book is paused (overview → resume).");
  if (book?.budget?.cap && app.spent(props.bookId) + est.value.cost > book.budget.cap)
    b.push(
      `Over the $${book.budget.cap} budget cap: $${app.spent(props.bookId).toFixed(2)} spent + $${est.value.cost.toFixed(2)} for this run.`,
    );
  const byReason: Record<string, string[]> = {};
  for (const i of issues.value) (byReason[i.reason] ??= []).push(i.name);
  for (const [reason, names] of Object.entries(byReason))
    b.push(
      `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}: ${reason}.`,
    );
  return b;
});
const fmt = (s: number) =>
  s >= 3600
    ? `~${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
    : `~${Math.round(s / 60)}m`;
const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
defineExpose({ blockers });
</script>
<template>
  <div class="text-xs">
    <div class="label mb-1.5">This run</div>
    <div class="grid grid-cols-2 gap-x-4 gap-y-1">
      <span class="text-zinc-500">Chapters</span
      ><span class="text-right font-mono">{{ est.chapters }}</span>
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
  </div>
</template>
