<script setup lang="ts">
// PROTOTYPE — throwaway. Variant E, "Capsule": A's column with nothing at its foot. The player is
// a capsule floating over the page — at rest, a play button with the chapter's progress as a ring
// around it, the speaker and the clock. Hover it (or pin it open) and it grows into the full
// transport with the scrubber. The reading stays uncluttered; the player is there when wanted.
import { computed, ref } from "vue";
import {
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair as FollowIcon,
  FastForward as FwdIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Repeat1 as LoopIcon,
  Rewind as BackIcon,
  Square as StopIcon,
} from "@lucide/vue";
import ReaderSettings from "@/components/ReaderSettings.vue";
import ProtoColumn from "@/views/listen/prototype/ProtoColumn.vue";
import ProtoFlag from "@/views/listen/prototype/ProtoFlag.vue";
import ProtoTimeline from "@/views/listen/prototype/ProtoTimeline.vue";
import { UiCombobox, UiToggleGroup } from "@/ui";
import { RATES } from "@/composables/usePlayer";
import {
  clock,
  fmt,
  focusRow,
  isNarratedChapter,
  neighbour,
  placeOf,
  protoLoop,
  protoStopAtEnd,
  protoTimeMode,
  useProtoKeys,
  type ListenCtx,
} from "@/views/listen/prototype/ctx";

const props = defineProps<{ ctx: ListenCtx }>();
const c = computed(() => props.ctx);
const options = computed(() =>
  c.value.chapters.map((ch, i) => ({
    value: ch.id,
    label: `${i + 1} · ${ch.title}`,
    hint: isNarratedChapter(ch) ? fmt(ch.duration) : "no audio",
  })),
);
const before = computed(() => neighbour(c.value, -1));
const after = computed(() => neighbour(c.value, 1));
const flagOpen = ref<number | null>(null);
useProtoKeys(
  () => c.value,
  () => {
    const s = focusRow(c.value);
    if (s) flagOpen.value = s.id;
  },
);
const now = computed(() => focusRow(c.value));
/** the capsule stays open */
const pinned = ref(false);
const rateOptions = RATES.map((r) => ({ value: r, label: `${r}×` }));
// the ring: a circle of radius 22 in a 48px box, its dash offset the share left to play
const R = 22;
const C = 2 * Math.PI * R;
const dash = computed(() => {
  const pos = c.value.isThis ? c.value.p.pos : 0;
  const share = c.value.total ? pos / c.value.total : 0;
  return C * (1 - share);
});
function backToLine() {
  c.value.setFollow(true);
  if (c.value.current != null)
    document
      .getElementById(`seg-${c.value.current}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
}
</script>

<template>
  <div class="p-4 pb-28">
    <div class="card mx-auto max-w-5xl">
      <header
        class="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-xl border-b border-zinc-200 bg-white/95 px-4 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
      >
        <button
          class="icon-btn"
          :disabled="!before"
          title="previous narrated chapter"
          @click="before && ctx.open(before.id)"
        >
          <ChevronLeft class="icon-sm" />
        </button>
        <UiCombobox
          :model-value="ctx.opened"
          :options="options"
          placeholder="Chapter…"
          @update:model-value="(id) => id != null && ctx.open(Number(id))"
        />
        <button
          class="icon-btn"
          :disabled="!after"
          title="next narrated chapter"
          @click="after && ctx.open(after.id)"
        >
          <ChevronRight class="icon-sm" />
        </button>
        <span class="text-xs text-zinc-500">{{ placeOf(ctx) }} of {{ ctx.chapters.length }}</span>
        <span class="ml-auto flex items-center gap-2"><ReaderSettings /></span>
      </header>
      <ProtoColumn v-model:flag-open="flagOpen" :ctx="ctx" />
    </div>

    <!-- the capsule -->
    <div
      class="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4 lg:pl-60"
    >
      <div
        class="group pointer-events-auto card w-full max-w-xl overflow-hidden shadow-2xl transition-all"
        :class="pinned && 'is-pinned'"
      >
        <!-- at rest -->
        <div class="flex items-center gap-3 px-3 py-2">
          <button
            class="relative grid h-12 w-12 shrink-0 place-items-center rounded-full text-violet-600 disabled:opacity-40"
            :disabled="!ctx.total"
            title="play / pause (space)"
            @click="ctx.playChapter()"
          >
            <svg class="absolute inset-0 -rotate-90" viewBox="0 0 48 48" aria-hidden="true">
              <circle
                cx="24"
                cy="24"
                :r="R"
                class="fill-none stroke-zinc-200 dark:stroke-zinc-700"
                stroke-width="3"
              />
              <circle
                cx="24"
                cy="24"
                :r="R"
                class="fill-none stroke-violet-600 transition-[stroke-dashoffset]"
                stroke-width="3"
                stroke-linecap="round"
                :stroke-dasharray="C"
                :stroke-dashoffset="dash"
              />
            </svg>
            <component
              :is="ctx.isThis && ctx.p.playing ? PauseIcon : PlayIcon"
              class="icon-lg icon-fill"
            />
          </button>
          <div class="min-w-0 flex-1 text-xs">
            <div class="flex items-center gap-2">
              <template v-if="now">
                <span
                  class="inline-block h-2 w-2 shrink-0 rounded-full"
                  :style="{ background: ctx.colorOf(now.speaker) }"
                ></span>
                <b class="truncate">{{ now.speaker }}</b>
                <span class="text-zinc-400"
                  >· line {{ ctx.rows.indexOf(now) + 1 }} of {{ ctx.rows.length }}</span
                >
              </template>
              <span v-else class="truncate text-zinc-500">{{ ctx.chapter?.title }}</span>
              <button
                class="ml-auto shrink-0 font-mono text-zinc-500 hover:text-violet-600"
                :title="
                  protoTimeMode === 'elapsed'
                    ? 'time gone — click for time left'
                    : 'time left — click for time gone'
                "
                @click="protoTimeMode = protoTimeMode === 'elapsed' ? 'remaining' : 'elapsed'"
              >
                {{ clock(ctx) }}
              </button>
            </div>
            <div class="truncate font-serif text-zinc-500">
              {{ ctx.p.loading ? "buffering…" : (now?.text ?? ctx.book?.title) }}
            </div>
          </div>
          <button
            class="icon-btn"
            :class="pinned && 'icon-btn-on'"
            :title="pinned ? 'let the player fold away' : 'keep the player open'"
            @click="pinned = !pinned"
          >
            <ChevronUp class="icon-sm transition-transform" :class="pinned && 'rotate-180'" />
          </button>
        </div>
        <!-- grown -->
        <div
          class="grid grid-rows-[0fr] transition-[grid-template-rows] group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr] [.is-pinned&]:grid-rows-[1fr]"
        >
          <div class="min-h-0 overflow-hidden">
            <div class="border-t border-zinc-200 px-3 pb-3 pt-2 dark:border-zinc-800">
              <ProtoTimeline :ctx="ctx" height="h-4" preview />
              <div class="mt-2 flex items-center gap-1.5">
                <button
                  class="icon-btn"
                  :disabled="!ctx.isThis"
                  title="previous line (k)"
                  @click="ctx.prev()"
                >
                  <PrevIcon class="icon-sm" />
                </button>
                <button
                  class="icon-btn"
                  :disabled="!ctx.isThis"
                  title="back 10 s (,)"
                  @click="ctx.skip(-10)"
                >
                  <BackIcon class="icon-sm" />
                </button>
                <button
                  class="icon-btn"
                  :disabled="!ctx.isThis"
                  title="forward 10 s (.)"
                  @click="ctx.skip(10)"
                >
                  <FwdIcon class="icon-sm" />
                </button>
                <button
                  class="icon-btn"
                  :disabled="!ctx.isThis"
                  title="next line (j)"
                  @click="ctx.next()"
                >
                  <NextIcon class="icon-sm" />
                </button>
                <span class="mx-1 font-mono text-[10px] text-zinc-400">{{ fmt(ctx.total) }}</span>
                <span class="ml-auto flex items-center gap-1.5">
                  <button
                    class="icon-btn"
                    :class="protoLoop != null && 'icon-btn-on'"
                    :disabled="now == null"
                    :title="
                      protoLoop != null
                        ? 'repeating this line — click to stop (r)'
                        : 'repeat this line (r)'
                    "
                    @click="protoLoop = protoLoop == null ? (ctx.current ?? now?.id ?? null) : null"
                  >
                    <LoopIcon class="icon-sm" />
                  </button>
                  <ProtoFlag
                    v-if="now"
                    :segment="now"
                    :open="flagOpen === now.id"
                    @update:open="(v) => (flagOpen = v ? now!.id : null)"
                  />
                  <UiToggleGroup
                    :model-value="ctx.p.rate"
                    :options="rateOptions"
                    class="font-mono"
                    @update:model-value="(r) => ctx.setRate(Number(r))"
                  />
                  <button
                    class="icon-btn"
                    :class="ctx.follow && 'icon-btn-on'"
                    :title="
                      ctx.follow ? 'following the reading — click to stop' : 'follow the reading'
                    "
                    @click="ctx.follow ? ctx.setFollow(false) : backToLine()"
                  >
                    <FollowIcon class="icon-sm" />
                  </button>
                  <button
                    class="icon-btn"
                    :class="protoStopAtEnd && 'icon-btn-on'"
                    :title="
                      protoStopAtEnd
                        ? 'stops at the end of this chapter'
                        : 'runs on into the next chapter — click to stop at the end'
                    "
                    @click="protoStopAtEnd = !protoStopAtEnd"
                  >
                    <StopIcon class="icon-sm" />
                  </button>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div
      v-if="!ctx.follow && ctx.isThis && ctx.p.playing"
      class="fixed inset-x-0 bottom-24 z-30 flex justify-center lg:pl-60"
    >
      <button
        class="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
        @click="backToLine"
      >
        ↓ back to the line being read
      </button>
    </div>
  </div>
</template>
