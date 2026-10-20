<script setup lang="ts">
// The Scripting page's endpoint picker: every scripting endpoint as a row with its rates, chunking
// and health, and a latency sparkline so a flaky one shows before it is picked. Settings are
// edited on the Endpoints page.
import { computed } from "vue";
import { useNow } from "@vueuse/core";
import { ArrowUpRight as ArrowIcon, Check as PickedIcon } from "@lucide/vue";
import LatencySparkline from "@/components/LatencySparkline.vue";
import { keyInPlace } from "@/services/endpointSettings";
import { profileErrors, scriptingHealth } from "@/lib/scripting";
import { money } from "@/lib/pricing";
import { scriptTelemetry } from "@/lib/scriptActivity";
import { useScriptActivity, useScriptTotals } from "@/queries/scriptActivity";
import { useEndpointsStore } from "@/stores/endpoints";
import { useScriptingStore } from "@/stores/scripting";
import type { Profile } from "@/types";

const endpointsStore = useEndpointsStore();
const scriptingStore = useScriptingStore();
const activity = useScriptActivity();
const totals = useScriptTotals();
const clock = useNow({ interval: 1000 });
const current = computed(() => scriptingStore.runProfile?.id);
const DOT: Record<string, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  muted: "bg-zinc-400",
};
const rows = computed(() =>
  endpointsStore.profiles.map((p) => {
    const t = scriptTelemetry(activity.rowsOf(p.id), p);
    const health =
      activity.data.value === undefined
        ? { label: "…", tone: "muted" }
        : scriptingHealth(p, t, keyInPlace(p), clock.value.getTime());
    const week = totals.totalsOf(p.id);
    const ok = t.history.filter((x) => x.ok);
    const latency = ok.length ? ok.reduce((n, x) => n + x.ms, 0) / ok.length / 1000 : null;
    const success =
      week && week.eventualOk + week.failures
        ? Math.round((week.eventualOk / (week.eventualOk + week.failures)) * 100) + "%"
        : "—";
    return {
      p,
      picked: p.id === current.value,
      health,
      errors: profileErrors(p),
      week,
      ok,
      latency,
      success,
    };
  }),
);
const pick = (p: Profile) => (scriptingStore.scriptSettings.profile = p.id);
</script>

<template>
  <div class="text-xs">
    <div
      class="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800"
    >
      <span class="label">Runs go to</span>
      <RouterLink
        :to="
          current
            ? { path: '/endpoints', query: { endpoint: `scripting:${current}`, tab: 'connection' } }
            : '/endpoints'
        "
        class="inline-flex items-center gap-1 text-violet-600 hover:underline dark:text-violet-400"
        :data-tip="
          rows.length
            ? 'connection, limits and pricing, with the request history'
            : 'Add a scripting endpoint'
        "
        >{{ rows.length ? "Edit on the Endpoints page" : "Add one on the Endpoints page" }}
        <ArrowIcon class="icon-sm"
      /></RouterLink>
    </div>
    <p v-if="!rows.length" class="p-4 text-zinc-500">{{ scriptingStore.runBlockers[0] }}</p>
    <button
      v-for="r in rows"
      :key="r.p.id"
      class="flex w-full items-center gap-3 border-b border-zinc-100 px-3 py-2 text-left last:border-0 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
      :class="r.picked && 'bg-violet-50 dark:bg-violet-500/10'"
      :aria-pressed="r.picked"
      @click="pick(r.p)"
    >
      <span
        class="grid h-4 w-4 shrink-0 place-content-center rounded-full border"
        :class="
          r.picked
            ? 'border-violet-600 bg-violet-600 text-white'
            : 'border-zinc-300 dark:border-zinc-600'
        "
        ><PickedIcon v-if="r.picked" class="h-3 w-3"
      /></span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2">
          <span class="truncate text-sm font-medium">{{ r.p.name || "Untitled endpoint" }}</span>
          <span class="truncate font-mono text-zinc-500">{{ r.p.model || "model required" }}</span>
        </span>
        <span class="mt-0.5 block truncate text-[11px] text-zinc-500">
          {{ money(r.p.inPrice) }} in / {{ money(r.p.outPrice) }} out per 1M ·
          {{ r.p.maxChars ? r.p.maxChars.toLocaleString() + " chars / request" : "whole chapters" }}
          · {{ r.p.concurrency }} at once<template v-if="r.p.reasoning">
            · thinks {{ r.p.reasoning }}</template
          >
        </span>
        <span
          v-for="e in r.errors"
          :key="e"
          class="block text-[11px] text-amber-700 dark:text-amber-400"
          >{{ e }}</span
        >
      </span>
      <span class="shrink-0 text-right">
        <span
          class="flex items-center justify-end gap-1.5 text-[11px]"
          :class="r.health.tone === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500'"
        >
          <span class="h-1.5 w-1.5 rounded-full" :class="DOT[r.health.tone]"></span
          >{{ r.health.label }}
        </span>
        <span
          class="mt-0.5 flex items-center justify-end gap-1.5 font-mono text-[11px] text-zinc-500"
          data-tip="success rate this week · average latency"
        >
          <template v-if="r.week"
            >{{ r.success }} · {{ r.latency === null ? "—" : r.latency.toFixed(1) + "s" }}</template
          >
          <template v-else>quiet this week</template>
          <LatencySparkline :points="r.ok" />
        </span>
      </span>
    </button>
  </div>
</template>
