<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";

// Listen: a chapter read along with its audio. The line under the playhead is lit, and on a line
// a transcription heard, the word too, from the transcriber's times, never an estimate. It plays the
// shared chapter queue (`useChapterQueue`); the player is `ListenBar`, with the ledger's keys.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useDocumentVisibility } from "@vueuse/core";
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import ReaderSettings from "@/components/ReaderSettings.vue";
import ListenBar from "@/views/listen/ListenBar.vue";
import ListenLine from "@/views/listen/ListenLine.vue";
import FlagPopover from "@/views/narration/FlagPopover.vue";
import { UiCombobox, UiHint } from "@/ui";
import { useBookId } from "@/composables/useBookId";
import { useOpenedChapter } from "@/composables/useOpenedChapter";
import { usePlayer } from "@/composables/usePlayer";
import {
  chapterQueue,
  chapterQueueId,
  lineUnder,
  segmentStart,
} from "@/composables/useChapterQueue";
import { useCast, useChapterScript } from "@/queries";
import { useChapterHeard } from "@/queries/chapterHeard";
import { useReader } from "@/stores/reader";
import { numberCell } from "@/lib/chapterNumber";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { heardLines, isSpoken } from "@/lib/siteText";
import { chapterTimeline } from "@/lib/speech";
import { markAt, marksFor, type WordMark } from "@/lib/listen";
import { fmt } from "@/views/narration/shared";
import type { Chapter, Segment } from "@/types";

const castStore = useCastStore();
const libraryStore = useLibraryStore();
const reader = useReader();
const route = useRoute();
const router = useRouter();
const bookId = useBookId();
useCast(bookId);
const { opened, open } = useOpenedChapter(
  bookId,
  (chapters) => chapters.find(isNarrated)?.id ?? chapters.find(isScripted)?.id,
);
const { segments, loaded, status, refetch } = useChapterScript(bookId, opened);
// Word marks. None until the server answers, or ever for an unchecked chapter: lines then light up
// whole, with no error shown.
const { lines: heard } = useChapterHeard(bookId, opened);

const book = computed(() => libraryStore.bookById(bookId));
const chapters = computed(() => libraryStore.chaptersOf(bookId));
const chapter = computed(() => libraryStore.chapter(bookId, opened.value));
// by reading number, never by id
const numbers = computed(() => libraryStore.chapterNumbers[bookId]);
const chapterOptions = computed(() =>
  chapters.value.map((c) => ({
    value: c.id,
    label: `${numberCell(numbers.value?.get(c.id))} · ${c.title}`,
    hint: isNarrated(c) ? fmt(c.duration) : "no audio",
  })),
);
const place = computed(() => numbers.value?.get(opened.value));
const kept = computed(() => numbers.value?.size ?? 0);
function neighbour(d: 1 | -1): Chapter | null {
  const i = chapters.value.findIndex((c) => c.id === opened.value);
  for (let j = i + d; j >= 0 && j < chapters.value.length; j += d) {
    const c = chapters.value[j];
    if (!c.excluded && isNarrated(c)) return c;
  }
  return null;
}
const before = computed(() => neighbour(-1));
const after = computed(() => neighbour(1));

/** site text is not read aloud, so it is not shown */
const rows = computed(() => segments.value.filter((s) => isSpoken(s, book.value)));
const narrated = computed(() => heardLines(segments.value, book.value).length);
const marks = computed(() => {
  const out = new Map<number, WordMark[]>();
  for (const s of rows.value) {
    const m = marksFor(s, heard.value[s.id]);
    if (m) out.set(s.id, m);
  }
  return out;
});
const colorOf = (name: string): string =>
  castStore.charactersOf(bookId).find((c) => c.name === name)?.color ?? "#71717a";
/** the clips and the silence between them */
const total = computed(() => {
  const last = chapterTimeline(segments.value, castStore.pacingOf(bookId), book.value).at(-1);
  return last ? last.end + last.gap : 0;
});

const { p, playQueue, cue, skip, next, prev, repeatClip, layout, now } = usePlayer();
const queueId = computed(() => chapterQueueId(bookId, opened.value));
const isThis = computed(() => p.id === queueId.value);
const current = computed(() => (isThis.value ? lineUnder(p.clipId, bookId, opened.value) : null));
/** the one playing, else the first with a clip */
const focus = computed(
  () => rows.value.find((s) => s.id === current.value) ?? rows.value.find((s) => s.audio.duration),
);
const buildQueue = () =>
  chapterQueue(bookId, opened.value, {
    href: (id) => `/book/${bookId}/listen?ch=${id}`,
    onChapter: (id) => void router.replace({ query: { ...route.query, ch: String(id) } }),
  });
/** Toggle this chapter, or start it `at` seconds in; a scrub in the playing chapter only moves. */
function playChapter(at?: number) {
  const q = buildQueue();
  if (!q) return;
  if (at != null && isThis.value) cue(q, at);
  else playQueue(q, at);
}
function listenFrom(s: Segment, offset: number) {
  const at = segmentStart(bookId, opened.value, s.id);
  if (at == null) return;
  held = { id: s.id, at: offset, until: performance.now() + HOLD_MS };
  const q = buildQueue();
  if (q) playQueue(q, at + offset);
}

// Set from an animation frame: the tick moves the playhead only ten times a second, and a word is
// often shorter than that. It only changes when the word does.
const word = ref(-1);
let lineMarks: WordMark[] | null = null;
let lineStart = 0;
// Until a clicked word's clip loads and plays, the playhead can sit a hair short of it, on the
// word before. So the clicked spot holds until reached, the line changes, or `HOLD_MS` passes.
const HOLD_MS = 1500;
let held: { id: number; at: number; until: number } | null = null;
const update = () => {
  let t = now() - lineStart;
  if (held && current.value === held.id && t < held.at && performance.now() < held.until)
    t = held.at;
  else held = null;
  word.value = lineMarks ? markAt(lineMarks, t) : -1;
};
watch(
  [current, marks],
  ([id]) => {
    lineMarks = id == null ? null : (marks.value.get(id) ?? null);
    lineStart = layout().find((e) => e.clip.id === p.clipId)?.start ?? 0;
    update();
  },
  { immediate: true },
);
const visible = useDocumentVisibility();
/** runs only while there is something to follow and the page is visible */
const following = computed(
  () =>
    p.playing &&
    current.value != null &&
    marks.value.has(current.value) &&
    visible.value === "visible",
);
let raf = 0;
function frame() {
  update();
  raf = requestAnimationFrame(frame);
}
watch(
  following,
  (on) => {
    cancelAnimationFrame(raf);
    if (on) raf = requestAnimationFrame(frame);
  },
  { immediate: true },
);
// paused, a click still moves the playhead, and the word with it
watch(
  () => p.pos,
  () => {
    if (!following.value) update();
  },
);
onBeforeUnmount(() => cancelAnimationFrame(raf));

// Keep the playing line in view only when the line changes, so scrolling back is never fought
// over: a scroll while it plays turns following off; the bar's button or a line click turns it on.
const follow = ref(true);
const scrollTo = (id: number | null) =>
  id != null &&
  document.getElementById(`seg-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
function setFollow(on: boolean) {
  follow.value = on;
  if (on) scrollTo(current.value);
}
const onWheel = () => {
  if (isThis.value && p.playing) follow.value = false;
};
watch(current, (id) => p.playing && follow.value && scrollTo(id));
// arriving on a chapter already playing finds its place once the script is in
watch(loaded, (v) => v && p.playing && scrollTo(current.value), { flush: "post", immediate: true });

/** the line whose flag popover is open; the bar's is its own */
const flagOpen = ref<number | null>(null);
const barFlag = ref(false);
/** the Narration page has the dictionary panel */
const pronounce = (word: string) =>
  void router.push({
    path: `/book/${bookId}/narration`,
    query: { ch: String(opened.value), pronounce: word },
  });
/** the next flagged line after (or before) the one playing, wrapping round */
function flagged(d: 1 | -1): Segment | undefined {
  const i = rows.value.findIndex((s) => s.id === current.value);
  const n = rows.value.length;
  for (let k = 1; k <= n; k++) {
    const s = rows.value[(((i + d * k) % n) + n) % n];
    if (s.flag) return s;
  }
  return undefined;
}
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case "j":
      if (isThis.value) next();
      else playChapter();
      break;
    case "k":
      if (isThis.value) prev();
      break;
    case ",":
      if (isThis.value) skip(-10);
      break;
    case ".":
      if (isThis.value) skip(10);
      break;
    case "f":
      if (focus.value) barFlag.value = true;
      break;
    case "r":
      if (isThis.value && p.clipId) repeatClip(p.repeat ? null : p.clipId);
      break;
    case "[":
    case "]": {
      const s = flagged(e.key === "]" ? 1 : -1);
      if (s) listenFrom(s, 0);
      break;
    }
    default:
      return;
  }
  e.preventDefault();
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("wheel", onWheel, { passive: true });
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("wheel", onWheel);
});
</script>

<template>
  <div class="p-4 pb-20">
    <div class="card mx-auto max-w-5xl">
      <header
        class="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-xl border-b border-zinc-200 bg-white/95 px-4 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
      >
        <button
          class="icon-btn"
          :disabled="!before"
          aria-label="previous narrated chapter"
          data-tip="previous narrated chapter"
          @click="before && open(before.id)"
        >
          <ChevronLeft class="icon-sm" />
        </button>
        <UiCombobox
          :model-value="opened"
          :options="chapterOptions"
          placeholder="Chapter…"
          @update:model-value="(id) => id != null && open(Number(id))"
        />
        <button
          class="icon-btn"
          :disabled="!after"
          aria-label="next narrated chapter"
          data-tip="next narrated chapter"
          @click="after && open(after.id)"
        >
          <ChevronRight class="icon-sm" />
        </button>
        <span v-if="place" class="text-xs text-zinc-500">ch {{ place }} of {{ kept }}</span>
        <span class="ml-auto flex items-center gap-2">
          <UiHint
            label="the highlighting"
            text="The line being read is lit. On a transcribed line, so is each word as it is said; a line not transcribed, or edited since, lights up whole. A click on a line or a word listens from there; ⚑ beside a line, or f, flags what is wrong with its clip."
          />
          <ReaderSettings />
        </span>
      </header>

      <div class="px-4 py-6 sm:px-8">
        <div
          class="mx-auto"
          :class="[reader.widthClass, reader.fontClass]"
          :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }"
        >
          <h2 v-if="chapter" class="mb-5 font-serif text-2xl">{{ chapter.title }}</h2>
          <p
            v-if="chapter && !isScripted(chapter)"
            class="py-10 text-center font-sans text-sm text-zinc-500"
          >
            No script for this chapter yet.
          </p>
          <p
            v-else-if="status === 'error'"
            class="py-10 text-center font-sans text-sm text-zinc-500"
            role="status"
          >
            The script could not be read.
            <button class="text-violet-600 hover:underline dark:text-violet-400" @click="refetch()">
              Try again
            </button>
          </p>
          <p
            v-else-if="!loaded"
            class="py-10 text-center font-sans text-sm text-zinc-500"
            role="status"
          >
            Reading the script…
          </p>
          <p v-else-if="!narrated" class="py-10 text-center font-sans text-sm text-zinc-500">
            No narrated lines yet.
            <RouterLink
              :to="{ path: `/book/${bookId}/narration`, query: { ch: opened } }"
              class="text-violet-600 hover:underline dark:text-violet-400"
              >Narrate this chapter</RouterLink
            >
          </p>
          <template v-else>
            <!-- a line with no clip is drawn dim: it is in the chapter, but not in the audio -->
            <div
              v-for="s in rows"
              :key="s.id"
              data-line
              class="relative"
              :class="!s.audio.duration && 'opacity-40'"
            >
              <ListenLine
                :segment="s"
                :marks="marks.get(s.id) ?? null"
                :on="current === s.id"
                :word="current === s.id ? word : -1"
                :color="colorOf(s.speaker)"
                @seek="(at) => listenFrom(s, at)"
              />
              <span
                v-if="s.audio.duration"
                class="line-tool absolute -right-9 top-1 font-sans"
                :class="(current === s.id || s.flag) && 'is-on'"
              >
                <FlagPopover
                  :book-id="bookId"
                  :chapter-id="opened"
                  :segment="s"
                  :open="flagOpen === s.id"
                  @update:open="(v) => (flagOpen = v ? s.id : null)"
                  @pronounce="pronounce"
                />
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <ListenBar
      v-if="narrated"
      :book-id="bookId"
      :chapter-id="opened"
      :segment="focus"
      :color="focus ? colorOf(focus.speaker) : 'transparent'"
      :total="total"
      :is-this="isThis"
      :follow="follow"
      v-model:flag-open="barFlag"
      @play="playChapter()"
      @seek="(at) => playChapter(at)"
      @follow="setFollow"
      @pronounce="pronounce"
    />
  </div>
</template>
