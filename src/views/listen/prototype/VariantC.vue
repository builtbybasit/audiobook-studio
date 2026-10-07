<script setup lang="ts">
// PROTOTYPE — throwaway. Variant C, "Desk": the reading column with a gutter beside it (the line's
// place, a flag, a heard-wrong mark), and a sticky rail on the right that is the chapter at a
// glance — a vertical map of every line coloured by speaker with the playhead across it, a compact
// transport, what the check by ear heard of the line playing, the narrated chapters as a list, and
// the speakers in this chapter. The map is the primary control: click a row and it plays from there.
import { computed, ref } from "vue";
import {
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  FastForward as FwdIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Rewind as BackIcon,
} from "@lucide/vue";
import ReaderSettings from "@/components/ReaderSettings.vue";
import ListenLine from "@/views/listen/ListenLine.vue";
import ProtoFlag from "@/views/listen/prototype/ProtoFlag.vue";
import { UiHint } from "@/ui";
import { useReader } from "@/stores/reader";
import { FLAG_LABEL } from "@/lib/scriptReview";
import {
  fmt,
  focusRow,
  isNarratedChapter,
  protoFlags,
  protoStopAtEnd,
  speakersOf,
  useProtoKeys,
  type ListenCtx,
} from "@/views/listen/prototype/ctx";

const props = defineProps<{ ctx: ListenCtx }>();
const reader = useReader();
const c = computed(() => props.ctx);
const speakers = computed(() => speakersOf(c.value));
const narratedChapters = computed(() => c.value.chapters.filter(isNarratedChapter));
const flagOpen = ref<number | null>(null);
useProtoKeys(
  () => c.value,
  () => {
    const s = focusRow(c.value);
    if (s) flagOpen.value = s.id;
  },
);
const now = computed(() => focusRow(c.value));
const heardNow = computed(() => (now.value ? c.value.heard[now.value.id] : undefined));
const flagged = computed(() =>
  c.value.rows.filter((s) => protoFlags.has(s.id) || s.flag || c.value.heard[s.id]?.mismatch),
);
const placeIn = (id: number) => c.value.chapters.findIndex((ch) => ch.id === id) + 1;
</script>

<template>
  <div class="p-4">
    <div class="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <!-- reading column -->
      <div class="card">
        <header
          class="sticky top-0 z-10 flex items-center gap-2 rounded-t-xl border-b border-zinc-200 bg-white/95 px-4 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
        >
          <h2 class="truncate font-serif text-lg">{{ ctx.chapter?.title }}</h2>
          <span class="text-xs text-zinc-500"
            >{{ ctx.rows.length }} lines · {{ fmt(ctx.total) }}</span
          >
          <span class="ml-auto flex items-center gap-2">
            <UiHint
              label="the gutter"
              text="Each line's place in the chapter. A flag you raised shows amber; a line the check by ear heard say something else shows red."
            />
            <ReaderSettings />
          </span>
        </header>
        <div class="px-4 py-6 sm:px-10">
          <div
            class="mx-auto"
            :class="[reader.widthClass, reader.fontClass]"
            :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }"
          >
            <p v-if="!ctx.loaded" class="py-10 text-center font-sans text-sm text-zinc-500">
              Reading the script…
            </p>
            <p v-else-if="!ctx.narrated" class="py-10 text-center font-sans text-sm text-zinc-500">
              No narrated lines yet.
            </p>
            <div v-for="(s, i) in ctx.rows" v-else :key="s.id" data-line class="relative">
              <div
                class="absolute -left-12 top-1.5 flex w-8 flex-col items-end gap-0.5 font-sans text-[10px] leading-none text-zinc-400"
              >
                <span :class="ctx.current === s.id && 'font-bold text-violet-600'">{{
                  i + 1
                }}</span>
                <span
                  v-if="ctx.heard[s.id]?.mismatch"
                  class="h-1.5 w-1.5 rounded-full bg-red-500"
                  :title="`heard: ${ctx.heard[s.id].heard}`"
                ></span>
                <span
                  v-else-if="protoFlags.has(s.id) || s.flag"
                  class="h-1.5 w-1.5 rounded-full bg-amber-400"
                  :title="FLAG_LABEL[(protoFlags.get(s.id) ?? s.flag)!.kind]"
                ></span>
              </div>
              <ListenLine
                :segment="s"
                :marks="ctx.marks.get(s.id) ?? null"
                :on="ctx.current === s.id"
                :word="ctx.current === s.id ? ctx.word : -1"
                :color="ctx.colorOf(s.speaker)"
                @seek="(at) => ctx.listenFrom(s, at)"
              />
              <div
                class="line-tool absolute -right-8 top-1 font-sans"
                :class="ctx.current === s.id && 'is-on'"
              >
                <ProtoFlag
                  :segment="s"
                  :open="flagOpen === s.id"
                  @update:open="(v) => (flagOpen = v ? s.id : null)"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- the rail -->
      <aside class="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <!-- transport -->
        <div class="card p-3">
          <div class="flex items-center justify-center gap-1">
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
              class="mx-1 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40"
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
          <div class="mt-2 flex items-center justify-between text-xs text-zinc-500">
            <span class="font-mono"
              >{{ fmt(ctx.isThis ? ctx.p.pos : 0) }} / {{ fmt(ctx.total) }}</span
            >
            <button
              class="rounded border border-zinc-200 px-1 font-mono text-[10px] hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
              @click="ctx.cycleRate()"
            >
              {{ ctx.p.rate }}×
            </button>
            <label class="flex items-center gap-1">
              <input v-model="protoStopAtEnd" type="checkbox" class="accent-violet-600" /> stop at
              end
            </label>
          </div>
        </div>

        <!-- now playing / heard -->
        <div v-if="now" class="card p-3 text-xs">
          <div class="label mb-1">{{ ctx.current != null ? "Now" : "Next to play" }}</div>
          <div class="flex items-center gap-2">
            <span
              class="inline-block h-2.5 w-2.5 rounded-full"
              :style="{ background: ctx.colorOf(now.speaker) }"
            ></span>
            <b>{{ now.speaker }}</b>
            <span class="text-zinc-500">line {{ ctx.rows.indexOf(now) + 1 }}</span>
            <span class="ml-auto">
              <ProtoFlag
                :segment="now"
                :open="flagOpen === now.id"
                @update:open="(v) => (flagOpen = v ? now!.id : null)"
              />
            </span>
          </div>
          <div v-if="heardNow" class="mt-2 space-y-1">
            <div class="text-zinc-500">heard as</div>
            <div
              class="rounded bg-zinc-50 p-1.5 font-serif dark:bg-zinc-800/60"
              :class="heardNow.mismatch ? 'text-red-600 dark:text-red-400' : ''"
            >
              {{ heardNow.heard }}
            </div>
            <div class="text-zinc-400">
              {{ heardNow.mismatch ? "does not match the line" : "matches the line" }} ·
              {{ Math.round(heardNow.score * 100) }}% off
            </div>
          </div>
          <div v-else class="mt-2 text-zinc-400">not checked by ear</div>
        </div>

        <!-- chapter map -->
        <div class="card p-3">
          <div class="label mb-2 flex justify-between">
            <span>Chapter map</span>
            <span class="font-normal normal-case tracking-normal text-zinc-400">
              {{ flagged.length ? `${flagged.length} marked` : "click a row to play from it" }}
            </span>
          </div>
          <div class="relative flex h-52 flex-col gap-px overflow-hidden rounded">
            <button
              v-for="s in ctx.rows"
              :key="s.id"
              class="relative min-h-0 flex-1 transition-opacity hover:opacity-100"
              :style="{
                background: ctx.colorOf(s.speaker),
                opacity: ctx.current === s.id ? 1 : s.type === 'narration' ? 0.35 : 0.7,
                flexGrow: Math.max(1, s.audio.duration || 1),
              }"
              :title="s.speaker"
              @click="ctx.listenFrom(s, 0)"
            >
              <span
                v-if="ctx.heard[s.id]?.mismatch || protoFlags.has(s.id) || s.flag"
                class="absolute inset-y-0 right-0 w-1"
                :class="ctx.heard[s.id]?.mismatch ? 'bg-red-500' : 'bg-amber-400'"
              ></span>
              <span
                v-if="ctx.current === s.id"
                class="pointer-events-none absolute inset-0 border-y-2 border-black dark:border-white"
              ></span>
            </button>
          </div>
        </div>

        <!-- chapters -->
        <div class="card p-3 text-xs">
          <div class="label mb-2">Narrated chapters</div>
          <ul class="max-h-32 space-y-0.5 overflow-y-auto">
            <li v-for="ch in narratedChapters" :key="ch.id">
              <button
                class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                :class="
                  ch.id === ctx.opened &&
                  'bg-violet-500/10 font-medium text-violet-700 dark:text-violet-300'
                "
                @click="ctx.open(ch.id)"
              >
                <span class="w-5 shrink-0 text-right font-mono text-zinc-400">{{
                  placeIn(ch.id)
                }}</span>
                <span class="truncate">{{ ch.title }}</span>
                <span class="ml-auto shrink-0 font-mono text-zinc-400">{{ fmt(ch.duration) }}</span>
              </button>
            </li>
          </ul>
        </div>

        <!-- speakers -->
        <div class="card p-3 text-xs">
          <div class="label mb-2">Voices in this chapter</div>
          <div class="flex flex-wrap gap-1">
            <span v-for="sp in speakers" :key="sp.name" class="chip">
              <span
                class="inline-block h-2 w-2 rounded-full"
                :style="{ background: sp.color }"
              ></span>
              {{ sp.name }} <span class="text-zinc-400">{{ sp.n }}</span>
            </span>
          </div>
        </div>
        <p class="px-1 font-mono text-[10px] text-zinc-400">
          space · j/k line · , . ±10 s · f flag
        </p>
      </aside>
    </div>
  </div>
</template>
