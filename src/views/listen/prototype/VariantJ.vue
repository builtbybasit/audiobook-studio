<script setup lang="ts">
// PROTOTYPE — throwaway. Variant J, "Bar": G with nothing hidden and nothing written. One slim bar
// floating at the foot, always the same: the transport on the left, the stitched scrubber across
// the middle with the time and speaker under the pointer, the clock, and the tools on the right —
// repeat, flag, speed, follow, stop at end. No hover state, no words in the bar: the line being
// read is on the page, lit, and the bar only moves the sound. A dot before the scrubber is the
// speaker's colour, for the eye that wants it.
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
import ProtoTimeline from "@/views/listen/prototype/ProtoTimeline.vue";
import ProtoTools from "@/views/listen/prototype/ProtoTools.vue";
import {
  clock,
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
        class="card pointer-events-auto flex w-full max-w-3xl items-center gap-1.5 rounded-full py-1.5 pl-1.5 pr-3 shadow-xl"
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
        <div class="min-w-0 flex-1 px-0.5"><ProtoTimeline :ctx="ctx" height="h-4" preview /></div>
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
