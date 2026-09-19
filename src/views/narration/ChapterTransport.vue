<script setup lang="ts">
import { useCastStore } from "@/stores/cast";

// The stitched chapter, played and scrubbed. A chapter is not a file: it is the clips *and* the
// silence stitched between them, so the bar shows both — one block per clip, coloured by speaker and
// dimmed when the script has moved past it, with the gaps drawn between. The queue itself comes from
// `useChapterQueue`, the same one the reader builds, so a line started on one page keeps playing on
// the other.
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useJob, fmt } from "@/views/narration/shared";
import { pauseAfter, secs } from "@/lib/speech";
import { usePlayer, type Queue } from "@/composables/usePlayer";
import { chapterQueue, chapterQueueId } from "@/composables/useChapterQueue";
import {
  Pause as PauseIcon,
  Play as PlayIcon,
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  Rewind as BackIcon,
  FastForward as FwdIcon,
} from "@lucide/vue";

const props = defineProps<{ bookId: string; chapterId: number }>();
const castStore = useCastStore();
const route = useRoute();
const router = useRouter();
const { chapter, segments, colorOf } = useJob(props);
const { p, playQueue, cue, seekTo, skip, next, prev, cycleRate } = usePlayer();
const pacing = computed(() => castStore.pacingOf(props.bookId));
// the stitched chapter is the clips *and* the silence between them, so the scrubber shows both
const timeline = computed(() => {
  const heard = segments.value.filter((s) => s.audio.duration > 0);
  let t = 0;
  return heard.map((s, i) => {
    const start = t;
    t += s.audio.duration;
    const end = t;
    const gap = pauseAfter(s, heard[i + 1], pacing.value);
    t += gap;
    return { s, start, end, gap };
  });
});
// The length of the bar below, summed from the very clips it draws rather than read off
// `chapter.duration`. The two are the same arithmetic (`cast._retime` is Σdurations + `silenceOf`)
// and agree whenever nothing is in flight — but a clip being rendered again drops out of `timeline`
// at once, while `_retime` does not run until the job settles. Driving the block widths, the
// playhead and the scrub mapping off a total the blocks no longer add up to is how the bar stops
// reaching its own end and a click lands past the last clip.
const total = computed(() => {
  const last = timeline.value.at(-1);
  return last ? last.end + last.gap : 0;
});
const isChapter = computed(() => p.id === chapterQueueId(props.bookId, props.chapterId));
const currentId = computed(() => (p.clipId?.startsWith("seg") ? Number(p.clipId.slice(3)) : null));

/** This chapter's timeline, built the same way the reader builds it. */
const buildQueue = (chId: number): Queue | null =>
  chapterQueue(props.bookId, chId, {
    href: (id) => `/book/${props.bookId}/narration?ch=${id}`,
    // the ledger follows the player: ?ch= is what NarrationView already watches, and going through
    // the router means this survives the remount that switching chapters causes
    onChapter: (id) => void router.replace({ query: { ...route.query, ch: String(id) } }),
  });
function playChapter(at?: number) {
  const q = buildQueue(props.chapterId);
  if (q) playQueue(q, at);
}
function scrub(e: MouseEvent) {
  const at = (e.offsetX / (e.currentTarget as HTMLElement).clientWidth) * total.value;
  if (isChapter.value) return seekTo(at);
  const q = buildQueue(props.chapterId);
  if (q) cue(q, at); // park the playhead without starting — scrubbing is not pressing play
}
// the row's "play the chapter from here" presses this rather than building a second queue
defineExpose({ playChapter });
</script>

<template>
  <div
    class="border-t border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60"
  >
    <div class="flex items-center gap-3">
      <div class="flex shrink-0 items-center gap-0.5">
        <button class="icon-btn" :disabled="!isChapter" title="previous line" @click="prev()">
          <PrevIcon class="icon-sm" />
        </button>
        <button class="icon-btn" :disabled="!isChapter" title="back 10 seconds" @click="skip(-10)">
          <BackIcon class="icon-sm" />
        </button>
        <button
          class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40"
          :disabled="!total"
          title="play the stitched chapter (space)"
          @click="playChapter()"
        >
          <component
            :is="isChapter && p.playing ? PauseIcon : PlayIcon"
            class="icon-lg icon-fill"
          />
        </button>
        <button
          class="icon-btn"
          :disabled="!isChapter"
          title="forward 10 seconds"
          @click="skip(10)"
        >
          <FwdIcon class="icon-sm" />
        </button>
        <button class="icon-btn" :disabled="!isChapter" title="next line" @click="next()">
          <NextIcon class="icon-sm" />
        </button>
      </div>
      <div class="min-w-0 flex-1">
        <div class="mb-1 flex items-center justify-between text-xs">
          <span class="truncate"
            ><b v-if="currentId"
              >#{{ currentId }} {{ segments.find((s) => s.id === currentId)?.speaker }}</b
            ><span v-else-if="isChapter && p.playing" class="text-zinc-500">silence</span
            ><span v-else class="text-zinc-500">{{
              total ? "Stitched chapter · click the bar to scrub" : "No audio yet"
            }}</span>
            <span v-if="total && !p.live" class="ml-1 text-[10px] text-amber-600"
              >timed, not heard — no rendered files in the prototype</span
            ></span
          >
          <span class="flex items-center gap-2">
            <button
              class="rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
              title="playback speed"
              @click="cycleRate()"
            >
              {{ p.rate }}×
            </button>
            <span class="font-mono text-zinc-500"
              >{{ fmt(isChapter ? p.pos : 0) }} / {{ fmt(total) }}</span
            >
          </span>
        </div>
        <div class="relative h-5 cursor-pointer overflow-hidden rounded" @click="scrub">
          <div class="absolute inset-0 flex gap-px">
            <template v-for="x in timeline" :key="x.s.id">
              <div
                class="h-full"
                :style="{
                  width: ((x.end - x.start) / total) * 100 + '%',
                  background: colorOf(x.s.speaker),
                  opacity: x.s.audio.status === 'stale' ? 0.35 : 0.75,
                }"
                :title="`#${x.s.id} ${x.s.speaker}`"
              ></div>
              <div
                v-if="x.gap"
                class="h-full bg-zinc-200 dark:bg-zinc-700"
                :style="{ width: (x.gap / total) * 100 + '%' }"
                :title="`${secs(x.gap)} of silence${x.s.pause != null ? ' — set on this line' : ''}`"
              ></div>
            </template>
            <div v-if="!timeline.length" class="h-full w-full bg-zinc-200 dark:bg-zinc-800"></div>
          </div>
          <div
            v-if="isChapter"
            class="absolute inset-y-0 left-0 bg-black/25 dark:bg-white/25"
            :style="{ width: (total ? (p.pos / total) * 100 : 0) + '%' }"
          ></div>
          <div
            v-if="isChapter"
            class="absolute inset-y-0 w-0.5 bg-black dark:bg-white"
            :style="{ left: (total ? (p.pos / total) * 100 : 0) + '%' }"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>
