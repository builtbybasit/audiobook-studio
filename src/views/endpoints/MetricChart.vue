<script setup lang="ts">
// One chart, four readings of the same buckets, drawn with Unovis in shadcn-vue's chart shell; a
// metric's label and colour live once, in PARTS. Clicking a bar filters Activity to its requests.
// SVG bars can't hold focus, so the plot is a keyboard control (←/→, Enter, Esc) with the readout
// below as its live region.
import { computed, ref } from "vue";
import { plural } from "@/lib/contents";
import { CurveType } from "@unovis/ts";
import {
  VisAxis,
  VisLine,
  VisScatter,
  VisScatterSelectors,
  VisStackedBar,
  VisStackedBarSelectors,
  VisXYContainer,
} from "@unovis/vue";
import type { MetricBucket, MetricSeries } from "@/types";
import type { ChartConfig } from "@/components/ui/chart";
import {
  ChartContainer,
  ChartCrosshair,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  componentToString,
} from "@/components/ui/chart";
import { metricValue, throughputUnit } from "@/lib/endpoints";
import { money } from "@/lib/pricing";
import { UiHint, UiToggleGroup } from "@/ui";

const props = defineProps<{
  series: MetricSeries;
  metric: "throughput" | "latency" | "spend" | "errors";
  selected: { from: number; to: number } | null;
}>();
const emit = defineEmits<{ pick: [MetricBucket | null] }>();

/** Non-latency series are drawn as stacked bars. */
interface ChartBucket extends MetricBucket {
  latencyMs: number;
  /** requests a minute: plotted when no request reported usage (throughput unknown, not zero) */
  requestRate: number;
}
interface Part {
  key: keyof ChartBucket;
  label: string;
  color: string;
}
const PARTS: Record<string, Part[]> = {
  throughput: [{ key: "throughput", label: "throughput", color: "var(--chart-1)" }],
  latency: [{ key: "latencyMs", label: "average total latency", color: "var(--chart-1)" }],
  spend: [{ key: "cost", label: "spend", color: "var(--chart-3)" }],
  errors: [
    { key: "failures", label: "failed", color: "var(--chart-4)" },
    { key: "rateLimits", label: "rate limited", color: "var(--chart-5)" },
    { key: "retries", label: "retried", color: "var(--chart-6)" },
  ],
};
const LATENCY_BREAKDOWN: Part[] = [
  { key: "responseMs", label: "provider response", color: "var(--chart-2)" },
  { key: "queueMs", label: "queue wait", color: "var(--chart-3)" },
];
const LATENCY_VIEW_OPTIONS = [
  { value: "total", label: "Total" },
  { value: "breakdown", label: "Breakdown" },
];
const latencyView = ref<"total" | "breakdown">("total");
const setLatencyView = (value: string | number | null) => {
  if (value === "total" || value === "breakdown") latencyView.value = value;
};
const REQUEST_RATE: Part[] = [
  { key: "requestRate", label: "requests/min", color: "var(--chart-1)" },
];
const byRequests = computed(
  () => props.metric === "throughput" && props.series.totals.throughput == null,
);
const parts = computed(() =>
  props.metric === "latency" && latencyView.value === "breakdown"
    ? LATENCY_BREAKDOWN
    : byRequests.value
      ? REQUEST_RATE
      : PARTS[props.metric],
);
/** Latency plots one total line; its tooltip also names the queue/provider split. */
const chartConfig = computed<ChartConfig>(() => {
  if (props.metric === "latency")
    return {
      latencyMs: { label: "total latency", color: "var(--chart-1)" },
      responseMs: { label: "provider response", color: "var(--chart-2)" },
      queueMs: { label: "queue wait", color: "var(--chart-3)" },
    };
  return Object.fromEntries(parts.value.map((p) => [p.key, { label: p.label, color: p.color }]));
});
const empty = computed(() => props.series.totals.requests === 0);
const buckets = computed<ChartBucket[]>(() =>
  props.series.buckets.map((bucket) => ({
    ...bucket,
    latencyMs: bucket.queueMs + bucket.responseMs,
    requestRate: bucket.requests / ((bucket.to - bucket.from) / 60_000),
  })),
);
/** Unovis needs the bucket spacing to size bars on a time axis. */
const step = computed(() => {
  const [a, b] = buckets.value;
  return b ? b.from - a.from : 60_000;
});
/** `undefined` where unknown, so no bar is drawn. */
const valueOf = (b: ChartBucket, key: keyof ChartBucket): number | undefined =>
  (b[key] as number | null) ?? undefined;
const totalOf = (b: ChartBucket): number =>
  parts.value.reduce((n, p) => n + (valueOf(b, p.key) ?? 0), 0);

const x = (b: ChartBucket) => b.from;
const hasLatency = (b: ChartBucket): boolean => b.responseMs > 0 || b.queueMs > 0;
const chartData = computed(() =>
  props.metric === "latency" ? buckets.value.filter(hasLatency) : buckets.value,
);
const y = computed(() =>
  parts.value.map(
    (p) => (b: ChartBucket) =>
      props.metric === "latency" && !hasLatency(b) ? undefined : valueOf(b, p.key),
  ),
);
const color = (_b: ChartBucket, i: number): string => parts.value[i]?.color ?? "var(--chart-1)";
const colors = computed(() => parts.value.map((p) => p.color));

const isSelected = (b: ChartBucket): boolean =>
  !!props.selected && props.selected.from === b.from && props.selected.to === b.to;
/** Dim all but the highlighted bucket. A new function identity is what tells Unovis to redraw. */
const barStyle = computed(() => {
  const focus = highlighted.value && totalOf(highlighted.value) > 0 ? highlighted.value : null;
  return (b: ChartBucket) => (focus && focus.from !== b.from ? { opacity: 0.25 } : {});
});

function format(n: number): string {
  if (props.metric === "spend") return money(n);
  if (props.metric === "latency")
    return n >= 1000 ? (n / 1000).toFixed(1) + "s" : Math.round(n) + "ms";
  if (props.metric === "throughput") return metricValue(n);
  return String(Math.round(n));
}
const stamp = (from: number): string =>
  new Date(from).toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(props.series.range === "7d" ? { weekday: "short" } : {}),
  });

// ---------- pointer and keyboard ----------
const hovered = ref<number | null>(null);
const cursor = ref<number | null>(null);
const indexOf = (b: ChartBucket) => buckets.value.findIndex((x) => x.from === b.from);
const events = {
  [VisStackedBarSelectors.bar]: {
    mouseover: (b: ChartBucket) => (hovered.value = indexOf(b)),
    mouseout: () => (hovered.value = null),
    click: (b: ChartBucket) => pick(b),
  },
};
const pointEvents = {
  [VisScatterSelectors.point]: {
    mouseover: (b: ChartBucket) => (hovered.value = indexOf(b)),
    mouseout: () => (hovered.value = null),
    click: (b: ChartBucket) => pick(b),
  },
};
function pick(b: ChartBucket) {
  emit("pick", isSelected(b) ? null : b);
}
function onKey(e: KeyboardEvent) {
  const last = buckets.value.length - 1;
  const move = (i: number) => {
    e.preventDefault();
    cursor.value = Math.max(0, Math.min(last, i));
  };
  if (e.key === "ArrowRight") move((cursor.value ?? -1) + 1);
  else if (e.key === "ArrowLeft") move((cursor.value ?? buckets.value.length) - 1);
  else if (e.key === "Home") move(0);
  else if (e.key === "End") move(last);
  else if (e.key === "Enter" || e.key === " ") {
    if (cursor.value == null) return;
    e.preventDefault();
    pick(buckets.value[cursor.value]);
  } else if (e.key === "Escape" && props.selected) {
    e.preventDefault();
    emit("pick", null);
  }
}

/** By pointer, keyboard or an active filter. */
const highlighted = computed(() => {
  if (cursor.value != null) return buckets.value[cursor.value] ?? null;
  return props.selected ? (buckets.value.find(isSelected) ?? null) : null;
});

const shown = computed(() => {
  const i = hovered.value ?? cursor.value;
  if (i != null) return buckets.value[i] ?? null;
  return buckets.value.find(isSelected) ?? null;
});
const unit = computed(() =>
  props.metric === "throughput" && !byRequests.value ? " " + throughputUnit(props.series.kind) : "",
);

/** Unovis wants tooltip content as an HTML string, so the shadcn card is rendered to one. */
const tooltip = computed(() =>
  componentToString(chartConfig.value, ChartTooltipContent, {
    labelFormatter: (t: number | Date) => stamp(Number(t)),
    valueFormatter: (n: number) => format(n) + unit.value,
  }),
);
</script>

<template>
  <ChartContainer
    :config="chartConfig"
    :cursor="metric === 'latency'"
    class="aspect-auto h-auto w-full justify-start"
  >
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px]">
      <span v-if="metric === 'latency'" class="flex flex-wrap items-center gap-3 text-zinc-500">
        <span v-for="part in parts" :key="String(part.key)" class="flex items-center gap-1.5">
          <span
            class="size-2 rounded-[2px]"
            :style="{ backgroundColor: part.color }"
            aria-hidden="true"
          />
          {{ part.label }}
        </span>
      </span>
      <ChartLegendContent
        v-else
        vertical-align="top"
        class="flex-wrap justify-start gap-x-3 gap-y-1 pb-0 text-zinc-500"
      />
      <span class="flex flex-wrap items-center justify-end gap-3">
        <span v-if="metric === 'latency'" aria-label="Latency chart view">
          <UiToggleGroup
            :model-value="latencyView"
            :options="LATENCY_VIEW_OPTIONS"
            @update:model-value="setLatencyView"
          />
        </span>
        <UiHint
          label="the chart’s keys"
          text="Focus the chart: ← → walk the buckets, Enter filters the Activity list to one, Esc clears."
        />
      </span>
    </div>

    <div
      v-if="empty"
      class="mt-2 grid h-28 place-items-center rounded-lg border border-dashed border-zinc-300 text-xs text-zinc-500 dark:border-zinc-700"
    >
      No requests in this range.
    </div>

    <div
      v-else
      class="mt-1 h-[120px] rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      tabindex="0"
      role="group"
      :aria-label="`${metric} per bucket, ${buckets.length} buckets. Arrow keys read each one, Enter filters the activity list to it.`"
      @keydown="onKey"
      @blur="cursor = null"
      @mouseleave="hovered = null"
    >
      <VisXYContainer
        :data="chartData"
        :margin="{ top: 6, right: 4, bottom: 2, left: 2 }"
        :x-domain="[series.from, series.to]"
        :y-domain="[0, undefined]"
        :duration="200"
      >
        <VisLine
          v-if="metric === 'latency'"
          :x="x"
          :y="y"
          :color="colors"
          :curve-type="CurveType.MonotoneX"
          :line-width="2.5"
        />
        <VisScatter
          v-if="metric === 'latency'"
          :x="x"
          :y="y"
          color="transparent"
          :size="14"
          stroke-color="transparent"
          :stroke-width="0"
          :events="pointEvents"
          cursor="pointer"
        />
        <VisStackedBar
          v-else
          :x="x"
          :y="y"
          :color="color"
          :bar-style="barStyle"
          :data-step="step"
          :bar-padding="0.25"
          :rounded-corners="2"
          :bar-min-height1-px="true"
          :bar-min-height-zero-value="0"
          :events="events"
          cursor="pointer"
        />
        <VisAxis
          type="y"
          :num-ticks="3"
          :tick-format="format"
          :grid-line="true"
          :tick-line="false"
          :domain-line="false"
        />
        <VisAxis
          type="x"
          :num-ticks="4"
          :tick-format="(t: number) => stamp(t)"
          :grid-line="false"
          :tick-line="false"
          :domain-line="false"
        />
        <ChartTooltip />
        <ChartCrosshair
          :x="x"
          :y="y"
          :template="tooltip"
          :color="metric === 'latency' ? colors : 'transparent'"
          :circle-radius="4"
        />
      </VisXYContainer>
    </div>

    <p
      v-if="!empty"
      class="mt-1 min-h-[2.25rem] text-[11px] leading-snug text-zinc-500"
      aria-live="polite"
    >
      <template v-if="shown">
        <b class="text-zinc-700 dark:text-zinc-200">{{ stamp(shown.from) }}</b> ·
        {{ plural(shown.requests, "request") }}
        <template v-if="metric === 'latency'">
          · total {{ format(shown.latencyMs) }} · provider {{ format(shown.responseMs) }} · queue
          {{ format(shown.queueMs) }}
        </template>
        <template v-for="p in metric === 'latency' || byRequests ? [] : parts" :key="String(p.key)">
          · {{ p.label }}
          {{ valueOf(shown, p.key) == null ? "—" : format(valueOf(shown, p.key)!) + unit }}
        </template>
        <template v-if="metric === 'throughput' && shown.unreported">
          · {{ shown.unreported }} without usage
        </template>
        <template v-if="shown.unknownCost"> · {{ shown.unknownCost }} not priced </template>
        <span v-if="isSelected(shown)" class="text-violet-600 dark:text-violet-400">
          · filtering Activity — pick it again to clear</span
        >
        <span v-else-if="totalOf(shown)" class="text-zinc-400">
          · pick it to see these requests</span
        >
      </template>
      <template v-else>
        Hover or arrow through a {{ metric === "latency" ? "point" : "bar" }} for its numbers; pick
        one to filter Activity.
      </template>
    </p>
  </ChartContainer>
</template>
