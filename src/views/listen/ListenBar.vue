<script setup lang="ts">
// The Listen page's player: one slim bar floating at the foot, always the same. The transport on
// the left, one plain progress line across the middle with the time under the pointer, the clock,
// and the tools on the right — repeat this line, flag it, speed, follow the reading, stop at the
// chapter's end. Nothing in it is written in words: the line being read is on the page, lit, with
// its speaker named there, and the bar only moves the sound. The dot before the line is the
// speaker's colour, for the eye that wants it.
//
// The player is the app's one player; this bar reads and drives it directly. What it cannot know
// is the chapter — which queue to start, and where a click on the line lands in it — so starting
// and seeking are the page's, asked for by event.
import { computed, ref } from "vue";
import {
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  Crosshair as FollowIcon,
  FastForward as FwdIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Repeat1 as RepeatIcon,
  Rewind as BackIcon,
  Square as StopIcon,
} from "@lucide/vue";
import FlagPopover from "@/views/narration/FlagPopover.vue";
import { usePlayer } from "@/composables/usePlayer";
import { fmt } from "@/views/narration/shared";
import type { Segment } from "@/types";

const props = defineProps<{
  bookId: string;
  chapterId: number;
  /** the line the bar acts on: the one playing, else the first that can be */
  segment: Segment | undefined;
  color: string;
  /** the chapter's length, silence included */
  total: number;
  /** the player holds this chapter */
  isThis: boolean;
  /** the page keeps the line being read in view */
  follow: boolean;
}>();
const emit = defineEmits<{
  /** play or pause this chapter */
  play: [];
  /** listen from `at` seconds into the chapter */
  seek: [at: number];
  follow: [on: boolean];
  pronounce: [word: string];
}>();
const flagOpen = defineModel<boolean>("flagOpen", { default: false });
const { p, skip, next, prev, cycleRate, repeatClip, setStopAtEnd } = usePlayer();

const pos = computed(() => (props.isThis ? p.pos : 0));
const pct = computed(() => (props.total ? (pos.value / props.total) * 100 : 0));
/** time gone, or — tapped — time left */
const remaining = ref(false);
const clock = computed(() =>
  remaining.value ? `−${fmt(Math.max(0, props.total - pos.value))}` : fmt(pos.value),
);

// Where along the line the pointer is, 0…1, from the line's own edge: `offsetX` is relative to the
// element under the pointer, which may be the fill.
const frac = (e: MouseEvent): number => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
};
const hover = ref<number | null>(null);

const repeating = computed(() => props.isThis && p.repeat != null);
function toggleRepeat() {
  if (!props.isThis || !p.clipId) return;
  repeatClip(p.repeat ? null : p.clipId);
}
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4 lg:pl-14">
    <div
      class="card pointer-events-auto flex w-full max-w-xl items-center gap-1.5 rounded-full py-1.5 pl-1.5 pr-3 shadow-xl"
    >
      <button
        class="icon-btn h-6 w-6 rounded-full"
        :disabled="!isThis"
        title="previous line (k)"
        @click="prev()"
      >
        <PrevIcon class="icon-sm" />
      </button>
      <button
        class="icon-btn h-6 w-6 rounded-full"
        :disabled="!isThis"
        title="back 10 seconds (,)"
        @click="skip(-10)"
      >
        <BackIcon class="icon-sm" />
      </button>
      <button
        class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40"
        :disabled="!total"
        :aria-label="isThis && p.playing ? 'Pause' : 'Play this chapter'"
        :title="isThis && p.playing ? 'pause (space)' : 'play this chapter (space)'"
        @click="emit('play')"
      >
        <component :is="isThis && p.playing ? PauseIcon : PlayIcon" class="icon icon-fill" />
      </button>
      <button
        class="icon-btn h-6 w-6 rounded-full"
        :disabled="!isThis"
        title="forward 10 seconds (.)"
        @click="skip(10)"
      >
        <FwdIcon class="icon-sm" />
      </button>
      <button
        class="icon-btn h-6 w-6 rounded-full"
        :disabled="!isThis"
        title="next line (j)"
        @click="next()"
      >
        <NextIcon class="icon-sm" />
      </button>

      <span
        class="ml-1.5 inline-block h-2 w-2 shrink-0 rounded-full transition-colors"
        :style="{ background: segment ? color : 'transparent' }"
        :title="segment?.speaker"
      ></span>
      <div
        class="relative min-w-0 flex-1 cursor-pointer py-2"
        role="slider"
        aria-label="Position in the chapter"
        :aria-valuemin="0"
        :aria-valuemax="Math.round(total)"
        :aria-valuenow="Math.round(pos)"
        @click="emit('seek', frac($event) * total)"
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
          {{ fmt(hover * total) }}
        </div>
      </div>
      <button
        class="shrink-0 font-mono text-[11px] tabular-nums text-zinc-500 hover:text-violet-600"
        :title="remaining ? 'time left — click for time gone' : 'time gone — click for time left'"
        @click="remaining = !remaining"
      >
        {{ p.loading && isThis ? "…" : clock }}
      </button>
      <span class="mx-1 h-4 w-px bg-zinc-200 dark:bg-zinc-800"></span>

      <button
        class="icon-btn"
        :class="repeating && 'icon-btn-on'"
        :disabled="!isThis || !p.clipId"
        :title="repeating ? 'repeating this line — click to stop (r)' : 'repeat this line (r)'"
        @click="toggleRepeat()"
      >
        <RepeatIcon class="icon-sm" />
      </button>
      <FlagPopover
        v-if="segment"
        v-model:open="flagOpen"
        :book-id="bookId"
        :chapter-id="chapterId"
        :segment="segment"
        @pronounce="(w) => emit('pronounce', w)"
      />
      <button
        class="rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
        title="playback speed"
        @click="cycleRate()"
      >
        {{ p.rate }}×
      </button>
      <button
        class="icon-btn"
        :class="follow && 'icon-btn-on'"
        :title="follow ? 'the page follows the reading — click to stop' : 'follow the reading'"
        @click="emit('follow', !follow)"
      >
        <FollowIcon class="icon-sm" />
      </button>
      <button
        class="icon-btn"
        :class="p.stopAtEnd && 'icon-btn-on'"
        :title="
          p.stopAtEnd
            ? 'stops at the end of this chapter — click to run on'
            : 'runs on into the next chapter — click to stop at the end'
        "
        @click="setStopAtEnd(!p.stopAtEnd)"
      >
        <StopIcon class="icon-sm" />
      </button>
    </div>
  </div>
</template>
