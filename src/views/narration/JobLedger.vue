<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// Job ledger: one compact row per segment, filterable. The row carries the line itself; speaker, voice
// and endpoint share one column, and render latency lives in the details panel — click a row (or press
// `i`) for its audit trail. The row actions are one icon size in fixed slots: play stays visible, the
// rest appear on hover or keyboard focus (and always on touch, which has no hover), so a raised flag is
// the only standing mark on a row.
// The table, the filters and the flag popover are this file's subject; the three things a row can
// *open* are their own components, because none of them is about the list: `RenderDetails` is one
// clip's audit trail (i), `TakeCompare` is two takes of one line waiting for a verdict, and
// `ChapterTransport` is the stitched chapter at the bottom. The current row is highlighted and kept
// in view whichever of them is driving the player. Stale rows (edited after narration) can be
// re-rendered on their own.
// A clip can come back fine and still sound wrong, so any rendered row can be flagged (wrong
// pronunciation / bad delivery / awkward pause) and retaken: the old clip is kept, the new one is
// rendered beside it, and nothing is decided until the listener plays both and keeps one. The
// verdict is taken here rather than in the comparison panel, because it moves to the next retake in
// the book — which can be in another chapter.
// Keyboard: j/k move, ↵/p play, r retry, t retake, a keep new, x keep previous, i details, e edit the line.
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useJob, STATUS_BG, fmt } from "@/views/narration/shared";
import { FLAG_LABEL } from "@/lib/scriptReview";
import { queryIdSet } from "@/lib/query";
import { defaultPause, secs, silenceOf } from "@/lib/speech";
import { usePlayer } from "@/composables/usePlayer";
import { segmentStart } from "@/composables/useChapterQueue";
import ChapterTransport from "@/views/narration/ChapterTransport.vue";
import ExpressionText from "@/components/ExpressionText.vue";
import RenderDetails, { hasDetails } from "@/views/narration/RenderDetails.vue";
import TakeCompare from "@/views/narration/TakeCompare.vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { UiToggleGroup } from "@/ui";
import {
  BookA as DictionaryIcon,
  Flag as FlagIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  SkipForward as PlayFromIcon,
  RotateCcw as RetryIcon,
} from "@lucide/vue";
import type { FlagKind, Segment, SegmentAudio } from "@/types";

const props = defineProps<{ bookId: string; chapterId: number }>();
/** a word the listener wants respelled, handed up to the pronunciation dictionary */
const emit = defineEmits<{ pronounce: [word: string] }>();
const { segments, colorOf, voiceOf, epName, stats } = useJob(props);
const castStore = useCastStore();
const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const route = useRoute();
const router = useRouter();
const chapter = computed(() => libraryStore.chapter(props.bookId, props.chapterId)!);
const { p, play } = usePlayer();
const FILTERS = ["all", "done", "generating", "queued", "failed", "stale", "flagged", "review"];
const filter = ref(
  FILTERS.includes(String(route.query.filter)) ? String(route.query.filter) : "all",
);
watch(
  () => route.query.filter,
  (value) => {
    const next = String(value ?? "all");
    filter.value = FILTERS.includes(next) ? next : "all";
  },
);
const expanded = ref(queryIdSet(route.query.seg));
function rememberExpanded() {
  const seg = [...expanded.value].sort((a, b) => a - b).join(",");
  void router.replace({ query: { ...route.query, seg: seg || undefined } });
}
const toggleDetails = (id: number) => {
  const n = new Set(expanded.value);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  expanded.value = n;
  rememberExpanded();
};
watch(
  () => route.query.seg,
  async (value) => {
    const next = queryIdSet(value);
    expanded.value = next;
    const id = [...next][0];
    if (id) {
      await nextTick();
      document.getElementById(`row-${id}`)?.scrollIntoView({ block: "center" });
    }
  },
  { immediate: true },
);
const FILTER_LABEL: Record<string, string> = { done: "current audio", generating: "running" };
const matches = (s: Segment, f: string) =>
  f === "all"
    ? true
    : f === "flagged"
      ? !!s.flag
      : f === "review"
        ? !!s.candidate
        : s.audio.status === f || s.candidate?.status === f;
const rows = computed(() => segments.value.filter((s) => matches(s, filter.value)));
const count = (f: string) =>
  f === "all" ? stats.value.total : segments.value.filter((s) => matches(s, f)).length;
// "Re-narrate changed (N)" queues `renarrateStale`, which renders `changedSegments` — so N is that
// list and not a second count of it. The difference is real: a never-rendered line only counts once
// the chapter has been narrated at all, and counting them in a chapter nobody has started offered a
// button that queued nothing.
const changedLines = computed(() => narrationStore.changedSegments(props.bookId, props.chapterId));
const changed = computed(() => changedLines.value.length);
const unrendered = computed(
  () => changedLines.value.filter((s) => s.audio.status === "none").length,
);

const pacing = computed(() => castStore.pacingOf(props.bookId));
// The chapter's own length, kept by `cast._retime` on every write path and rendered by the picker
// beside this. Two figures for one chapter is how the picker and the ledger start disagreeing.
const total = computed(() => chapter.value.duration);
// rounded: the header says how much of the chapter is silence, not to the millisecond
const silence = computed(() => Math.round(silenceOf(segments.value, pacing.value) * 10) / 10);
/** the gap this book would use after a line, when the line has no pause of its own */
const nextOf = computed(() => {
  const at = new Map<number, Segment | undefined>();
  segments.value.forEach((s, i) => at.set(s.id, segments.value[i + 1]));
  return at;
});
const bookGap = (s: Segment) => defaultPause(s, nextOf.value.get(s.id), pacing.value);
/** the clip under the playhead is this one — true whether it is playing alone or inside the chapter */
const onClip = (id: string) => p.clipId === id && p.playing;

const transport = ref<InstanceType<typeof ChapterTransport> | null>(null);
const currentId = computed(() => (p.clipId?.startsWith("seg") ? Number(p.clipId.slice(3)) : null));
watch(currentId, (id) => {
  if (id && p.playing)
    document.getElementById("row-" + id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
});
/** play the stitched chapter from this line — the transport owns the one queue this chapter has */
function playFrom(s: Segment) {
  const at = segmentStart(props.bookId, props.chapterId, s.id);
  if (at != null) transport.value?.playChapter(at);
}

// what differs between the clip and the script now (the reason a row is stale, made explicit)
const drift = (s: Segment, a?: SegmentAudio) => narrationStore.clipDrift(props.bookId, s, a);
/** The line itself, in the reader — where a wrong speaker, direction or word is fixed before a
 *  retake would read the same request again. The same deep link Search uses. */
const lineLink = (s: Segment) => ({
  path: `/book/${props.bookId}/scripting`,
  query: { ch: String(props.chapterId), seg: String(s.id) },
});
// ---- flags and retakes
const KINDS: FlagKind[] = ["pronunciation", "delivery", "pause", "other"];
const KIND_SHORT: Record<FlagKind, string> = {
  pronunciation: "pronunciation",
  delivery: "delivery",
  pause: "pause",
  other: "other",
};
const flagOpen = ref<number | null>(null);
const kind = ref<FlagKind>("delivery");
const note = ref("");
const word = ref("");
/** the word a TTS engine most likely tripped on: a capitalised one that doesn't open the line */
function candidate(s: Segment): string {
  const words = s.text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  return (
    words.slice(1).find((w) => /^\p{Lu}/u.test(w)) ??
    [...words].sort((a, b) => b.length - a.length)[0] ??
    ""
  );
}
function openFlag(s: Segment) {
  kind.value = s.flag?.kind ?? "delivery";
  note.value = s.flag?.note ?? "";
  word.value = candidate(s);
  flagOpen.value = s.id;
}
/** flag it, then jump to the dictionary with the word already in the box */
function toDictionary(s: Segment) {
  saveFlag(s, false);
  if (word.value.trim()) emit("pronounce", word.value.trim());
}
function saveFlag(s: Segment, alsoRetake: boolean) {
  narrationStore.flagSegment(props.bookId, props.chapterId, s.id, kind.value, note.value);
  flagOpen.value = null;
  if (alsoRetake) narrationStore.retakeSegment(props.bookId, props.chapterId, s.id);
}
function retakeAll() {
  const n = narrationStore.retakeFlagged(props.bookId, props.chapterId);
  if (n)
    uiStore.toast(`Retaking ${n} flagged segment${n === 1 ? "" : "s"}`, {
      description: "The current clips are kept — you compare and keep one per segment.",
    });
}
/** the player's name for the retake waiting beside the clip in the book — `2` plays it */
const candId = (s: Segment) => `cand${s.id}`;
const reviewable = computed(() =>
  segments.value.filter(
    (s) => s.candidate?.duration && !["queued", "generating"].includes(s.candidate.status),
  ),
);
const bookReviewable = computed(() =>
  libraryStore.chaptersOf(props.bookId).flatMap((chapter) =>
    scriptsStore
      .segmentsOf(props.bookId, chapter.id)
      .filter(
        (s) => s.candidate?.duration && !["queued", "generating"].includes(s.candidate.status),
      )
      .map((segment) => ({ chId: chapter.id, segment })),
  ),
);
const reviewPosition = (s: Segment) =>
  bookReviewable.value.findIndex((row) => row.chId === props.chapterId && row.segment.id === s.id) +
  1;
function focusReview(id: number | undefined) {
  if (!id) return;
  nextTick(() => {
    const row = document.getElementById(`row-${id}`);
    row?.focus();
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}
/** A verdict removes this comparison, so remember its neighbour before changing the store. */
async function decideTake(s: Segment, keep: "current" | "new") {
  const reviews = bookReviewable.value;
  const at = reviews.findIndex((row) => row.chId === props.chapterId && row.segment.id === s.id);
  const nextReview = reviews[at + 1] ?? reviews[at - 1];
  if (keep === "new") narrationStore.acceptTake(props.bookId, props.chapterId, s.id);
  else narrationStore.rejectTake(props.bookId, props.chapterId, s.id);
  if (!nextReview) {
    await router.replace({ query: { ...route.query, seg: undefined } });
    return;
  }
  await router.replace({
    query: {
      ...route.query,
      ch: String(nextReview.chId),
      filter: "review",
      seg: String(nextReview.segment.id),
    },
  });
  if (nextReview.chId === props.chapterId) focusReview(nextReview.segment.id);
}
function chooseFilter(next: string) {
  filter.value = next;
  void router.replace({ query: { ...route.query, filter: next === "all" ? undefined : next } });
  if (next === "review") focusReview(reviewable.value[0]?.id);
}
function onRowKey(e: KeyboardEvent, s: Segment) {
  const row = e.currentTarget as HTMLElement;
  const list = [...(row.parentElement?.querySelectorAll<HTMLElement>("tr[data-row]") ?? [])];
  const i = list.indexOf(row);
  if (e.key === "ArrowDown" || e.key === "j") {
    e.preventDefault();
    list[i + 1]?.focus();
  } else if (e.key === "ArrowUp" || e.key === "k") {
    e.preventDefault();
    list[i - 1]?.focus();
  } else if ((e.key === "Enter" || e.key === "p") && s.audio.duration) {
    e.preventDefault();
    play("seg" + s.id, s.audio.duration, s.audio.url);
  } else if (e.key === "r" && s.audio.status === "failed")
    narrationStore.retrySegment(props.bookId, props.chapterId, s.id);
  else if (e.key === "t" && s.audio.duration)
    narrationStore.retakeSegment(props.bookId, props.chapterId, s.id);
  else if (e.key === "1" && s.candidate && s.audio.duration) {
    e.preventDefault();
    play("seg" + s.id, s.audio.duration, s.audio.url);
  } else if (e.key === "2" && s.candidate?.duration) {
    e.preventDefault();
    play(candId(s), s.candidate.duration, s.candidate.url);
  } else if (e.key === "a" && s.candidate?.duration) decideTake(s, "new");
  else if (e.key === "x" && s.candidate) decideTake(s, "current");
  else if (e.key === "f" && s.audio.duration) openFlag(s);
  else if (e.key === "i" && hasDetails(s)) toggleDetails(s.id);
  else if (e.key === "e") void router.push(lineLink(s));
}
</script>

<template>
  <div class="card flex h-full min-h-0 flex-col">
    <div
      class="grid grid-cols-4 divide-x divide-zinc-200 border-b border-zinc-200 sm:grid-cols-8 dark:divide-zinc-800 dark:border-zinc-800"
    >
      <button
        v-for="f in FILTERS"
        :key="f"
        class="px-2 py-2 text-left sm:px-3"
        :class="filter === f ? 'bg-zinc-50 dark:bg-zinc-800/60' : ''"
        @click="chooseFilter(f)"
      >
        <div class="truncate text-[11px] uppercase tracking-wider text-zinc-500">
          {{ FILTER_LABEL[f] ?? f }}
        </div>
        <div
          class="text-lg font-semibold leading-tight"
          :class="{
            'text-red-500': f === 'failed' && count(f),
            'text-emerald-500': f === 'done',
            'text-violet-500': f === 'generating',
            'text-amber-500': (f === 'stale' || f === 'flagged') && count(f),
            'text-sky-500': f === 'review' && count(f),
          }"
        >
          {{ count(f) }}
        </div>
      </button>
    </div>
    <div
      v-if="filter === 'review' && count('review')"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-sky-200 bg-sky-50 px-3 py-2 text-[11px] text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200"
    >
      <b>{{ bookReviewable.length }} ready in this book</b>
      <span><kbd class="rounded border px-1">1</kbd> play A</span>
      <span><kbd class="rounded border px-1">2</kbd> play B</span>
      <span><kbd class="rounded border px-1">X</kbd> keep A</span>
      <span><kbd class="rounded border px-1">A</kbd> keep B</span>
      <span class="text-sky-700/70 dark:text-sky-300/70">A verdict moves to the next retake.</span>
    </div>
    <div
      class="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800"
    >
      <span class="text-zinc-500"
        >{{ chapter.title }} · {{ fmt(total) }}
        <span v-if="silence" :title="`silence stitched between clips (Pronunciation tab)`"
          >(incl. {{ secs(silence) }} of pauses)</span
        >
        · {{ chapter.narration }}</span
      >
      <span class="ml-auto flex gap-2">
        <button
          v-if="changed && chapter.narration !== 'running'"
          class="btn-primary btn-xs"
          :title="
            unrendered
              ? `${count('stale')} edited after narration, ${unrendered} never rendered (new halves of a split)`
              : 'lines edited after narration'
          "
          @click="narrationStore.renarrateStale(bookId, chapterId)"
        >
          <RetryIcon class="icon-sm" /> Re-narrate changed ({{ changed }})
        </button>
        <button
          v-if="count('flagged') && chapter.narration !== 'running'"
          class="btn-ghost btn-xs border-amber-400 text-amber-600"
          @click="retakeAll"
        >
          <FlagIcon class="icon-sm" /> Retake flagged ({{ count("flagged") }})
        </button>
        <button
          v-if="count('failed') && chapter.narration !== 'running'"
          class="btn-ghost btn-xs"
          title="render only the requests that failed — finished clips are not touched"
          @click="narrationStore.retryFailed(bookId, chapterId)"
        >
          Retry failed ({{ count("failed") }})
        </button>
        <button
          v-if="chapter.narration !== 'running'"
          class="btn-ghost btn-xs"
          title="render every line again — each clip in the book keeps playing until its replacement lands, and the clip it displaces joins that line’s take list"
          @click="narrationStore.runNarration(bookId, [chapterId], { scope: 'all' })"
        >
          Re-narrate all
        </button>
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full table-fixed text-sm sm:min-w-[640px]">
        <thead
          class="sticky top-0 bg-zinc-50 text-left text-[11px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-900"
        >
          <tr>
            <th class="w-9 px-2 py-1.5">#</th>
            <th class="w-5"></th>
            <th class="hidden w-36 sm:table-cell">Speaker</th>
            <th>Text</th>
            <th class="hidden w-12 text-right sm:table-cell">Audio</th>
            <th class="w-24 sm:w-28"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="s in rows" :key="s.id">
            <tr
              :id="'row-' + s.id"
              data-row
              tabindex="0"
              class="border-t border-zinc-100 outline-none focus-visible:bg-zinc-100 dark:border-zinc-800/70 dark:focus-visible:bg-zinc-800"
              :class="[
                currentId === s.id && 'bg-violet-50 dark:bg-violet-500/10',
                hasDetails(s) && 'cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                expanded.has(s.id) && 'bg-zinc-50 dark:bg-zinc-800/40',
              ]"
              :title="hasDetails(s) ? 'click for render details' : undefined"
              @click="hasDetails(s) && toggleDetails(s.id)"
              @keydown="onRowKey($event, s)"
            >
              <td class="px-2 font-mono text-[11px] text-zinc-400">{{ s.id }}</td>
              <td>
                <span
                  class="inline-block h-2 w-2 rounded-full"
                  :class="STATUS_BG[s.audio.status]"
                  :title="s.audio.status"
                ></span>
              </td>
              <td class="hidden py-1 pr-2 leading-tight sm:table-cell">
                <div class="flex items-center gap-1.5">
                  <span
                    class="h-2 w-2 shrink-0 rounded-full"
                    :style="{ background: colorOf(s.speaker) }"
                  ></span
                  ><span class="truncate">{{ s.speaker }}</span>
                </div>
                <div
                  class="truncate pl-3.5 text-[10px] text-zinc-400"
                  :title="`${voiceOf(s.speaker)} · ${epName(s.audio.endpoint)}`"
                >
                  {{ voiceOf(s.speaker) }}
                  <span class="text-zinc-300 dark:text-zinc-600"
                    >· {{ epName(s.audio.endpoint) }}</span
                  >
                </div>
              </td>
              <td
                class="truncate py-1 pr-3 leading-tight text-zinc-600 dark:text-zinc-300"
                :class="s.type === 'thought' && 'italic'"
              >
                <div
                  class="mb-0.5 flex items-center gap-1 truncate text-[10px] not-italic sm:hidden"
                >
                  <span
                    class="h-2 w-2 shrink-0 rounded-full"
                    :style="{ background: colorOf(s.speaker) }"
                  ></span>
                  <span class="truncate font-medium text-zinc-500">{{ s.speaker }}</span>
                </div>
                <div class="line-clamp-1"><ExpressionText :book-id="bookId" :segment="s" /></div>
                <div class="flex items-center gap-1.5 truncate text-[10px]">
                  <span v-if="s.direction" class="text-violet-500">[{{ s.direction }}]</span
                  ><span v-if="s.audio.status === 'stale'" class="text-amber-600">{{
                    drift(s)[0] ?? "edited after narration — audio is from the old script"
                  }}</span
                  ><span
                    v-if="s.flag"
                    class="rounded bg-amber-400/20 px-1 font-semibold text-amber-700 dark:text-amber-300"
                    ><FlagIcon class="icon-sm" /> {{ FLAG_LABEL[s.flag.kind]
                    }}<span v-if="s.flag.note" class="font-normal"> — {{ s.flag.note }}</span></span
                  ><span v-if="s.fallback" class="text-amber-600">unverified chunk</span
                  ><span v-if="s.audio.error" class="truncate text-red-500"
                    >{{ s.audio.error.code ? "HTTP " + s.audio.error.code + " · " : ""
                    }}{{ s.audio.error.message
                    }}<span v-if="s.audio.error.part">
                      (part {{ s.audio.error.part }}/{{ s.audio.parts }})</span
                    ></span
                  ><span
                    v-if="(s.audio.parts ?? 0) > 1"
                    class="shrink-0 text-zinc-400"
                    :title="`${s.text.length} characters, over this endpoint's per-request limit`"
                    >{{ s.audio.parts }} parts</span
                  ><span v-if="(s.audio.n ?? 1) > 1" class="shrink-0 text-zinc-400"
                    >take {{ s.audio.n }}/{{ (s.audio.takes?.length ?? 0) + 1 }}</span
                  ><span
                    v-if="s.candidate"
                    class="shrink-0 font-semibold text-sky-600 dark:text-sky-400"
                    :title="`take ${s.candidate.n} is ${['queued', 'generating'].includes(s.candidate.status) ? 'rendering' : s.candidate.status === 'failed' ? 'failed' : 'waiting for your verdict'} — the book still uses take ${s.audio.n ?? 1}`"
                    >{{
                      ["queued", "generating"].includes(s.candidate.status)
                        ? `take ${s.candidate.n} rendering…`
                        : s.candidate.status === "failed"
                          ? `take ${s.candidate.n} failed`
                          : `take ${s.candidate.n} waiting`
                    }}</span
                  ><span
                    v-if="s.pause != null"
                    class="shrink-0 text-zinc-400"
                    :title="`this line holds its own pause, instead of the book's ${secs(bookGap(s))}`"
                    ><PauseIcon class="icon-sm" />
                    {{ s.pause === 0 ? "runs on" : secs(s.pause) }}</span
                  >
                </div>
              </td>
              <td
                class="hidden text-right font-mono text-xs text-zinc-500 sm:table-cell"
                :title="s.audio.ms ? `rendered in ${(s.audio.ms / 1000).toFixed(1)}s` : ''"
              >
                {{ s.audio.duration ? s.audio.duration.toFixed(1) + "s" : "" }}
              </td>
              <td class="pr-1 sm:pr-2">
                <!-- fixed slots, so the primary action never moves between rows -->
                <div class="flex items-center justify-end gap-0.5" @click.stop>
                  <span class="grid w-5 place-items-center">
                    <button
                      v-if="s.audio.duration"
                      class="icon-btn icon-btn-play"
                      title="play this segment (↵)"
                      @click="play('seg' + s.id, s.audio.duration, s.audio.url)"
                    >
                      <component
                        :is="onClip('seg' + s.id) ? PauseIcon : PlayIcon"
                        class="icon-sm icon-fill"
                      />
                    </button>
                    <button
                      v-else-if="s.audio.status === 'failed'"
                      class="icon-btn border-red-400 text-red-500 hover:border-red-500 hover:text-red-600"
                      title="retry this segment (r)"
                      @click="narrationStore.retrySegment(bookId, chapterId, s.id)"
                    >
                      <RetryIcon class="icon-sm" />
                    </button>
                    <span
                      v-else-if="s.audio.status === 'generating'"
                      class="text-[11px] text-violet-500"
                      >…</span
                    >
                  </span>
                  <span class="grid w-5 place-items-center">
                    <button
                      v-if="s.audio.duration"
                      class="icon-btn row-tool"
                      title="play the chapter from here"
                      @click="playFrom(s)"
                    >
                      <PlayFromIcon class="icon-sm icon-fill" />
                    </button>
                  </span>
                  <span class="grid w-5 place-items-center">
                    <button
                      v-if="s.audio.duration && chapter.narration !== 'running'"
                      class="icon-btn row-tool"
                      title="retake — render it again and compare (t)"
                      @click="narrationStore.retakeSegment(bookId, chapterId, s.id)"
                    >
                      <RetryIcon class="icon-sm" />
                    </button>
                  </span>
                  <span class="grid w-5 place-items-center">
                    <PopoverRoot
                      v-if="s.audio.duration"
                      :open="flagOpen === s.id"
                      @update:open="(v: boolean) => (flagOpen = v ? s.id : null)"
                    >
                      <PopoverTrigger
                        class="icon-btn"
                        :class="
                          s.flag
                            ? 'icon-btn-flag'
                            : 'row-tool hover:!border-amber-400 hover:!text-amber-600'
                        "
                        :title="
                          s.flag
                            ? `flagged: ${FLAG_LABEL[s.flag.kind]}${s.flag.note ? ' — ' + s.flag.note : ''}`
                            : 'flag what is wrong with this clip (f)'
                        "
                        @click="openFlag(s)"
                        ><FlagIcon class="icon-sm"
                      /></PopoverTrigger>
                      <PopoverPortal>
                        <PopoverContent
                          :side-offset="6"
                          align="end"
                          class="ui-popup w-80 p-3 text-xs"
                        >
                          <div class="label mb-2">What is wrong with #{{ s.id }}?</div>
                          <UiToggleGroup
                            :model-value="kind"
                            block
                            :options="KINDS.map((k) => ({ value: k, label: KIND_SHORT[k] }))"
                            @update:model-value="
                              (v: string | number | null) => (kind = v as FlagKind)
                            "
                          />
                          <input
                            v-model="note"
                            class="input mt-2 w-full py-1"
                            placeholder="e.g. “Kael” is read as two words"
                            @keydown.enter="saveFlag(s, false)"
                          />
                          <div
                            v-if="kind === 'pronunciation'"
                            class="mt-2 rounded bg-violet-500/5 p-2"
                          >
                            <div class="mb-1.5 text-[11px] text-zinc-500">
                              A retake reads the same spelling. Teach the book instead — the prose
                              keeps the author’s spelling, the endpoint gets yours.
                            </div>
                            <div class="flex items-center gap-1.5">
                              <input
                                v-model="word"
                                class="input min-w-0 flex-1 py-1"
                                placeholder="the word"
                                aria-label="Word to add to the dictionary"
                              />
                              <button
                                class="btn-ghost btn-xs shrink-0"
                                :disabled="!word.trim()"
                                @click="toDictionary(s)"
                              >
                                <DictionaryIcon class="icon-sm" /> Add to dictionary
                              </button>
                            </div>
                          </div>
                          <p v-else class="mt-2 text-[11px] leading-relaxed text-zinc-500">
                            A retake keeps this clip: you play both and decide. If the request was
                            wrong rather than the render, change the voice, direction or the line
                            itself first —
                            <RouterLink
                              :to="lineLink(s)"
                              class="text-violet-600 underline hover:text-violet-500 dark:text-violet-400"
                              >edit the line in the reader</RouterLink
                            >.
                          </p>
                          <div class="mt-3 flex items-center gap-2">
                            <button
                              v-if="s.flag"
                              class="btn-ghost btn-xs mr-auto"
                              @click="
                                ((flagOpen = null),
                                narrationStore.clearFlag(bookId, chapterId, s.id))
                              "
                            >
                              Clear flag
                            </button>
                            <button class="btn-ghost btn-xs ml-auto" @click="saveFlag(s, false)">
                              Flag only
                            </button>
                            <button class="btn-primary btn-xs" @click="saveFlag(s, true)">
                              Flag &amp; retake
                            </button>
                          </div>
                        </PopoverContent>
                      </PopoverPortal>
                    </PopoverRoot>
                  </span>
                </div>
              </td>
            </tr>
            <TakeCompare
              v-if="s.candidate"
              :segment="s"
              :position="reviewPosition(s)"
              :total="bookReviewable.length"
              @decide="(keep) => decideTake(s, keep)"
            />
            <RenderDetails
              v-if="expanded.has(s.id)"
              :book-id="bookId"
              :chapter-id="chapterId"
              :segment="s"
              @retry="narrationStore.retrySegment(bookId, chapterId, s.id)"
            />
          </template>
        </tbody>
      </table>
      <div v-if="!rows.length" class="p-8 text-center text-sm text-zinc-500">
        No {{ filter }} segments.
      </div>
    </div>

    <ChapterTransport ref="transport" :book-id="bookId" :chapter-id="chapterId" />
  </div>
</template>
