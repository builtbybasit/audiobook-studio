<script setup lang="ts">
// PROTOTYPE — throwaway. Variant A, "Dock": today's reading column kept, with the transport the
// page never had pinned to the bottom of the card — the stitched scrubber, ±10 s, previous and next
// line, speed, time, the next and previous narrated chapter, a follow lock and stop-at-end — and a
// flag on every line, shown on hover and always on the line playing.
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
  Rewind as BackIcon,
  Square as StopIcon,
} from "@lucide/vue";
import ReaderSettings from "@/components/ReaderSettings.vue";
import ListenLine from "@/views/listen/ListenLine.vue";
import ProtoFlag from "@/views/listen/prototype/ProtoFlag.vue";
import ProtoTimeline from "@/views/listen/prototype/ProtoTimeline.vue";
import { UiCombobox } from "@/ui";
import { useReader } from "@/stores/reader";
import {
  fmt,
  focusRow,
  isNarratedChapter,
  neighbour,
  placeOf,
  protoFlags,
  protoStopAtEnd,
  useProtoKeys,
  type ListenCtx,
} from "@/views/listen/prototype/ctx";

const props = defineProps<{ ctx: ListenCtx }>();
const reader = useReader();
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
const flaggedCount = computed(() => c.value.rows.filter((s) => protoFlags.has(s.id)).length);
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
        <span class="text-xs text-zinc-500"
          >{{ placeOf(ctx) }} of {{ ctx.chapters.length }}
          <template v-if="flaggedCount"> · {{ flaggedCount }} flagged</template></span
        >
        <span class="ml-auto flex items-center gap-2"><ReaderSettings /></span>
      </header>

      <div class="px-4 py-6 sm:px-8">
        <div
          class="mx-auto"
          :class="[reader.widthClass, reader.fontClass]"
          :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }"
        >
          <h2 v-if="ctx.chapter" class="mb-5 font-serif text-2xl">{{ ctx.chapter.title }}</h2>
          <p v-if="!ctx.loaded" class="py-10 text-center font-sans text-sm text-zinc-500">
            Reading the script…
          </p>
          <p v-else-if="!ctx.narrated" class="py-10 text-center font-sans text-sm text-zinc-500">
            No narrated lines yet.
          </p>
          <template v-else>
            <div
              v-for="s in ctx.rows"
              :key="s.id"
              data-line
              class="relative"
              :class="s.audio.status !== 'done' && s.audio.status !== 'stale' && 'opacity-40'"
            >
              <ListenLine
                :segment="s"
                :marks="ctx.marks.get(s.id) ?? null"
                :on="ctx.current === s.id"
                :word="ctx.current === s.id ? ctx.word : -1"
                :color="ctx.colorOf(s.speaker)"
                @seek="(at) => ctx.listenFrom(s, at)"
              />
              <div
                class="line-tool absolute -right-9 top-1 flex flex-col gap-1 font-sans"
                :class="(ctx.current === s.id || protoFlags.has(s.id)) && 'is-on'"
              >
                <ProtoFlag
                  :segment="s"
                  :open="flagOpen === s.id"
                  @update:open="(v) => (flagOpen = v ? s.id : null)"
                />
              </div>
              <span
                v-if="ctx.heard[s.id]?.mismatch"
                class="absolute -left-9 top-2 font-sans text-[10px] text-red-500"
                :title="`heard: ${ctx.heard[s.id].heard}`"
                >heard?</span
              >
            </div>
          </template>
        </div>
      </div>

      <!-- the dock -->
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
          class="rounded-b-xl border-t border-zinc-200 bg-zinc-50/95 px-4 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
        >
          <div class="flex items-center gap-3">
            <div class="flex shrink-0 items-center gap-0.5">
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
                class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40"
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
            </div>
            <div class="min-w-0 flex-1">
              <div class="mb-1 flex items-center justify-between gap-2 text-xs">
                <span class="truncate">
                  <b
                    v-if="ctx.current != null"
                    :style="{ color: ctx.colorOf(focusRow(ctx)!.speaker) }"
                    >{{ focusRow(ctx)!.speaker }}</b
                  >
                  <span v-else-if="ctx.isThis && ctx.p.playing" class="text-zinc-500">silence</span>
                  <span v-else class="text-zinc-500">{{ ctx.chapter?.title }}</span>
                  <span v-if="ctx.p.loading" class="ml-1 text-zinc-400">buffering…</span>
                </span>
                <span class="flex shrink-0 items-center gap-1.5">
                  <ProtoFlag
                    v-if="focusRow(ctx)"
                    :segment="focusRow(ctx)!"
                    :open="flagOpen === focusRow(ctx)!.id"
                    @update:open="(v) => (flagOpen = v ? focusRow(ctx)!.id : null)"
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
                  <button
                    class="rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
                    title="playback speed"
                    @click="ctx.cycleRate()"
                  >
                    {{ ctx.p.rate }}×
                  </button>
                  <span class="font-mono text-zinc-500"
                    >{{ fmt(ctx.isThis ? ctx.p.pos : 0) }} / {{ fmt(ctx.total) }}
                    <span class="text-zinc-400"
                      >−{{ fmt(ctx.total - (ctx.isThis ? ctx.p.pos : 0)) }}</span
                    ></span
                  >
                </span>
              </div>
              <ProtoTimeline :ctx="ctx" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
