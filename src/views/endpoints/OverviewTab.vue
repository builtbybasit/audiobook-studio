<script setup lang="ts">
// How this endpoint has been behaving, over a range you choose.
//
// Two things are deliberately kept apart everywhere on this tab: the time a request spends waiting
// for one of our own concurrency slots, and the time the provider takes to answer. They look the
// same in a single "latency" number and they have completely different fixes.
//
// Success is also two numbers — right first time, and right in the end — because an endpoint that
// only ever succeeds on its third attempt is not the same as a healthy one.
import { computed } from "vue";
import { UiToggleGroup, UiTooltip } from "@/ui";
import MetricChart from "@/views/endpoints/MetricChart.vue";
import { RANGES } from "@/services/endpoints";
import {
  TEXT,
  compact,
  duration,
  metricValue,
  money,
  throughputLabel,
  throughputUnit,
} from "@/lib/endpoints";
import type { Health, UnifiedEndpoint } from "@/lib/endpoints";
import type { MetricBucket, MetricSeries, RangeKey } from "@/types";

const props = defineProps<{
  u: UnifiedEndpoint;
  series: MetricSeries | null;
  loading: boolean;
  health: Health;
  range: RangeKey;
  metric: "throughput" | "latency" | "spend" | "errors";
  window: { from: number; to: number } | null;
}>();
const emit = defineEmits<{
  "update:range": [RangeKey];
  "update:metric": ["throughput" | "latency" | "spend" | "errors"];
  pick: [MetricBucket | null];
}>();

const RANGE_OPTS = RANGES.map((r) => ({ value: r.value, label: r.label }));
const METRIC_OPTS = [
  { value: "throughput", label: "Throughput" },
  { value: "latency", label: "Latency" },
  { value: "spend", label: "Spend" },
  { value: "errors", label: "Errors" },
];

/** null while loading *and* when the range is empty: an empty range has no averages to show */
const t = computed(() => {
  const totals = props.series?.totals;
  return totals && totals.requests ? totals : null;
});
const pct = (n: number, of: number): string => (of ? Math.round((n / of) * 100) + "%" : "—");
const rangeLabel = computed(() => RANGES.find((r) => r.value === props.range)!.label);
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <span class="label">Last</span>
        <UiToggleGroup
          :model-value="range"
          :options="RANGE_OPTS"
          @update:model-value="(v) => emit('update:range', v as RangeKey)"
        />
      </div>
      <p class="text-[11px] text-zinc-500">Sample history · no provider was called</p>
    </div>

    <div class="card p-3">
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <UiToggleGroup
          :model-value="metric"
          :options="METRIC_OPTS"
          @update:model-value="(v) => emit('update:metric', v as typeof metric)"
        />
        <span class="text-[11px] text-zinc-500">{{
          metric === "throughput"
            ? throughputLabel(u.kind)
            : metric === "latency"
              ? "Average total latency · queue and provider details on hover"
              : metric === "spend"
                ? "Recorded cost per bucket"
                : "Failures, rate limits and retried requests"
        }}</span>
      </div>
      <div v-if="loading" class="grid h-28 place-items-center text-xs text-zinc-500">
        Loading {{ rangeLabel }} of history…
      </div>
      <MetricChart
        v-else-if="series"
        :series="series"
        :metric="metric"
        :selected="window"
        @pick="(b) => emit('pick', b)"
      />
    </div>

    <dl class="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <div class="card p-3">
        <dt class="label">{{ u.kind === "scripting" ? "Throughput" : "Audio produced" }}</dt>
        <dd class="mt-0.5 font-mono text-lg leading-tight">
          {{ t ? metricValue(t.throughput) : "—" }}
          <span class="text-[11px] text-zinc-500">{{ throughputUnit(u.kind) }}</span>
        </dd>
        <dd class="text-[11px] text-zinc-500">
          <template v-if="t && u.kind === 'scripting'"
            >{{ compact(t.inputTokens) }} in · {{ compact(t.outputTokens) }} out</template
          >
          <template v-else-if="t"
            >{{ (t.audioSeconds / 60).toFixed(1) }} min from {{ compact(t.chars) }} chars</template
          >
          <template v-else>no requests in this range</template>
        </dd>
      </div>

      <div class="card p-3">
        <dt class="label">Response time</dt>
        <dd class="mt-0.5 font-mono text-lg leading-tight">
          {{ t && t.responseMs ? duration(t.responseMs) : "—" }}
        </dd>
        <dd class="text-[11px] text-zinc-500">
          <template v-if="t">p95 {{ duration(t.p95Ms) }} · the provider’s half</template>
          <template v-else>no requests in this range</template>
        </dd>
      </div>

      <div class="card p-3">
        <dt class="label">Queue wait</dt>
        <dd
          class="mt-0.5 font-mono text-lg leading-tight"
          :class="t && t.queueMs > t.responseMs && 'text-amber-600 dark:text-amber-400'"
        >
          {{ t && t.queueMs ? duration(t.queueMs) : t ? "0ms" : "—" }}
        </dd>
        <dd class="text-[11px] text-zinc-500">
          <template v-if="t && t.queueMs > t.responseMs"
            >Longer than the provider takes — raise concurrency</template
          >
          <template v-else-if="t">Our side, waiting for a slot</template>
          <template v-else>no requests in this range</template>
        </dd>
      </div>

      <div class="card p-3">
        <dt class="label">Spend · {{ rangeLabel }}</dt>
        <dd class="mt-0.5 font-mono text-lg leading-tight">{{ t ? money(t.cost) : "—" }}</dd>
        <dd
          class="text-[11px]"
          :class="t && t.unknownCost ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500'"
        >
          <template v-if="t && t.unknownCost"
            >{{ t.unknownCost }} request{{ t.unknownCost === 1 ? "" : "s" }} not priced — the real
            total is higher</template
          >
          <template v-else-if="t">{{ t.requests }} requests, all priced</template>
          <template v-else>no requests in this range</template>
        </dd>
      </div>
    </dl>

    <div class="card p-3">
      <div class="mb-2 flex items-center gap-2">
        <span class="label">Outcomes · {{ rangeLabel }}</span>
        <span class="text-[11px] text-zinc-500">{{ t?.requests ?? 0 }} requests</span>
      </div>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-5">
        <div>
          <dt class="text-[11px] text-zinc-500">
            <UiTooltip text="Succeeded without needing a retry.">
              <span class="cursor-help underline decoration-dotted underline-offset-2"
                >First-attempt success</span
              >
            </UiTooltip>
          </dt>
          <dd class="mt-0.5 font-mono text-base">
            {{ t ? pct(t.firstAttemptOk, t.requests) : "—" }}
          </dd>
        </div>
        <div>
          <dt class="text-[11px] text-zinc-500">
            <UiTooltip text="Succeeded in the end, however many attempts that took.">
              <span class="cursor-help underline decoration-dotted underline-offset-2"
                >Eventual success</span
              >
            </UiTooltip>
          </dt>
          <dd class="mt-0.5 font-mono text-base">
            {{ t ? pct(t.eventualOk, t.requests) : "—" }}
          </dd>
        </div>
        <div>
          <dt class="text-[11px] text-zinc-500">Rate limits</dt>
          <dd
            class="mt-0.5 font-mono text-base"
            :class="t && t.rateLimits ? 'text-amber-600 dark:text-amber-400' : ''"
          >
            {{ t?.rateLimits ?? "—" }}
          </dd>
        </div>
        <div>
          <dt class="text-[11px] text-zinc-500">Retried</dt>
          <dd class="mt-0.5 font-mono text-base">{{ t?.retries ?? "—" }}</dd>
        </div>
        <div>
          <dt class="text-[11px] text-zinc-500">Failed</dt>
          <dd
            class="mt-0.5 font-mono text-base"
            :class="t && t.failures ? 'text-red-600 dark:text-red-400' : ''"
          >
            {{ t?.failures ?? "—" }}
          </dd>
        </div>
      </dl>
      <p
        class="mt-2 border-t border-zinc-100 pt-2 text-[11px] leading-relaxed text-zinc-500 dark:border-zinc-800"
      >
        <span :class="TEXT[health.tone]">{{ health.label }}.</span> {{ health.detail }}
      </p>
    </div>
  </div>
</template>
