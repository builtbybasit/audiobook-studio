<script setup lang="ts">
// One chapter, in full, beside the list: where it sits in the book, what the import saw in it and
// why, the text with any note marked, and the decision. Opening it changes nothing — the list keeps
// its scroll and its filter, and the buttons here are the same actions the row offers.
import { computed } from "vue";
import { stateOf } from "@/lib/contents";
import { STATE_CHIP, words } from "@/views/contents/shared";
import type { Chapter, Volume } from "@/types";
import type { ContentPart } from "@/mock";
import MarkdownText from "@/components/MarkdownText.vue";
import {
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
  X as CloseIcon,
  Check as KeepIcon,
  SkipForward as SkipIcon,
  RotateCcw as RestoreIcon,
} from "@lucide/vue";

const props = defineProps<{
  chapter: Chapter;
  volume: Volume | undefined;
  multi: boolean;
  total: number;
  parts: ContentPart[];
  /** how many chapters are still to decide after this one */
  undecidedLeft: number;
  /** narrow screens: the preview is a sheet with its own close */
  sheet?: boolean;
}>();
const emit = defineEmits<{
  skip: [];
  include: [];
  keep: [];
  prev: [];
  next: [];
  nextUndecided: [];
  close: [];
}>();

const state = computed(() => stateOf(props.chapter));
const chip = computed(() => STATE_CHIP[state.value]);
const note = computed(() => props.chapter.note);
const noticeWords = computed(() =>
  props.parts
    .filter((p) => p.notice)
    .reduce((a, p) => a + p.text.split(/\s+/).filter(Boolean).length, 0),
);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="shrink-0 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <div class="text-[11px] text-zinc-500">
            <template v-if="multi && volume"
              >{{ volume.name }} · chapter {{ chapter.volumeIndex }} of
              {{ volume.to - volume.from + 1 }} ·
            </template>
            #{{ chapter.id }} of {{ total }} · {{ words(chapter.words) }}
          </div>
          <h2
            class="mt-0.5 font-serif text-lg leading-snug"
            :class="chapter.excluded && 'line-through decoration-zinc-400'"
          >
            {{ chapter.title }}
          </h2>
          <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span v-if="chip" class="chip" :class="chip.cls">{{ chip.label }}</span>
            <span v-if="note" class="text-zinc-500">{{ note.reason }}</span>
            <span v-else class="text-zinc-500">Story chapter · included</span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <button
            class="icon-btn"
            title="previous chapter"
            aria-label="Previous chapter"
            @click="emit('prev')"
          >
            <PrevIcon class="icon-sm" />
          </button>
          <button
            class="icon-btn"
            title="next chapter"
            aria-label="Next chapter"
            @click="emit('next')"
          >
            <NextIcon class="icon-sm" />
          </button>
          <button
            v-if="sheet"
            class="icon-btn"
            title="close"
            aria-label="Close the chapter"
            @click="emit('close')"
          >
            <CloseIcon class="icon-sm" />
          </button>
        </div>
      </div>

      <div
        v-if="note"
        class="mt-3 rounded-lg border px-3 py-2 text-xs"
        :class="
          note.verdict === 'skip'
            ? 'border-amber-300 bg-amber-400/10 dark:border-amber-500/40'
            : 'border-violet-300 bg-violet-500/10 dark:border-violet-500/40'
        "
      >
        <div class="font-medium">
          {{
            note.verdict === "skip"
              ? "Looks like a notice, not story"
              : "Worth a look before deciding"
          }}
        </div>
        <ul class="mt-1 list-disc space-y-0.5 pl-4 text-zinc-600 dark:text-zinc-300">
          <li v-for="e in note.evidence" :key="e">{{ e }}</li>
          <li v-if="note.kind === 'mixed' && noticeWords">
            the note is about {{ noticeWords }} words; the rest is story
          </li>
        </ul>
        <p v-if="note.kind === 'mixed'" class="mt-1.5 text-zinc-500">
          Keeping the chapter reads the note aloud too. Trimming it happens in Scripting once the
          chapter is scripted — nothing is cut here.
        </p>
        <p v-else-if="note.kind === 'title'" class="mt-1.5 text-zinc-500">
          The title is the only thing that looks like a notice. Read a paragraph and decide.
        </p>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-4 py-3" tabindex="0" aria-label="Chapter text">
      <div
        v-for="(p, i) in parts"
        :key="i"
        class="font-serif text-[14px] leading-relaxed text-zinc-800 dark:text-zinc-200"
        :class="[
          i > 0 && 'mt-4',
          p.notice && 'rounded-md border-l-2 border-amber-400 bg-amber-400/10 px-3 py-2',
        ]"
      >
        <div v-if="p.notice" class="label mb-1 text-amber-700 dark:text-amber-300">
          {{ note?.kind === "mixed" ? "Author note" : "Notice" }}
        </div>
        <!-- The import stores a chapter as Markdown, so the review shows what the file laid out:
             headings, emphasis, and the table a character list or a timetable was built in. The
             seeded demo's prose has no Markdown in it and parses to itself. -->
        <MarkdownText :text="p.text" />
      </div>
    </div>

    <div
      class="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-200 px-4 py-2.5 text-xs dark:border-zinc-800"
    >
      <template v-if="chapter.excluded">
        <button class="btn-ghost btn-xs" @click="emit('include')">
          <RestoreIcon class="icon-sm" /> Include again
        </button>
        <span class="text-zinc-500"
          >Skipped for the audiobook. Still in the book; nothing deleted.</span
        >
      </template>
      <template v-else>
        <button v-if="note && !chapter.kept" class="btn-primary btn-xs" @click="emit('keep')">
          <KeepIcon class="icon-sm" /> Keep chapter
        </button>
        <button class="btn-ghost btn-xs" @click="emit('skip')">
          <SkipIcon class="icon-sm" /> Skip for audiobook
        </button>
        <span v-if="!note" class="text-zinc-500">Included.</span>
        <span v-else-if="chapter.kept" class="text-zinc-500">Kept: goes in as it is.</span>
      </template>
      <button
        v-if="undecidedLeft"
        class="btn-ghost btn-xs ml-auto"
        title="Open the next chapter that still needs a decision (n)"
        @click="emit('nextUndecided')"
      >
        Next to decide <span class="text-zinc-400">{{ undecidedLeft }}</span>
      </button>
    </div>
  </div>
</template>
