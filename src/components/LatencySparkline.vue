<script setup lang="ts">
import { computed } from "vue";
import { CurveType } from "@unovis/ts";
import { VisLine, VisXYContainer } from "@unovis/vue";
import type { ChartConfig } from "@/components/ui/chart";
import { ChartContainer } from "@/components/ui/chart";

interface LatencyPoint {
  at: number;
  ms: number;
}

const props = defineProps<{
  points: LatencyPoint[];
}>();

const recent = computed(() => props.points.slice(-16));
const x = (point: LatencyPoint) => point.at;
const y = (point: LatencyPoint) => point.ms;
const chartConfig = {
  latency: { label: "latency", color: "var(--chart-1)" },
} satisfies ChartConfig;
const label = computed(() => {
  const values = recent.value.map((point) => point.ms);
  if (!values.length) return "No successful latency measurements";
  const latest = values.at(-1)!;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const time = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} seconds` : `${ms} ms`);
  return `Recent successful latency trend, ${values.length} requests. Latest ${time(latest)}, range ${time(low)} to ${time(high)}.`;
});
</script>

<template>
  <ChartContainer
    v-if="recent.length > 1"
    :config="chartConfig"
    class="h-5 w-12 shrink-0 overflow-hidden"
    role="img"
    :aria-label="label"
  >
    <VisXYContainer
      class="h-full w-full"
      :data="recent"
      :margin="{ top: 1, right: 1, bottom: 1, left: 1 }"
      :duration="0"
    >
      <VisLine
        :x="x"
        :y="y"
        :color="chartConfig.latency.color"
        :curve-type="CurveType.MonotoneX"
        :line-width="1.5"
      />
    </VisXYContainer>
  </ChartContainer>
</template>
