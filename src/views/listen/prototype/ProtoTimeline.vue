<script setup lang="ts">
// PROTOTYPE — throwaway. The stitched chapter as a scrubber: one block per clip coloured by speaker,
// the silence between drawn grey, a tick where a line is flagged or was heard wrong, and the
// playhead. A click listens from there.
import { computed } from "vue";
import { protoFlags, type ListenCtx } from "@/views/listen/prototype/ctx";

const props = defineProps<{ ctx: ListenCtx; height?: string }>();
const pos = computed(() => (props.ctx.isThis ? props.ctx.p.pos : 0));
const pct = (t: number) => (props.ctx.total ? (t / props.ctx.total) * 100 : 0) + "%";
function scrub(e: MouseEvent) {
  const at = (e.offsetX / (e.currentTarget as HTMLElement).clientWidth) * props.ctx.total;
  if (props.ctx.isThis) props.ctx.seekTo(at);
  else props.ctx.playChapter(at);
}
</script>

<template>
  <div
    class="relative cursor-pointer overflow-hidden rounded"
    :class="height ?? 'h-5'"
    title="click to listen from here"
    @click="scrub"
  >
    <div class="absolute inset-0 flex gap-px">
      <template v-for="x in ctx.timeline" :key="x.s.id">
        <div
          class="relative h-full"
          :style="{
            width: ((x.end - x.start) / ctx.total) * 100 + '%',
            background: ctx.colorOf(x.s.speaker),
            opacity: ctx.current === x.s.id ? 1 : 0.6,
          }"
          :title="x.s.speaker"
        >
          <span
            v-if="protoFlags.has(x.s.id) || x.s.flag || ctx.heard[x.s.id]?.mismatch"
            class="absolute inset-x-0 top-0 h-1"
            :class="ctx.heard[x.s.id]?.mismatch ? 'bg-red-500' : 'bg-amber-400'"
          ></span>
        </div>
        <div
          v-if="x.gap"
          class="h-full bg-zinc-200 dark:bg-zinc-700"
          :style="{ width: (x.gap / ctx.total) * 100 + '%' }"
        ></div>
      </template>
    </div>
    <div
      v-if="ctx.isThis"
      class="pointer-events-none absolute inset-y-0 left-0 bg-black/20 dark:bg-white/20"
      :style="{ width: pct(pos) }"
    ></div>
    <div
      v-if="ctx.isThis"
      class="pointer-events-none absolute inset-y-0 w-0.5 bg-black dark:bg-white"
      :style="{ left: pct(pos) }"
    ></div>
  </div>
</template>
