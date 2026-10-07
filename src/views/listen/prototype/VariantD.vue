<script setup lang="ts">
// PROTOTYPE — throwaway. Variant D, "Deck": A's column with a taller, three-row player at the foot
// in the shape of a music app's. Row one says what is being read — the speaker in colour, the line's
// words, its place and how many lines are marked. Row two is the scrubber as the hero: tall, with
// the time and the speaker under the pointer before you click. Row three is the transport centred,
// the clock on the left (click it: time gone or time left), and the tools on the right — repeat this
// line, flag, speed as a picker, follow, stop at end, next narrated chapter.
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
import { UiCombobox, UiToggleGroup } from "@/ui";
import { RATES } from "@/composables/usePlayer";
import {
  clock,
  fmt,
  focusRow,
  isMarked,
  isNarratedChapter,
  neighbour,
  nextMarked,
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
const place = computed(() => (now.value ? c.value.rows.indexOf(now.value) + 1 : 0));
const marked = computed(() => c.value.rows.filter((s) => isMarked(c.value, s)).length);
const rateOptions = RATES.map((r) => ({ value: r, label: `${r}×` }));
function backToLine() {
  c.value.setFollow(true);
  if (c.value.current != null)
    document
      .getElementById(`seg-${c.value.current}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
}
function jumpMarked(d: 1 | -1) {
  const s = nextMarked(c.value, d);
  if (s) c.value.listenFrom(s, 0);
}
</script>

<template>
  <div class="p-4">
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

      <!-- the deck -->
      <div class="sticky bottom-0 z-10">
        <div v-if="!ctx.follow && ctx.isThis && ctx.p.playing" class="flex justify-center">
          <button
            class="mb-2 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white shadow-lg dark:bg-zinc-100 dark:text-zinc-900"
            @click="backToLine"
          >
            ↓ back to the line being read
          </button>
        </div>
        <div
          class="rounded-b-xl border-t border-zinc-200 bg-zinc-50/95 px-5 pb-3 pt-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
        >
          <!-- row 1: what is being read -->
          <div class="mb-2 flex items-center gap-2 text-xs">
            <template v-if="now">
              <span
                class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                :style="{ background: ctx.colorOf(now.speaker) }"
              ></span>
              <b class="shrink-0" :style="{ color: ctx.colorOf(now.speaker) }">{{ now.speaker }}</b>
              <span class="truncate font-serif text-zinc-600 dark:text-zinc-300">{{
                now.text
              }}</span>
            </template>
            <span v-else class="text-zinc-500">{{ ctx.chapter?.title }}</span>
            <span class="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">
              <span v-if="ctx.p.loading" class="mr-2 text-zinc-400">buffering…</span>
              line {{ place }} / {{ ctx.rows.length }}
              <template v-if="marked">
                ·
                <button
                  class="hover:text-amber-600"
                  title="previous marked line ([)"
                  @click="jumpMarked(-1)"
                >
                  ‹
                </button>
                <span class="text-amber-600">{{ marked }} marked</span>
                <button
                  class="hover:text-amber-600"
                  title="next marked line (])"
                  @click="jumpMarked(1)"
                >
                  ›
                </button>
              </template>
            </span>
          </div>
          <!-- row 2: the scrubber -->
          <ProtoTimeline :ctx="ctx" height="h-7" preview />
          <!-- row 3: transport -->
          <div class="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <button
              class="justify-self-start font-mono text-xs text-zinc-500 hover:text-violet-600"
              :title="
                protoTimeMode === 'elapsed'
                  ? 'time gone — click for time left'
                  : 'time left — click for time gone'
              "
              @click="protoTimeMode = protoTimeMode === 'elapsed' ? 'remaining' : 'elapsed'"
            >
              {{ clock(ctx) }} <span class="text-zinc-400">/ {{ fmt(ctx.total) }}</span>
            </button>
            <div class="flex items-center gap-1.5">
              <button
                class="icon-btn h-7 w-7"
                :disabled="!ctx.isThis"
                title="previous line (k)"
                @click="ctx.prev()"
              >
                <PrevIcon class="icon" />
              </button>
              <button
                class="icon-btn h-7 w-7"
                :disabled="!ctx.isThis"
                title="back 10 s (,)"
                @click="ctx.skip(-10)"
              >
                <BackIcon class="icon" />
              </button>
              <button
                class="mx-1 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-violet-600 text-white shadow disabled:opacity-40"
                :disabled="!ctx.total"
                title="play / pause (space)"
                @click="ctx.playChapter()"
              >
                <component
                  :is="ctx.isThis && ctx.p.playing ? PauseIcon : PlayIcon"
                  class="icon-lg icon-fill"
                />
              </button>
              <button
                class="icon-btn h-7 w-7"
                :disabled="!ctx.isThis"
                title="forward 10 s (.)"
                @click="ctx.skip(10)"
              >
                <FwdIcon class="icon" />
              </button>
              <button
                class="icon-btn h-7 w-7"
                :disabled="!ctx.isThis"
                title="next line (j)"
                @click="ctx.next()"
              >
                <NextIcon class="icon" />
              </button>
            </div>
            <div class="flex items-center gap-1.5 justify-self-end">
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
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
