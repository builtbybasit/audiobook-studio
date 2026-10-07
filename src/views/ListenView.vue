<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";

// Listen: a chapter read along with its audio. The line under the playhead is lit, and on a line a
// check by ear has heard, so is the word being said — from the times the transcriber put on its
// words, never from an estimate. Only the chapter's own spoken text is on the page: no cast notes,
// nothing from later chapters.
//
// It plays the same chapter queue the reader and the ledger do (`useChapterQueue`), so a chapter
// started on one of those keeps playing here, and the mini player takes you back to this page.
// The page's own player is the slim bar at the foot (`ListenBar`): the transport, the position in
// the chapter, and what a listener does while hearing a line — flag it, repeat it, stop at the
// chapter's end. The keys are the ledger's: j/k lines, , and . ten seconds, f flag, r repeat, and
// [ ] the flagged lines.
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
import { chapterQueue, chapterQueueId, segmentStart } from "@/composables/useChapterQueue";
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
// The word marks. Until the server answers — or when it cannot, or the chapter was never checked —
// there are none, and every line lights up whole: no error is worth showing for that.
const { lines: heard } = useChapterHeard(bookId, opened);

const book = computed(() => libraryStore.bookById(bookId));
const chapters = computed(() => libraryStore.chaptersOf(bookId));
const chapter = computed(() => libraryStore.chapter(bookId, opened.value));
// chapters by their reading number — their place among the kept ones — never by id
const numbers = computed(() => libraryStore.chapterNumbers[bookId]);
const chapterOptions = computed(() =>
  chapters.value.map((c) => ({
    value: c.id,
    label: `${numberCell(numbers.value?.get(c.id))} · ${c.title}`,
    hint: isNarrated(c) ? fmt(c.duration) : "no audio",
  })),
);
/** this chapter's reading number, and how many chapters the audiobook keeps */
const place = computed(() => numbers.value?.get(opened.value));
const kept = computed(() => numbers.value?.size ?? 0);
/** the narrated chapter before or after this one, to step to */
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

/** what is read aloud; site text is not, and is not shown */
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
/** the chapter's length as the bar draws it: the clips and the silence between them */
const total = computed(() => {
  const last = chapterTimeline(segments.value, castStore.pacingOf(bookId), book.value).at(-1);
  return last ? last.end + last.gap : 0;
});

// ---- the player ----
const { p, playQueue, seekTo, skip, next, prev, repeatClip, layout, now } = usePlayer();
const queueId = computed(() => chapterQueueId(bookId, opened.value));
const isThis = computed(() => p.id === queueId.value);
/** the line under the playhead, while this chapter is the one loaded */
const current = computed(() =>
  isThis.value && p.clipId?.startsWith("seg") ? Number(p.clipId.slice(3)) : null,
);
/** the line the bar and the keys act on: the one playing, else the first with a clip */
const focus = computed(
  () => rows.value.find((s) => s.id === current.value) ?? rows.value.find((s) => s.audio.duration),
);
const buildQueue = () =>
  chapterQueue(bookId, opened.value, {
    href: (id) => `/book/${bookId}/listen?ch=${id}`,
    // the page follows playback into the next chapter, as the ledger does
    onChapter: (id) => void router.replace({ query: { ...route.query, ch: String(id) } }),
  });
/** Press play: toggle this chapter, or start it — from `at` seconds in, when given. */
function playChapter(at?: number) {
  if (at != null && isThis.value) return seekTo(at);
  const q = buildQueue();
  if (q) playQueue(q, at);
}
/** Listen from `offset` seconds into a line: moved to while this chapter plays, else started there. */
function listenFrom(s: Segment, offset: number) {
  const at = segmentStart(bookId, opened.value, s.id);
  if (at == null) return;
  held = { id: s.id, at: offset, until: performance.now() + HOLD_MS };
  if (isThis.value && p.playing) return seekTo(at + offset);
  const q = buildQueue();
  if (q) playQueue(q, at + offset);
}

// ---- the word being said ----
// One index, set from an animation frame while a line with marks plays: the tick moves the
// playhead ten times a second, and a word is often shorter than that. It only changes when the word
// does, so a frame that lands on the same word renders nothing.
const word = ref(-1);
let lineMarks: WordMark[] | null = null;
let lineStart = 0;
// A click puts the playhead on the word's start, but until its clip has loaded and plays, the
// element can sit a hair short of it — on the word before, for as long as the load takes. So the
// spot clicked holds until the playhead reaches it, the line changes, or `HOLD_MS` goes by.
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
/** the frame loop runs only while it has something to follow, and someone to show it to */
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

// ---- reading along ----
// The page keeps the line being read in view, but only while it plays and only when the line
// changes, so scrolling back to re-read something is never fought over: a scroll while it plays
// turns following off, and the bar's button (or a click on a line) turns it on again.
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
// …and arriving on a chapter that is already playing finds its place once the script is in
watch(loaded, (v) => v && p.playing && scrollTo(current.value), { flush: "post", immediate: true });

// ---- flags, and the keys ----
/** the line whose flag popover is open beside it; the bar's, for the line playing, is its own */
const flagOpen = ref<number | null>(null);
const barFlag = ref(false);
/** a word for the pronunciation dictionary goes to the Narration page, which has the panel */
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
          title="previous narrated chapter"
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
          title="next narrated chapter"
          @click="after && open(after.id)"
        >
          <ChevronRight class="icon-sm" />
        </button>
        <span v-if="place" class="text-xs text-zinc-500">ch {{ place }} of {{ kept }}</span>
        <span class="ml-auto flex items-center gap-2">
          <UiHint
            label="the highlighting"
            text="The line being read is lit. On a line a check by ear has heard, so is each word as it is said; a line not checked, or edited since, lights up whole. A click on a line or a word listens from there; ⚑ beside a line, or f, flags what is wrong with its clip."
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
