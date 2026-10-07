<script setup lang="ts">
// PROTOTYPE — throwaway. Variant B, "Stage": no scrolling page at all. The line being said is the
// whole screen — large, in its speaker's colour, the word lit — with two lines either side dimmed
// for context; a thin chapter progress bar above, one big transport below, the chapter's speakers
// as chips, and the keys on screen. Built for listening with the window across the room, or for
// checking one voice at a time: a speaker chip jumps to that voice's next line.
import { computed, ref } from "vue";
import {
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  ChevronLeft,
  ChevronRight,
  FastForward as FwdIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Rewind as BackIcon,
} from "@lucide/vue";
import ProtoFlag from "@/views/listen/prototype/ProtoFlag.vue";
import { piecesOf } from "@/lib/listen";
import { useReader } from "@/stores/reader";
import {
  fmt,
  neighbour,
  placeOf,
  protoFlags,
  protoStopAtEnd,
  speakersOf,
  useProtoKeys,
  type ListenCtx,
} from "@/views/listen/prototype/ctx";

const props = defineProps<{ ctx: ListenCtx }>();
const reader = useReader();
const c = computed(() => props.ctx);
/** the line on stage: the one playing, else where the person last clicked, else the first */
const chosen = ref<number | null>(null);
const idx = computed(() => {
  const id = c.value.current ?? chosen.value;
  const i = c.value.rows.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
});
const stage = computed(() => c.value.rows[idx.value]);
const around = computed(() => {
  const i = idx.value;
  return {
    before: c.value.rows.slice(Math.max(0, i - 2), i),
    after: c.value.rows.slice(i + 1, i + 3),
  };
});
const pieces = computed(() => {
  const s = stage.value;
  if (!s) return null;
  const m = c.value.marks.get(s.id);
  return m ? piecesOf(s.text, m) : null;
});
const speakers = computed(() => speakersOf(c.value));
const flagOpen = ref(false);
useProtoKeys(
  () => c.value,
  () => (flagOpen.value = true),
);
function go(s: { id: number }) {
  chosen.value = s.id;
  const row = c.value.rows.find((r) => r.id === s.id);
  if (row) c.value.listenFrom(row, 0);
}
/** the next line of this speaker after the one on stage, wrapping to the first */
function jumpTo(name: string) {
  const rows = c.value.rows;
  const from = idx.value;
  const next =
    rows.slice(from + 1).find((s) => s.speaker === name) ?? rows.find((s) => s.speaker === name);
  if (next) go(next);
}
const pct = computed(() =>
  c.value.total && c.value.isThis ? (c.value.p.pos / c.value.total) * 100 : 0,
);
const before = computed(() => neighbour(c.value, -1));
const after = computed(() => neighbour(c.value, 1));
</script>

<template>
  <div class="flex min-h-[calc(100vh-7rem)] flex-col p-4">
    <!-- chapter strip -->
    <div class="mx-auto w-full max-w-4xl">
      <div class="h-1 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
        <div class="h-full bg-violet-500 transition-[width]" :style="{ width: pct + '%' }"></div>
      </div>
      <div class="mt-2 flex items-center gap-2 text-xs text-zinc-500">
        <button
          class="icon-btn"
          :disabled="!before"
          title="previous narrated chapter"
          @click="before && ctx.open(before.id)"
        >
          <ChevronLeft class="icon-sm" />
        </button>
        <span class="truncate"
          ><b class="text-zinc-700 dark:text-zinc-200">{{ ctx.chapter?.title }}</b> · chapter
          {{ placeOf(ctx) }} of {{ ctx.chapters.length }}</span
        >
        <button
          class="icon-btn"
          :disabled="!after"
          title="next narrated chapter"
          @click="after && ctx.open(after.id)"
        >
          <ChevronRight class="icon-sm" />
        </button>
        <span class="ml-auto font-mono"
          >{{ fmt(ctx.isThis ? ctx.p.pos : 0) }} / {{ fmt(ctx.total) }}</span
        >
        <span>line {{ idx + 1 }} of {{ ctx.rows.length }}</span>
      </div>
    </div>

    <!-- the stage -->
    <div class="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center py-10">
      <p v-if="!ctx.loaded" class="text-center text-sm text-zinc-500">Reading the script…</p>
      <p v-else-if="!ctx.narrated" class="text-center text-sm text-zinc-500">
        No narrated lines yet.
      </p>
      <template v-else-if="stage">
        <div class="space-y-2 text-center" :class="reader.fontClass">
          <p
            v-for="s in around.before"
            :key="s.id"
            class="cursor-pointer text-base text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
            :class="s.type !== 'narration' && 'italic'"
            @click="go(s)"
          >
            {{ s.text }}
          </p>
        </div>

        <div class="my-8 text-center" :class="reader.fontClass">
          <div
            v-if="stage.type !== 'narration'"
            class="mb-3 font-sans text-xs font-semibold uppercase tracking-widest"
            :style="{ color: ctx.colorOf(stage.speaker) }"
          >
            {{ stage.speaker
            }}<span v-if="stage.type === 'thought'" class="text-zinc-400"> · thinks</span>
          </div>
          <p
            class="mx-auto max-w-3xl text-3xl leading-snug sm:text-4xl"
            :class="stage.type === 'thought' && 'italic'"
          >
            <template v-if="pieces"
              ><template v-for="(piece, i) in pieces" :key="i"
                ><span
                  v-if="piece.mark != null"
                  class="cursor-pointer rounded px-0.5 transition-colors"
                  :class="
                    ctx.current === stage.id && ctx.word === piece.mark
                      ? 'bg-violet-500 text-white'
                      : 'hover:bg-violet-500/15'
                  "
                  @click="ctx.listenFrom(stage!, ctx.marks.get(stage!.id)![piece.mark][2])"
                  >{{ piece.text }}</span
                ><template v-else>{{ piece.text }}</template></template
              ></template
            >
            <template v-else>{{ stage.text }}</template>
          </p>
          <div class="mt-4 flex items-center justify-center gap-2 font-sans">
            <ProtoFlag
              v-model:open="flagOpen"
              :segment="stage"
              size="lg"
              :label="protoFlags.has(stage.id) ? 'flagged' : 'flag this line'"
            />
            <span v-if="ctx.heard[stage.id]?.mismatch" class="text-xs text-red-500"
              >heard: “{{ ctx.heard[stage.id].heard }}”</span
            >
            <span v-else-if="ctx.heard[stage.id]" class="text-xs text-emerald-600"
              >checked by ear</span
            >
            <span v-else class="text-xs text-zinc-400">not checked by ear</span>
          </div>
        </div>

        <div class="space-y-2 text-center" :class="reader.fontClass">
          <p
            v-for="s in around.after"
            :key="s.id"
            class="cursor-pointer text-base text-zinc-400 transition-colors hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
            :class="s.type !== 'narration' && 'italic'"
            @click="go(s)"
          >
            {{ s.text }}
          </p>
        </div>
      </template>
    </div>

    <!-- speakers + transport -->
    <div class="mx-auto w-full max-w-4xl space-y-4">
      <div class="flex flex-wrap justify-center gap-1.5">
        <button
          v-for="sp in speakers"
          :key="sp.name"
          class="chip"
          :class="stage?.speaker === sp.name && 'chip-on'"
          :title="`next line of ${sp.name}`"
          @click="jumpTo(sp.name)"
        >
          <span class="inline-block h-2 w-2 rounded-full" :style="{ background: sp.color }"></span>
          {{ sp.name }} <span class="text-zinc-400">{{ sp.n }}</span>
        </button>
      </div>
      <div class="flex items-center justify-center gap-2">
        <button
          class="icon-btn h-8 w-8"
          :disabled="!ctx.isThis"
          title="previous line (k)"
          @click="ctx.prev()"
        >
          <PrevIcon class="icon" />
        </button>
        <button
          class="icon-btn h-8 w-8"
          :disabled="!ctx.isThis"
          title="back 10 s (,)"
          @click="ctx.skip(-10)"
        >
          <BackIcon class="icon" />
        </button>
        <button
          class="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-violet-600 text-white shadow-lg disabled:opacity-40"
          :disabled="!ctx.total"
          title="play / pause (space)"
          @click="ctx.playChapter()"
        >
          <component
            :is="ctx.isThis && ctx.p.playing ? PauseIcon : PlayIcon"
            class="h-6 w-6 icon-fill"
          />
        </button>
        <button
          class="icon-btn h-8 w-8"
          :disabled="!ctx.isThis"
          title="forward 10 s (.)"
          @click="ctx.skip(10)"
        >
          <FwdIcon class="icon" />
        </button>
        <button
          class="icon-btn h-8 w-8"
          :disabled="!ctx.isThis"
          title="next line (j)"
          @click="ctx.next()"
        >
          <NextIcon class="icon" />
        </button>
        <button
          class="ml-3 rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
          title="playback speed"
          @click="ctx.cycleRate()"
        >
          {{ ctx.p.rate }}×
        </button>
        <label class="ml-2 flex items-center gap-1 text-xs text-zinc-500">
          <input v-model="protoStopAtEnd" type="checkbox" class="accent-violet-600" /> stop at
          chapter end
        </label>
      </div>
      <p class="text-center font-mono text-[10px] text-zinc-400">
        space play · j/k line · , . ±10 s · f flag · click a speaker for their next line
      </p>
    </div>
  </div>
</template>
