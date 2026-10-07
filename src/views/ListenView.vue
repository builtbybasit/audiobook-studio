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
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useDocumentVisibility } from "@vueuse/core";
import { Pause as PauseIcon, Play as PlayIcon } from "@lucide/vue";
import ReaderSettings from "@/components/ReaderSettings.vue";
import ListenLine from "@/views/listen/ListenLine.vue";
import { UiCombobox, UiHint } from "@/ui";
import { useBookId } from "@/composables/useBookId";
import { useOpenedChapter } from "@/composables/useOpenedChapter";
import { usePlayer } from "@/composables/usePlayer";
import { chapterQueue, chapterQueueId, segmentStart } from "@/composables/useChapterQueue";
import { useCast, useChapterScript } from "@/queries";
import { useChapterHeard } from "@/queries/chapterHeard";
import { useReader } from "@/stores/reader";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { heardLines, isSpoken } from "@/lib/siteText";
import { markAt, marksFor, type WordMark } from "@/lib/listen";
import { chapterTimeline } from "@/lib/speech";
import type { Segment } from "@/types";
// PROTOTYPE — throwaway: three redesigns of this page behind `?variant=`, on this route, with the
// data and the player wiring above shared. `0` is the page as it is. See prototype/ctx.ts.
import PrototypeSwitcher from "@/components/PrototypeSwitcher.vue";
import VariantA from "@/views/listen/prototype/VariantA.vue";
import VariantB from "@/views/listen/prototype/VariantB.vue";
import VariantC from "@/views/listen/prototype/VariantC.vue";
import VariantD from "@/views/listen/prototype/VariantD.vue";
import VariantE from "@/views/listen/prototype/VariantE.vue";
import VariantF from "@/views/listen/prototype/VariantF.vue";
import VariantG from "@/views/listen/prototype/VariantG.vue";
import VariantH from "@/views/listen/prototype/VariantH.vue";
import VariantI from "@/views/listen/prototype/VariantI.vue";
import { protoLoop, protoStopAtEnd, type ListenCtx } from "@/views/listen/prototype/ctx";

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
const chapter = computed(() => libraryStore.chapter(bookId, opened.value));
const chapterOptions = computed(() =>
  libraryStore.chaptersOf(bookId).map((c) => ({
    value: c.id,
    label: `${String(c.id).padStart(2, "0")} · ${c.title}`,
    hint: isNarrated(c) ? "" : "no audio",
  })),
);
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

// ---- the player ----
const { p, playQueue, seekTo, layout, now, skip, next, prev, cycleRate, setRate } = usePlayer();
const queueId = computed(() => chapterQueueId(bookId, opened.value));
const isThis = computed(() => p.id === queueId.value);
/** the line under the playhead, while this chapter is the one loaded */
const current = computed(() =>
  isThis.value && p.clipId?.startsWith("seg") ? Number(p.clipId.slice(3)) : null,
);
const buildQueue = () => {
  const q = chapterQueue(bookId, opened.value, {
    href: (id) => `/book/${bookId}/listen?ch=${id}`,
    // the page follows playback into the next chapter, as the ledger does
    onChapter: (id) => void router.replace({ query: { ...route.query, ch: String(id) } }),
  });
  // PROTOTYPE stub: a switch that stops at the chapter's end rather than running on
  if (q) {
    const on = q.next;
    q.next = () => (protoStopAtEnd.value ? null : (on?.() ?? null));
  }
  return q;
};
function playChapter(at?: number) {
  const q = buildQueue();
  if (!q) return;
  if (at != null && isThis.value) return seekTo(at);
  playQueue(q, at);
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

// Reading along: the page keeps the line being read in view, but only while it plays and only when
// the line changes, so scrolling back to re-read something is never fought over.
const scrollTo = (id: number | null) =>
  id != null &&
  document.getElementById(`seg-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
// PROTOTYPE: a scroll away from the line turns following off; the variants' "back to the line"
// turns it on again
const follow = ref(true);
const onWheel = () => {
  if (isThis.value && p.playing) follow.value = false;
};
window.addEventListener("wheel", onWheel, { passive: true });
onBeforeUnmount(() => window.removeEventListener("wheel", onWheel));
watch(current, (id) => p.playing && follow.value && scrollTo(id));
// …and arriving on a chapter that is already playing finds its place once the script is in
watch(loaded, (v) => v && p.playing && scrollTo(current.value), { flush: "post", immediate: true });

// ---- PROTOTYPE: the variants ----
const VARIANTS = [
  { key: "0", name: "Today" },
  { key: "A", name: "Dock: column + pinned transport" },
  { key: "B", name: "Stage: one line, no scrolling" },
  { key: "C", name: "Desk: column + chapter rail" },
  { key: "D", name: "Deck: A with a three-row player" },
  { key: "E", name: "Capsule: A with a floating player" },
  { key: "F", name: "Headbar: A with the player on top" },
  { key: "G", name: "Pill: E slimmer, grows upward" },
  { key: "H", name: "Orb: E as a corner button" },
  { key: "I", name: "Strip: E across the window's foot" },
];
// PROTOTYPE stub: repeat one line — when the playhead leaves the repeated line, it goes back to
// its start. Off when the chapter changes.
watch(current, (id, was) => {
  const loop = protoLoop.value;
  if (loop == null || id === loop || was !== loop) return;
  const at = segmentStart(bookId, opened.value, loop);
  if (at != null) seekTo(at);
});
watch(opened, () => (protoLoop.value = null));
const variant = computed(() => String(route.query.variant ?? "0"));
const timeline = computed(() =>
  chapterTimeline(segments.value, castStore.pacingOf(bookId), book.value),
);
const total = computed(() => {
  const last = timeline.value.at(-1);
  return last ? last.end + last.gap : 0;
});
const ctx = computed((): ListenCtx => ({
  bookId,
  book: book.value,
  chapter: chapter.value,
  chapters: libraryStore.chaptersOf(bookId),
  opened: opened.value,
  open,
  rows: rows.value,
  marks: marks.value,
  heard: heard.value,
  current: current.value,
  word: word.value,
  colorOf,
  loaded: loaded.value,
  status: status.value,
  narrated: narrated.value,
  refetch: () => void refetch(),
  timeline: timeline.value,
  total: total.value,
  isThis: isThis.value,
  p,
  playChapter,
  listenFrom,
  seekTo,
  skip,
  next,
  prev,
  cycleRate,
  setRate,
  follow: follow.value,
  setFollow: (v) => (follow.value = v),
}));
</script>

<template>
  <VariantA v-if="variant === 'A'" :ctx="ctx" />
  <VariantB v-else-if="variant === 'B'" :ctx="ctx" />
  <VariantC v-else-if="variant === 'C'" :ctx="ctx" />
  <VariantD v-else-if="variant === 'D'" :ctx="ctx" />
  <VariantE v-else-if="variant === 'E'" :ctx="ctx" />
  <VariantF v-else-if="variant === 'F'" :ctx="ctx" />
  <VariantG v-else-if="variant === 'G'" :ctx="ctx" />
  <VariantH v-else-if="variant === 'H'" :ctx="ctx" />
  <VariantI v-else-if="variant === 'I'" :ctx="ctx" />
  <div v-else class="p-4">
    <div class="card mx-auto max-w-5xl">
      <header
        class="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-xl border-b border-zinc-200 bg-white/95 px-4 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95"
      >
        <button
          class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40"
          :disabled="!narrated"
          :aria-label="isThis && p.playing ? 'Pause' : 'Play this chapter'"
          :title="isThis && p.playing ? 'pause (space)' : 'play this chapter'"
          @click="playChapter()"
        >
          <component :is="isThis && p.playing ? PauseIcon : PlayIcon" class="icon icon-fill" />
        </button>
        <UiCombobox
          :model-value="opened"
          :options="chapterOptions"
          placeholder="Chapter…"
          @update:model-value="(id) => id != null && open(Number(id))"
        />
        <span class="ml-auto flex items-center gap-2">
          <UiHint
            label="the highlighting"
            text="The line being read is lit. On a line a check by ear has heard, so is each word as it is said; a line not checked, or edited since, lights up whole."
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
            <ListenLine
              v-for="s in rows"
              :key="s.id"
              :segment="s"
              :marks="marks.get(s.id) ?? null"
              :on="current === s.id"
              :word="current === s.id ? word : -1"
              :color="colorOf(s.speaker)"
              @seek="(at) => listenFrom(s, at)"
            />
          </template>
        </div>
      </div>
    </div>
  </div>
  <PrototypeSwitcher :variants="VARIANTS" :current="variant" />
</template>
