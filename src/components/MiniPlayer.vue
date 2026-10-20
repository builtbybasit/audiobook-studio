<script setup lang="ts">
// The player follows you off the page that started it, keeping the controls and the way back in
// reach; it hides on that page, which has a better player of its own.
import { computed } from "vue";
import { useRoute } from "vue-router";
import { usePlayer } from "@/composables/usePlayer";
import {
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  FastForward as FwdIcon,
  Rewind as BackIcon,
  X as CloseIcon,
} from "@lucide/vue";
const { p, toggle, stop, skip, next, prev, seek, cycleRate } = usePlayer();
const route = useRoute();
const home = computed(() => p.href?.split("?")[0] ?? null);
// Only long-form playback (a chapter or a finished file) follows you, not a line audition.
const show = computed(() => !!home.value && p.len > 0 && route.path !== home.value);
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function scrub(e: MouseEvent) {
  seek(e.offsetX / (e.currentTarget as HTMLElement).clientWidth);
}
</script>

<template>
  <div
    v-if="show"
    class="card fixed bottom-4 left-4 right-4 z-40 p-2 shadow-xl sm:right-auto sm:w-[400px] lg:left-60"
  >
    <div class="flex items-center gap-1.5">
      <button class="icon-btn" data-tip="previous line" aria-label="previous line" @click="prev()">
        <PrevIcon class="icon-sm" />
      </button>
      <button
        class="icon-btn"
        data-tip="back 10 seconds"
        aria-label="back 10 seconds"
        @click="skip(-10)"
      >
        <BackIcon class="icon-sm" />
      </button>
      <button
        class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white"
        :data-tip="p.playing ? 'pause (space)' : 'play (space)'"
        :aria-label="p.playing ? 'Pause' : 'Play'"
        @click="toggle()"
      >
        <component :is="p.playing ? PauseIcon : PlayIcon" class="icon icon-fill" />
      </button>
      <button
        class="icon-btn"
        data-tip="forward 10 seconds"
        aria-label="forward 10 seconds"
        @click="skip(10)"
      >
        <FwdIcon class="icon-sm" />
      </button>
      <button class="icon-btn" data-tip="next line" aria-label="next line" @click="next()">
        <NextIcon class="icon-sm" />
      </button>

      <div class="min-w-0 flex-1 px-1">
        <div class="flex items-baseline justify-between gap-2 text-xs">
          <RouterLink
            v-if="p.href"
            :to="p.href!"
            class="truncate font-medium hover:text-violet-500"
            :data-tip="`back to ${p.title}`"
            >{{ p.title || "Playing" }}</RouterLink
          >
          <span v-else class="truncate font-medium">{{ p.title || "Playing" }}</span>
          <span class="shrink-0 font-mono text-[10px] text-zinc-500"
            >{{ fmt(p.pos) }} / {{ fmt(p.len) }}</span
          >
        </div>
        <div class="truncate text-[11px] text-zinc-500">
          {{ p.loading ? "buffering…" : p.subtitle }}
        </div>
      </div>

      <button
        class="shrink-0 rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
        data-tip="playback speed"
        @click="cycleRate()"
      >
        {{ p.rate }}×
      </button>
      <button class="icon-btn" data-tip="stop" aria-label="stop" @click="stop()">
        <CloseIcon class="icon-sm" />
      </button>
    </div>
    <div
      class="mt-1.5 h-1 cursor-pointer overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800"
      @click="scrub"
    >
      <div
        class="h-full bg-violet-500"
        :style="{ width: (p.len ? (p.pos / p.len) * 100 : 0) + '%' }"
      ></div>
    </div>
  </div>
</template>
