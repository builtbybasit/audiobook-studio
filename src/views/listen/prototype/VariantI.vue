<script setup lang="ts">
// PROTOTYPE — throwaway. Variant I, "Strip": E stretched across the whole width of the window at
// its foot, the way a video player's bar is. At rest the strip is the progress itself — the
// stitched chapter drawn faint with the played part lit, the play button, who is speaking and the
// clock laid over it. Hover (or pin) and it rises into a full deck with the scrubber tall enough to
// aim at and the transport and tools on their own row.
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
  <div class="p-4 pb-20">
    <div class="card mx-auto max-w-5xl">
      <ProtoHeader :ctx="ctx" />
      <ProtoColumn v-model:flag-open="flagOpen" :ctx="ctx" />
    </div>

    <div class="group fixed inset-x-0 bottom-0 z-30 lg:left-14" :class="pinned && 'is-pinned'">
      <div
        class="relative border-t border-zinc-200 bg-white/95 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
      >
        <!-- at rest: the strip is the progress -->
        <div
          class="pointer-events-none absolute inset-x-0 top-0 h-11 overflow-hidden transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 [.is-pinned_&]:opacity-0"
        >
          <div class="absolute inset-0 flex gap-px opacity-20">
            <div
              v-for="x in ctx.timeline"
              :key="x.s.id"
              class="h-full"
              :style="{
                width: ((x.end - x.start + x.gap) / ctx.total) * 100 + '%',
                background: ctx.colorOf(x.s.speaker),
              }"
            ></div>
          </div>
          <div
            class="absolute inset-y-0 left-0 bg-violet-500/15"
            :style="{ width: pct + '%' }"
          ></div>
          <div class="absolute inset-y-0 w-0.5 bg-violet-600" :style="{ left: pct + '%' }"></div>
        </div>
        <!-- the row that is always there -->
        <div class="relative flex h-11 items-center gap-3 px-4">
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
          <div class="flex min-w-0 flex-1 items-baseline gap-2 text-xs">
            <template v-if="now">
              <b class="shrink-0" :style="{ color: ctx.colorOf(now.speaker) }">{{ now.speaker }}</b>
              <span class="truncate font-serif text-zinc-600 dark:text-zinc-300">{{
                ctx.p.loading ? "buffering…" : now.text
              }}</span>
              <span class="shrink-0 font-mono text-[10px] text-zinc-400"
                >line {{ ctx.rows.indexOf(now) + 1 }} / {{ ctx.rows.length }}</span
              >
            </template>
            <span v-else class="truncate text-zinc-500">{{ ctx.chapter?.title }}</span>
          </div>
          <button
            class="shrink-0 font-mono text-xs text-zinc-500 hover:text-violet-600"
            :title="
              protoTimeMode === 'elapsed'
                ? 'time gone — click for time left'
                : 'time left — click for time gone'
            "
            @click="protoTimeMode = protoTimeMode === 'elapsed' ? 'remaining' : 'elapsed'"
          >
            {{ clock(ctx) }} <span class="text-zinc-400">/ {{ fmt(ctx.total) }}</span>
          </button>
          <button
            class="icon-btn"
            :class="pinned && 'icon-btn-on'"
            :title="pinned ? 'let the player fold away' : 'keep the player open'"
            @click="pinned = !pinned"
          >
            <PinIcon class="icon-sm" />
          </button>
        </div>
        <!-- risen -->
        <div
          class="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 group-hover:grid-rows-[1fr] group-focus-within:grid-rows-[1fr] [.is-pinned_&]:grid-rows-[1fr]"
        >
          <div class="min-h-0 overflow-hidden">
            <div class="px-4 pb-3">
              <ProtoTimeline :ctx="ctx" height="h-6" preview />
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
                <span class="ml-auto"><ProtoTools v-model:flag-open="flagOpen" :ctx="ctx" /></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
