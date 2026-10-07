<script setup lang="ts">
// PROTOTYPE — throwaway. Variant F, "Headbar": A's column with the player in the sticky header
// rather than at the foot, where the chapter picker already is — the transport, the clock, the
// tools and the speed in one row, and the stitched chapter drawn as a thin strip along the
// header's bottom edge, the playhead moving across the top of the page you are reading. The
// foot stays empty, so the last lines of the chapter are never under a bar.
import { computed, ref } from "vue";
import {
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  ChevronLeft,
  ChevronRight,
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
import { UiCombobox } from "@/ui";
import { RATES } from "@/composables/usePlayer";
import {
  clock,
  fmt,
  focusRow,
  isNarratedChapter,
  neighbour,
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
function backToLine() {
  c.value.setFollow(true);
  if (c.value.current != null)
    document
      .getElementById(`seg-${c.value.current}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
}
</script>

<template>
  <div class="p-4">
    <div class="card mx-auto max-w-5xl">
      <header
        class="sticky top-0 z-10 rounded-t-xl border-b border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
      >
        <div class="flex flex-wrap items-center gap-2 px-4 pb-2 pt-2.5">
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

          <div class="mx-auto flex items-center gap-1">
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
              class="mx-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40"
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
            <button
              class="ml-2 font-mono text-xs text-zinc-500 hover:text-violet-600"
              :title="
                protoTimeMode === 'elapsed'
                  ? 'time gone — click for time left'
                  : 'time left — click for time gone'
              "
              @click="protoTimeMode = protoTimeMode === 'elapsed' ? 'remaining' : 'elapsed'"
            >
              {{ clock(ctx) }} <span class="text-zinc-400">/ {{ fmt(ctx.total) }}</span>
            </button>
          </div>

          <span class="flex items-center gap-1.5">
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
            <button
              class="rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
              :title="`playback speed — next ${RATES[(RATES.indexOf(ctx.p.rate as (typeof RATES)[number]) + 1) % RATES.length]}×`"
              @click="ctx.cycleRate()"
            >
              {{ ctx.p.rate }}×
            </button>
            <button
              class="icon-btn"
              :class="ctx.follow && 'icon-btn-on'"
              :title="ctx.follow ? 'following the reading — click to stop' : 'follow the reading'"
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
            <ReaderSettings />
          </span>
        </div>
        <div v-if="now && ctx.isThis" class="flex items-center gap-2 px-4 pb-1.5 text-[11px]">
          <span
            class="inline-block h-2 w-2 shrink-0 rounded-full"
            :style="{ background: ctx.colorOf(now.speaker) }"
          ></span>
          <b :style="{ color: ctx.colorOf(now.speaker) }">{{ now.speaker }}</b>
          <span class="truncate font-serif text-zinc-500">{{ now.text }}</span>
          <span class="ml-auto shrink-0 font-mono text-[10px] text-zinc-400"
            >line {{ ctx.rows.indexOf(now) + 1 }} / {{ ctx.rows.length }}</span
          >
        </div>
        <ProtoTimeline :ctx="ctx" height="h-1.5 hover:h-4 transition-all" preview />
        <div
          v-if="!ctx.follow && ctx.isThis && ctx.p.playing"
          class="absolute inset-x-0 top-full flex justify-center pt-2"
        >
          <button
            class="rounded-full bg-zinc-900 px-3 py-1 text-xs text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
            @click="backToLine"
          >
            ↓ back to the line being read
          </button>
        </div>
      </header>
      <ProtoColumn v-model:flag-open="flagOpen" :ctx="ctx" />
    </div>
  </div>
</template>
