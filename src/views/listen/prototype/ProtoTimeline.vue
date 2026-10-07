<script setup lang="ts">
// PROTOTYPE — throwaway. The stitched chapter as a scrubber: one block per clip coloured by speaker,
// the silence between drawn grey, a tick where a line is flagged or was heard wrong, and the
// playhead. A click listens from there.
import { computed, ref } from "vue";
import { fmt, protoFlags, type ListenCtx } from "@/views/listen/prototype/ctx";

const props = defineProps<{ ctx: ListenCtx; height?: string; preview?: boolean }>();
/** under the pointer: where it would play from, and who is speaking there */
const hover = ref<{ x: number; at: number; speaker: string } | null>(null);
function move(e: MouseEvent) {
  if (!props.preview) return;
  const w = (e.currentTarget as HTMLElement).clientWidth;
  const at = (e.offsetX / w) * props.ctx.total;
  const clip = props.ctx.timeline.find((x) => at < x.end + x.gap);
  hover.value = { x: (e.offsetX / w) * 100, at, speaker: clip?.s.speaker ?? "" };
}
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
    class="relative cursor-pointer"
    :class="height ?? 'h-5'"
    :title="preview ? undefined : 'click to listen from here'"
    @click="scrub"
    @mousemove="move"
    @mouseleave="hover = null"
  >
    <div class="absolute inset-0 flex gap-px overflow-hidden rounded">
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
    <div
      v-if="hover"
      class="pointer-events-none absolute inset-y-0 w-px bg-violet-700 dark:bg-violet-300"
      :style="{ left: hover.x + '%' }"
    ></div>
    <div
      v-if="hover"
      class="pointer-events-none absolute -top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-white dark:bg-zinc-100 dark:text-zinc-900"
      :style="{ left: hover.x + '%', transform: 'translate(-50%, -110%)' }"
    >
      {{ fmt(hover.at) }}<span v-if="hover.speaker" class="font-sans"> · {{ hover.speaker }}</span>
    </div>
  </div>
</template>
