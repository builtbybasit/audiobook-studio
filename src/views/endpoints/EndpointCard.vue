<script setup lang="ts">
// One row of the endpoint list. Four short lines: what it is, what it runs, how it is behaving,
// what it costs. The switch is a sibling of the select button, not inside it, so the card stays
// one tab stop for "select" and one for "pause".
import { UiSwitch } from "@/ui";
import { DOT, KIND_LABEL, TEXT, pricingLabel } from "@/lib/endpoints";
import type { Health, UnifiedEndpoint } from "@/lib/endpoints";
import type { LiveActivity } from "@/views/endpoints/live";

const props = defineProps<{
  u: UnifiedEndpoint;
  health: Health;
  live: LiveActivity;
  selected: boolean;
}>();
const emit = defineEmits<{ select: []; toggle: [boolean] }>();
const pricing = () => pricingLabel(props.u);
</script>

<template>
  <div
    class="relative rounded-lg border transition-colors"
    :class="
      selected
        ? 'border-violet-400 bg-violet-50 dark:border-violet-500 dark:bg-violet-500/10'
        : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/60'
    "
  >
    <button
      type="button"
      class="block w-full rounded-lg px-2.5 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      :aria-pressed="selected"
      @click="emit('select')"
    >
      <span class="flex items-center gap-1.5 pr-10">
        <span class="h-2 w-2 shrink-0 rounded-full" :class="DOT[health.tone]"></span>
        <span class="truncate text-sm font-medium" :class="!u.enabled && 'text-zinc-400'">{{
          u.name || "Untitled endpoint"
        }}</span>
        <span
          class="ml-auto shrink-0 rounded border border-zinc-200 px-1 text-[9px] uppercase tracking-wide text-zinc-500 dark:border-zinc-700"
          >{{ u.kind === "scripting" ? "script" : "TTS" }}</span
        >
      </span>
      <span class="mt-0.5 block truncate font-mono text-[11px] text-zinc-500">{{
        u.model || "model required"
      }}</span>
      <span class="mt-1 flex items-baseline justify-between gap-2 text-[11px]">
        <span class="truncate" :class="TEXT[health.tone]">{{ health.label }}</span>
        <span class="shrink-0 font-mono text-zinc-500"
          >{{ live.active }}/{{ u.concurrency }} <span class="text-zinc-400">busy</span></span
        >
      </span>
      <span class="mt-1 flex gap-px" aria-hidden="true">
        <span
          v-for="i in Math.min(u.concurrency, 16)"
          :key="i"
          class="h-1 flex-1 rounded-sm"
          :class="
            i <= live.active
              ? 'bg-violet-500'
              : live.effectiveLimit === 0
                ? 'bg-zinc-200 dark:bg-zinc-800'
                : 'bg-zinc-200 dark:bg-zinc-700'
          "
        ></span>
      </span>
      <span class="mt-1 block truncate text-[11px] text-zinc-500">
        {{ pricing() }}<span v-if="live.queued"> · {{ live.queued }} waiting</span>
      </span>
      <span class="sr-only">{{ KIND_LABEL[u.kind] }} endpoint. {{ health.detail }}</span>
    </button>
    <div class="absolute right-2 top-2">
      <UiSwitch :model-value="u.enabled" @update:model-value="(v) => emit('toggle', v)" @click.stop
        ><span class="sr-only">{{ u.enabled ? "Pause" : "Resume" }} {{ u.name }}</span></UiSwitch
      >
    </div>
  </div>
</template>
