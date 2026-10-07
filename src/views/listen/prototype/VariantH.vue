<script setup lang="ts">
// PROTOTYPE — throwaway. Variant H, "Orb": the least of E that can still be a player. At rest, only
// the play button with the progress ring round it and the clock under it, in the bottom-right
// corner, out of the reading's way entirely. Hover (or pin) and a panel unfolds to its left: who is
// speaking and the words, the scrubber, the transport and the tools. The corner is where a thumb
// or a pointer rests, so it is also where the player waits.
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
const R = 26;
const C = 2 * Math.PI * R;
const dash = computed(() => {
  const pos = c.value.isThis ? c.value.p.pos : 0;
  return C * (1 - (c.value.total ? pos / c.value.total : 0));
});
</script>

<template>
  <div class="p-4">
    <div class="card mx-auto max-w-5xl">
      <ProtoHeader :ctx="ctx" />
      <ProtoColumn v-model:flag-open="flagOpen" :ctx="ctx" />
    </div>

    <div
      class="group fixed bottom-5 right-5 z-30 flex items-end gap-2"
      :class="pinned && 'is-pinned'"
    >
      <!-- the panel, unfolding leftward -->
      <div
        class="pointer-events-none w-[26rem] max-w-[calc(100vw-7rem)] translate-x-3 opacity-0 transition-all duration-200 group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100 [.is-pinned_&]:pointer-events-auto [.is-pinned_&]:translate-x-0 [.is-pinned_&]:opacity-100"
      >
        <div class="card p-3 shadow-2xl">
          <div class="mb-2 flex items-center gap-2 text-xs">
            <template v-if="now">
              <span
                class="inline-block h-2 w-2 shrink-0 rounded-full"
                :style="{ background: ctx.colorOf(now.speaker) }"
              ></span>
              <b class="shrink-0">{{ now.speaker }}</b>
              <span class="truncate font-serif text-zinc-500">{{ now.text }}</span>
              <span class="ml-auto shrink-0 font-mono text-[10px] text-zinc-400"
                >line {{ ctx.rows.indexOf(now) + 1 }} / {{ ctx.rows.length }}</span
              >
            </template>
            <span v-else class="text-zinc-500">{{ ctx.chapter?.title }}</span>
          </div>
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
            <span class="ml-auto"
              ><ProtoTools v-model:flag-open="flagOpen" :ctx="ctx" rate="cycle"
            /></span>
            <button
              class="icon-btn"
              :class="pinned && 'icon-btn-on'"
              :title="pinned ? 'let the player fold away' : 'keep the player open'"
              @click="pinned = !pinned"
            >
              <PinIcon class="icon-sm" />
            </button>
          </div>
        </div>
      </div>
      <!-- the orb -->
      <div class="flex flex-col items-center gap-1">
        <button
          class="relative grid h-14 w-14 place-items-center rounded-full bg-white text-violet-600 shadow-2xl disabled:opacity-40 dark:bg-zinc-900"
          :disabled="!ctx.total"
          title="play / pause (space)"
          @click="ctx.playChapter()"
        >
          <svg class="absolute inset-0 -rotate-90" viewBox="0 0 56 56" aria-hidden="true">
            <circle
              cx="28"
              cy="28"
              :r="R"
              class="fill-none stroke-zinc-200 dark:stroke-zinc-700"
              stroke-width="3"
            />
            <circle
              cx="28"
              cy="28"
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
            class="h-5 w-5 icon-fill"
          />
        </button>
        <button
          class="rounded-full bg-white/90 px-1.5 font-mono text-[10px] text-zinc-500 shadow hover:text-violet-600 dark:bg-zinc-900/90"
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
    </div>
  </div>
</template>
