<script setup lang="ts">
// PROTOTYPE — throwaway. Variant G, "Pill": E made slimmer. At rest a single slim pill — play,
// who is speaking and the words, the clock — with the chapter's progress as a hairline along its
// bottom edge. Hover (or pin) and it grows upward: the scrubber, the transport and the tools unfold
// above the pill, so the pill itself never moves and the hand stays where it was.
import { computed, ref } from "vue";
import {
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  FastForward as FwdIcon,
  Pause as PauseIcon,
  Pin as PinIcon,
  Play as PlayIcon,
  Rewind as BackIcon,
} from "@lucide/vue";
import ProtoColumn from "@/views/listen/prototype/ProtoColumn.vue";
import ProtoHeader from "@/views/listen/prototype/ProtoHeader.vue";
import ProtoTimeline from "@/views/listen/prototype/ProtoTimeline.vue";
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
const pinned = ref(false);
const pct = computed(() =>
  c.value.total && c.value.isThis ? (c.value.p.pos / c.value.total) * 100 : 0,
);
</script>

<template>
  <div class="p-4 pb-24">
    <div class="card mx-auto max-w-5xl">
      <ProtoHeader :ctx="ctx" />
      <ProtoColumn v-model:flag-open="flagOpen" :ctx="ctx" />
    </div>

    <div
      class="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4 lg:pl-14"
    >
      <div class="group pointer-events-auto w-full max-w-lg" :class="pinned && 'is-pinned'">
        <!-- grows upward -->
        <div
          class="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr] [.is-pinned_&]:grid-rows-[1fr]"
        >
          <div class="min-h-0 overflow-hidden">
            <div class="card mb-1.5 px-3 pb-2.5 pt-3 shadow-xl">
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
                <span class="ml-auto"><ProtoTools v-model:flag-open="flagOpen" :ctx="ctx" /></span>
              </div>
            </div>
          </div>
        </div>
        <!-- the pill -->
        <div
          class="relative overflow-hidden rounded-full border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div class="flex items-center gap-2.5 py-1 pl-1 pr-2">
            <button
              class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40"
              :disabled="!ctx.total"
              title="play / pause (space)"
              @click="ctx.playChapter()"
            >
              <component
                :is="ctx.isThis && ctx.p.playing ? PauseIcon : PlayIcon"
                class="icon icon-fill"
              />
            </button>
            <div class="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs">
              <template v-if="now">
                <b class="shrink-0" :style="{ color: ctx.colorOf(now.speaker) }">{{
                  now.speaker
                }}</b>
                <span class="truncate font-serif text-zinc-500">{{
                  ctx.p.loading ? "buffering…" : now.text
                }}</span>
              </template>
              <span v-else class="truncate text-zinc-500">{{ ctx.chapter?.title }}</span>
            </div>
            <button
              class="shrink-0 font-mono text-[11px] text-zinc-500 hover:text-violet-600"
              :title="
                protoTimeMode === 'elapsed'
                  ? 'time gone — click for time left'
                  : 'time left — click for time gone'
              "
              @click="protoTimeMode = protoTimeMode === 'elapsed' ? 'remaining' : 'elapsed'"
            >
              {{ clock(ctx) }}
            </button>
            <button
              class="icon-btn h-5 w-5 rounded-full"
              :class="pinned && 'icon-btn-on'"
              :title="pinned ? 'let the player fold away' : 'keep the player open'"
              @click="pinned = !pinned"
            >
              <PinIcon class="icon-sm" />
            </button>
          </div>
          <div class="h-0.5 bg-zinc-200 dark:bg-zinc-800">
            <div class="h-full bg-violet-500" :style="{ width: pct + '%' }"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
