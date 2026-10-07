<script setup lang="ts">
// PROTOTYPE — throwaway. Variant J, "Bar": G with nothing hidden and nothing written. One slim bar
// floating at the foot, always the same: the transport on the left, the stitched scrubber across
// the middle with the time and speaker under the pointer, the clock, and the tools on the right —
// repeat, flag, speed, follow, stop at end. No hover state, no words in the bar: the line being
// read is on the page, lit, and the bar only moves the sound. The scrubber is one plain line in
// one colour — the time under the pointer is all it says — and a dot before it is the speaker's
// colour, for the eye that wants it.
import { computed, ref } from "vue";
import {
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  FastForward as FwdIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Rewind as BackIcon,
} from "@lucide/vue";
import ProtoColumn from "@/views/listen/prototype/ProtoColumn.vue";
import ProtoHeader from "@/views/listen/prototype/ProtoHeader.vue";
import ProtoTools from "@/views/listen/prototype/ProtoTools.vue";
import {
  clock,
  fmt,
  focusRow,
  protoTimeMode,
  useProtoKeys,
  type ListenCtx,
} from "@/views/listen/prototype/ctx";

const props = defineProps<{ ctx: ListenCtx }>();
const c = computed(() => props.ctx);
const flagOpen = ref<number | null>(null);
useProtoKeys(
  () => c.value,
  () => {
    const s = focusRow(c.value);
    if (s) flagOpen.value = s.id;
  },
);
const now = computed(() => focusRow(c.value));
const pct = computed(() =>
  c.value.total && c.value.isThis ? (c.value.p.pos / c.value.total) * 100 : 0,
);
/** 0…1 along the line, from its own edge (`offsetX` would be the fill's) */
const frac = (e: MouseEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
};
const hover = ref<number | null>(null);
function scrub(e: MouseEvent) {
  const at = frac(e) * c.value.total;
  if (c.value.isThis) c.value.seekTo(at);
  else c.value.playChapter(at);
}
</script>

<template>
  <div class="p-4 pb-20">
    <div class="card mx-auto max-w-5xl">
      <ProtoHeader :ctx="ctx" />
      <ProtoColumn v-model:flag-open="flagOpen" :ctx="ctx" />
    </div>

    <div
      class="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4 lg:pl-14"
    >
      <div
        class="card pointer-events-auto flex w-full max-w-xl items-center gap-1.5 rounded-full py-1.5 pl-1.5 pr-3 shadow-xl"
      >
        <button
          class="icon-btn h-6 w-6 rounded-full"
          :disabled="!ctx.isThis"
          title="previous line (k)"
          @click="ctx.prev()"
        >
          <PrevIcon class="icon-sm" />
        </button>
        <button
          class="icon-btn h-6 w-6 rounded-full"
          :disabled="!ctx.isThis"
          title="back 10 s (,)"
          @click="ctx.skip(-10)"
        >
          <BackIcon class="icon-sm" />
        </button>
        <button
          class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40"
          :disabled="!ctx.total"
          title="play / pause (space)"
          @click="ctx.playChapter()"
        >
          <component
            :is="ctx.isThis && ctx.p.playing ? PauseIcon : PlayIcon"
            class="icon icon-fill"
          />
        </button>
        <button
          class="icon-btn h-6 w-6 rounded-full"
          :disabled="!ctx.isThis"
          title="forward 10 s (.)"
          @click="ctx.skip(10)"
        >
          <FwdIcon class="icon-sm" />
        </button>
        <button
          class="icon-btn h-6 w-6 rounded-full"
          :disabled="!ctx.isThis"
          title="next line (j)"
          @click="ctx.next()"
        >
          <NextIcon class="icon-sm" />
        </button>

        <span
          class="ml-1.5 inline-block h-2 w-2 shrink-0 rounded-full transition-colors"
          :style="{ background: now ? ctx.colorOf(now.speaker) : 'transparent' }"
          :title="now?.speaker"
        ></span>
        <div
          class="relative min-w-0 flex-1 cursor-pointer py-2"
          @click="scrub"
          @mousemove="hover = frac($event)"
          @mouseleave="hover = null"
        >
          <div class="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div class="h-full rounded-full bg-violet-500" :style="{ width: pct + '%' }"></div>
          </div>
          <div
            v-if="hover != null"
            class="pointer-events-none absolute bottom-full z-10 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-white dark:bg-zinc-100 dark:text-zinc-900"
            :style="{ left: hover * 100 + '%' }"
          >
            {{ fmt(hover * ctx.total) }}
          </div>
        </div>
        <button
          class="shrink-0 font-mono text-[11px] tabular-nums text-zinc-500 hover:text-violet-600"
          :title="
            protoTimeMode === 'elapsed'
              ? 'time gone — click for time left'
              : 'time left — click for time gone'
          "
          @click="protoTimeMode = protoTimeMode === 'elapsed' ? 'remaining' : 'elapsed'"
        >
          {{ clock(ctx) }}
        </button>
        <span class="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-800"></span>
        <ProtoTools v-model:flag-open="flagOpen" :ctx="ctx" rate="cycle" />
      </div>
    </div>
  </div>
</template>
