<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// Job ledger: one compact row per segment, filterable. The row carries the line itself; speaker, voice
// and endpoint share one column, and render latency lives in the details panel — click a row (or press
// `i`) for its audit trail. The row actions are one icon size in fixed slots: play stays visible, the
// rest appear on hover or keyboard focus (and always on touch, which has no hover), so a raised flag is
// the only standing mark on a row.
// Sticky player at the bottom plays the stitched chapter:
// a scrubber drawn from segment boundaries (colour = speaker), the current row highlighted and kept in
// view. Stale rows (edited after narration) can be re-rendered on their own. Each rendered row expands
// (i) to its audit trail — voice, model, direction and style it was rendered with, cost, cuts — and, for
// failures, the HTTP status + body with a "copy request" for debugging.
// A clip can come back fine and still sound wrong, so any rendered row can be flagged (wrong
// pronunciation / bad delivery / awkward pause) and retaken: the old clip is kept, the new one is
// rendered beside it, and nothing is decided until the listener plays both and keeps one.
// Keyboard: j/k move, ↵/p play, r retry, t retake, a keep new, x keep previous, i details.
import { computed, defineAsyncComponent, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useJob, STATUS_BG, fmt } from "@/views/narration/shared";
import { FLAG_LABEL } from "@/lib/scriptReview";
import { queryIdSet } from "@/lib/query";
import { pauseAfter, secs } from "@/lib/speech";
import { usePlayer, type Queue } from "@/composables/usePlayer";
import { speechPeaks } from "@/lib/peaks";
import ExpressionEditor from "@/components/ExpressionEditor.vue";
import ExpressionText from "@/components/ExpressionText.vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { UiToggleGroup } from "@/ui";
import {
  BookA as DictionaryIcon,
  Flag as FlagIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  SkipForward as PlayFromIcon,
  ChevronFirst as PrevIcon,
  ChevronLast as NextIcon,
  Rewind as BackIcon,
  FastForward as FwdIcon,
  RotateCcw as RetryIcon,
  Scissors as CutIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import type { FlagKind, Segment, SegmentAudio, Take } from "@/types";

const props = defineProps<{ bookId: string; chapterId: number }>();
/** a word the listener wants respelled, handed up to the pronunciation dictionary */
const emit = defineEmits<{ pronounce: [word: string] }>();
const { segments, colorOf, voiceOf, epName, stats } = useJob(props);
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const route = useRoute();
const router = useRouter();
const chapter = computed(() => libraryStore.chapter(props.bookId, props.chapterId)!);
const { p, play, playQueue, cue, seekTo, skip, next, prev, cycleRate, clipProgress } = usePlayer();
// wavesurfer is only ever needed once a compare panel is open, so it stays out of the entry chunk
const Waveform = defineAsyncComponent(() => import("@/components/Waveform.vue"));
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
const AT = { sentence: "sentence", clause: "clause", word: "word", char: "hard cut" };
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
// halves of a hand-split segment have no clip of their own yet; in a narrated chapter they are "changed" too
const unrendered = computed(() => segments.value.filter((s) => s.audio.status === "none").length);
const changed = computed(() => count("stale") + unrendered.value);

const pacing = computed(() => castStore.pacingOf(props.bookId));
// the stitched chapter is the clips *and* the silence between them, so the scrubber shows both
const timeline = computed(() => {
  const heard = segments.value.filter((s) => s.audio.duration > 0);
  let t = 0;
  return heard.map((s, i) => {
    const start = t;
    t += s.audio.duration;
    const end = t;
    const gap = pauseAfter(s, heard[i + 1], pacing.value);
    t += gap;
    return { s, start, end, gap };
  });
});
const total = computed(() => {
  const last = timeline.value.at(-1);
  return last ? last.end + last.gap : 0;
});
// rounded: the header says how much of the chapter is silence, not to the millisecond
const silence = computed(() => Math.round(timeline.value.reduce((a, x) => a + x.gap, 0) * 10) / 10);
/** the gap this book would use after a line, when the line has no pause of its own */
const bookGap = (s: Segment) =>
  pacing.value[
    segments.value[segments.value.indexOf(s) + 1]?.speaker === s.speaker ? "line" : "turn"
  ];
// The player is app-wide, so a queue has to name this exact chapter: pressing play on ch 7 while
// ch 6 is still going must load ch 7, not toggle the bar.
const queueId = (chId: number) => `chapter:${props.bookId}:${chId}`;
const isChapter = computed(() => p.id === queueId(props.chapterId));
/** the clip under the playhead is this one — true whether it is playing alone or inside the chapter */
const onClip = (id: string) => p.clipId === id && p.playing;

/** The chapter as the player wants it: the clips and the silence between them, in order. */
function buildQueue(chId: number): Queue | null {
  const segs = scriptsStore.segmentsOf(props.bookId, chId);
  const heard = segs.filter((s) => s.audio.duration > 0);
  if (!heard.length) return null;
  const pace = castStore.pacingOf(props.bookId);
  return {
    id: queueId(chId),
    title: libraryStore.chapter(props.bookId, chId)?.title ?? "",
    subtitle: libraryStore.bookById(props.bookId)?.title ?? "",
    href: `/book/${props.bookId}/narration?ch=${chId}`,
    clips: heard.map((s, i) => ({
      id: "seg" + s.id,
      duration: s.audio.duration,
      gap: pauseAfter(s, heard[i + 1], pace),
      url: s.audio.url,
      label: s.text,
      speaker: s.speaker,
    })),
    next: () => nextNarrated(chId),
  };
}
/** Listening through a book shouldn't stop at a chapter boundary. */
function nextNarrated(after: number): Queue | null {
  const chs = libraryStore.chaptersOf(props.bookId);
  for (const c of chs.slice(chs.findIndex((x) => x.id === after) + 1)) {
    const q = buildQueue(c.id);
    if (!q) continue;
    // the ledger follows the player: ?ch= is what NarrationView already watches, and going through
    // the router means this survives the remount that switching chapters causes
    void router.replace({ query: { ...route.query, ch: String(c.id) } });
    return q;
  }
  return null;
}
function playChapter(at?: number) {
  const q = buildQueue(props.chapterId);
  if (q) playQueue(q, at);
}

const currentId = computed(() => (p.clipId?.startsWith("seg") ? Number(p.clipId.slice(3)) : null));
watch(currentId, (id) => {
  if (id && p.playing)
    document.getElementById("row-" + id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
});
function playFrom(s: Segment) {
  const x = timeline.value.find((x) => x.s.id === s.id);
  if (x) playChapter(x.start);
}
function scrub(e: MouseEvent) {
  const at = (e.offsetX / (e.currentTarget as HTMLElement).clientWidth) * total.value;
  if (isChapter.value) return seekTo(at);
  const q = buildQueue(props.chapterId);
  if (q) cue(q, at); // park the playhead without starting — scrubbing is not pressing play
}

// what differs between the clip and the script now (the reason a row is stale, made explicit)
const drift = (s: Segment, a?: SegmentAudio) => narrationStore.clipDrift(props.bookId, s, a);
const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function requestOf(s: Segment) {
  const ep = endpointsStore.endpoints.find((e) => e.id === s.audio.endpoint);
  return JSON.stringify(
    {
      POST: (ep?.baseUrl ?? "") + "/audio/speech",
      headers: { Authorization: "Bearer <key>" },
      body: {
        model: s.audio.model,
        voice: s.audio.voice,
        input: s.audio.said ?? s.text,
        instructions: [s.audio.style, s.audio.direction].filter(Boolean).join("; ") || undefined,
        response_format: "wav",
      },
      error: s.audio.error,
    },
    null,
    2,
  );
}
function copyReq(s: Segment) {
  navigator.clipboard?.writeText(requestOf(s));
  uiStore.toast("Request copied as JSON", { kind: "success", timeout: 2500 });
}
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
const hasDetails = (s: Segment) => !!(s.audio.at || s.audio.error || s.audio.cuts);
/** The audit trail as a strip of labelled facts — what this clip was actually rendered with. The
 *  free-text ones (style, direction) go last and take the rest of the line: they are whole phrases. */
interface Fact {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}
function facts(s: Segment): Fact[] {
  const a = s.audio;
  if (!a.at) return [];
  return [
    { label: "voice", value: endpointsStore.voiceLabel(a.voiceRef) || a.voice || "—" },
    { label: "endpoint", value: epName(a.endpoint) },
    { label: "model", value: a.model ?? "—", mono: true },
    { label: "read as", value: a.type ?? s.type },
    { label: "rendered", value: clock(a.at) },
    { label: "took", value: a.ms ? (a.ms / 1000).toFixed(1) + "s" : "—", mono: true },
    ...(a.cost ? [{ label: "cost", value: "$" + a.cost.toFixed(4), mono: true }] : []),
    ...(a.lex ? [{ label: "respelled", value: `${a.lex} word${a.lex === 1 ? "" : "s"}` }] : []),
    ...(s.pause == null
      ? []
      : [{ label: "pause after", value: s.pause === 0 ? "none — runs on" : secs(s.pause) }]),
    ...(a.style ? [{ label: "style", value: a.style, wide: true }] : []),
    { label: "direction", value: a.direction || "—", wide: true },
  ];
}
/** Every take of a segment, the current one included, oldest first. */
function allTakes(s: Segment): (Take & { current?: boolean })[] {
  const list: (Take & { current?: boolean })[] = [...(s.audio.takes ?? [])];
  if (s.audio.duration)
    list.push({
      n: s.audio.n ?? 1,
      at: s.audio.at ?? 0,
      ms: s.audio.ms,
      duration: s.audio.duration,
      endpoint: s.audio.endpoint,
      voiceRef: s.audio.voiceRef,
      voice: s.audio.voice,
      direction: s.audio.direction,
      current: true,
    });
  return list.sort((a, b) => a.n - b.n);
}
const takeTitle = (t: Take) =>
  `${endpointsStore.voiceLabel(t.voiceRef) || t.voice || "—"} · ${t.direction || "no direction"} · ${t.at ? clock(t.at) : ""}`;
const takeId = (s: Segment, n: number) => `take${s.id}-${n}`;
/** the clip the retake is judged against: whatever is in the book right now */
const candId = (s: Segment) => `cand${s.id}`;
const candPlaying = (s: Segment) => onClip(candId(s));
/** What differs between the clip in the book and the retake waiting beside it. */
function takeDiff(s: Segment): string[] {
  const a = s.audio;
  const b = s.candidate;
  if (!b) return [];
  const out: string[] = [];
  if ((a.direction || "") !== (b.direction || ""))
    out.push(`direction “${a.direction || "—"}” → “${b.direction || "—"}”`);
  if ((a.voiceRef || "") !== (b.voiceRef || ""))
    out.push(
      `voice ${endpointsStore.voiceLabel(a.voiceRef) || "—"} → ${endpointsStore.voiceLabel(b.voiceRef) || "—"}`,
    );
  if ((a.style || "") !== (b.style || ""))
    out.push(`style “${a.style || "—"}” → “${b.style || "—"}”`);
  if ((a.text || "") !== (b.text || "")) out.push("the line itself was edited");
  if ((a.said || a.text || "") !== (b.said || b.text || "") && (a.text || "") === (b.text || ""))
    out.push("the dictionary changed how a word is said");
  if (!out.length) out.push("same voice, same direction — the same request, rendered again");
  return out;
}
// A clip with no file has no shape to decode, so one is invented from its identity and the panel
// says so. Two takes of the same line seed differently, which is the point of putting them together.
const peaksOf = (seed: string, duration: number) => speechPeaks(seed, duration);
/** zinc wave / violet played for the clip in the book, sky for the one waiting to be judged */
const waveColors = (candidate: boolean) =>
  candidate
    ? { wave: uiStore.dark ? "#075985" : "#bae6fd", played: uiStore.dark ? "#38bdf8" : "#0284c7" }
    : { wave: uiStore.dark ? "#3f3f46" : "#d4d4d8", played: uiStore.dark ? "#a78bfa" : "#7c3aed" };
/** clicking a waveform plays that take from where you clicked */
function seekTake(id: string, duration: number, url: string | undefined, frac: number) {
  if (p.clipId !== id) play(id, duration, url);
  seekTo(frac * duration);
}

function playTake(s: Segment, t: Take | undefined) {
  if (t) play(takeId(s, t.n), t.duration, t.url);
}
const takePlaying = (s: Segment, t: Take | undefined) => !!t && onClip(takeId(s, t.n));
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
          v-if="stats.failed && chapter.narration !== 'running'"
          class="btn-ghost btn-xs"
          @click="narrationStore.retryFailed(bookId, chapterId)"
        >
          Retry failed ({{ stats.failed }})
        </button>
        <button
          v-if="chapter.narration !== 'running'"
          class="btn-ghost btn-xs"
          @click="narrationStore.runNarration(bookId, [chapterId])"
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
                    :title="`take ${s.candidate.n} is ${['queued', 'generating'].includes(s.candidate.status) ? 'rendering' : 'waiting for your verdict'} — the book still uses take ${s.audio.n ?? 1}`"
                    >{{
                      ["queued", "generating"].includes(s.candidate.status)
                        ? `take ${s.candidate.n} rendering…`
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
                            A retake keeps this clip: you play both and decide. Change the voice,
                            direction or the line itself first if the request was wrong, not the
                            render.
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
            <!-- a retake waiting to be judged. The left card is the clip the book still uses; the
                 right one only replaces it if the listener says so. -->
            <tr v-if="s.candidate" class="bg-sky-50 dark:bg-sky-500/5">
              <td></td>
              <td colspan="5" class="px-2 py-2 pr-4 text-xs">
                <div class="flex flex-wrap items-center gap-2">
                  <b class="text-sky-700 dark:text-sky-300">Two takes of #{{ s.id }}</b>
                  <span v-if="reviewPosition(s)" class="text-zinc-400">
                    retake {{ reviewPosition(s) }} of {{ bookReviewable.length }}
                  </span>
                  <span v-if="s.flag" class="text-amber-600"
                    ><FlagIcon class="icon-sm" /> {{ FLAG_LABEL[s.flag.kind]
                    }}<span v-if="s.flag.note"> — {{ s.flag.note }}</span></span
                  >
                  <span
                    v-if="['queued', 'generating'].includes(s.candidate!.status)"
                    class="ml-auto text-violet-500"
                    >rendering take {{ s.candidate!.n }}… the book still plays take
                    {{ s.audio.n ?? 1 }}</span
                  >
                </div>
                <div class="mt-2 grid gap-2 sm:grid-cols-2">
                  <div
                    class="rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    <div class="flex items-center gap-2">
                      <button
                        class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-zinc-200 text-[10px] disabled:opacity-40 dark:bg-zinc-700"
                        :aria-label="`${onClip('seg' + s.id) ? 'Pause' : 'Play'} A, take ${s.audio.n ?? 1}`"
                        aria-keyshortcuts="1"
                        :disabled="!s.audio.duration"
                        @click="play('seg' + s.id, s.audio.duration, s.audio.url)"
                      >
                        <component
                          :is="onClip('seg' + s.id) ? PauseIcon : PlayIcon"
                          class="icon-sm icon-fill"
                        />
                      </button>
                      <b>A · Take {{ s.audio.n ?? 1 }}</b>
                      <span class="text-zinc-400">current book</span>
                      <kbd class="ml-auto rounded border px-1 text-[10px] text-zinc-400">1</kbd>
                      <span class="font-mono text-zinc-500"
                        >{{ s.audio.duration.toFixed(1) }}s</span
                      >
                    </div>
                    <Waveform
                      v-if="s.audio.duration"
                      class="mt-1.5"
                      :url="s.audio.url"
                      :peaks="peaksOf('seg' + s.id + '#' + (s.audio.n ?? 1), s.audio.duration)"
                      :duration="s.audio.duration"
                      :progress="clipProgress('seg' + s.id) ?? 0"
                      v-bind="waveColors(false)"
                      @seek="(f) => seekTake('seg' + s.id, s.audio.duration, s.audio.url, f)"
                    />
                    <div class="mt-1 pl-8 text-[11px] text-zinc-500">
                      {{ endpointsStore.voiceLabel(s.audio.voiceRef) || s.audio.voice || "—" }} ·
                      {{ s.audio.direction || "no direction"
                      }}<span v-if="s.audio.at"> · {{ clock(s.audio.at) }}</span>
                    </div>
                  </div>
                  <div
                    class="rounded-md border p-2"
                    :class="
                      s.candidate!.duration
                        ? 'border-sky-400 bg-white dark:bg-zinc-900'
                        : 'border-dashed border-zinc-300 dark:border-zinc-700'
                    "
                  >
                    <div class="flex items-center gap-2">
                      <button
                        class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-sky-500 text-[10px] text-white disabled:opacity-40"
                        :aria-label="`${candPlaying(s) ? 'Pause' : 'Play'} B, take ${s.candidate!.n}`"
                        aria-keyshortcuts="2"
                        :disabled="!s.candidate!.duration"
                        @click="play(candId(s), s.candidate!.duration, s.candidate!.url)"
                      >
                        <component
                          :is="candPlaying(s) ? PauseIcon : PlayIcon"
                          class="icon-sm icon-fill"
                        />
                      </button>
                      <b>B · Take {{ s.candidate!.n }}</b>
                      <span class="text-zinc-400">retake</span>
                      <kbd class="ml-auto rounded border px-1 text-[10px] text-sky-500">2</kbd>
                      <span class="font-mono text-zinc-500">{{
                        s.candidate!.duration ? s.candidate!.duration.toFixed(1) + "s" : "…"
                      }}</span>
                    </div>
                    <Waveform
                      v-if="s.candidate!.duration"
                      class="mt-1.5"
                      :url="s.candidate!.url"
                      :peaks="peaksOf(candId(s) + '#' + s.candidate!.n, s.candidate!.duration)"
                      :duration="s.candidate!.duration"
                      :progress="clipProgress(candId(s)) ?? 0"
                      v-bind="waveColors(true)"
                      @seek="(f) => seekTake(candId(s), s.candidate!.duration, s.candidate!.url, f)"
                    />
                    <div class="mt-1 pl-8 text-[11px]">
                      <span v-if="s.candidate!.error" class="text-red-500"
                        >{{
                          s.candidate!.error!.code
                            ? "HTTP " + s.candidate!.error!.code + " · "
                            : ""
                        }}{{ s.candidate!.error!.message }}</span
                      ><span v-else class="text-zinc-500"
                        >{{
                          endpointsStore.voiceLabel(s.candidate!.voiceRef) ||
                          s.candidate!.voice ||
                          "—"
                        }}
                        · {{ s.candidate!.direction || "no direction"
                        }}<span v-if="s.candidate!.at"> · {{ clock(s.candidate!.at) }}</span></span
                      >
                    </div>
                  </div>
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                  <span class="min-w-0 flex-1 text-zinc-500"
                    >{{ takeDiff(s).join(" · ")
                    }}<span
                      v-if="!s.audio.url && !s.candidate!.url"
                      class="ml-1 text-[10px] text-amber-600"
                      title="the prototype renders no audio, so there is no file to decode — the shape is invented from the clip's identity, not measured"
                      >· waveform illustrative</span
                    ></span
                  >
                  <template v-if="!['queued', 'generating'].includes(s.candidate!.status)">
                    <button
                      class="btn-ghost btn-xs"
                      :title="
                        s.candidate!.duration
                          ? 'keep the clip the book already uses (x)'
                          : 'drop this retake (x)'
                      "
                      aria-keyshortcuts="x"
                      @click="decideTake(s, 'current')"
                    >
                      {{
                        s.candidate!.duration ? `Keep A · take ${s.audio.n ?? 1}` : "Discard retake"
                      }}
                      <kbd class="ml-1 rounded border px-1 text-[9px]">X</kbd>
                    </button>
                    <button
                      v-if="s.candidate!.duration"
                      class="btn-primary btn-xs"
                      title="put the new clip in the book and clear the flag (a)"
                      aria-keyshortcuts="a"
                      @click="decideTake(s, 'new')"
                    >
                      Keep B · take {{ s.candidate!.n }}
                      <kbd class="ml-1 rounded border border-white/40 px-1 text-[9px]">A</kbd>
                    </button>
                  </template>
                </div>
              </td>
            </tr>
            <tr v-if="expanded.has(s.id)" class="bg-zinc-50 dark:bg-zinc-900/60">
              <td></td>
              <td colspan="5" class="py-2 pr-4">
                <div class="border-l-2 border-violet-400 pl-3 text-xs dark:border-violet-500">
                  <ExpressionEditor
                    :book-id="bookId"
                    :chapter-id="chapterId"
                    :segment="s"
                    class="mb-3 border-b border-zinc-200 pb-3 dark:border-zinc-700"
                  />
                  <!-- what this clip was rendered with -->
                  <div v-if="facts(s).length" class="flex items-start gap-3">
                    <div class="flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-1.5">
                      <div
                        v-for="f in facts(s)"
                        :key="f.label"
                        class="min-w-0"
                        :class="f.wide ? 'min-w-[10rem] flex-1' : 'max-w-[220px]'"
                      >
                        <div class="text-[9px] uppercase tracking-wider text-zinc-400">
                          {{ f.label }}
                        </div>
                        <div
                          :class="[
                            f.mono && 'font-mono text-[11px]',
                            f.wide ? 'break-words' : 'truncate',
                          ]"
                        >
                          {{ f.value }}
                        </div>
                      </div>
                    </div>
                    <button
                      class="shrink-0 text-[11px] text-violet-500 hover:underline"
                      title="the exact request body, as JSON"
                      @click.stop="copyReq(s)"
                    >
                      copy request
                    </button>
                  </div>

                  <!-- the dictionary rewrote something on the way out -->
                  <div
                    v-if="s.audio.said"
                    class="mt-2 rounded bg-violet-500/5 px-2 py-1 text-[11px] leading-relaxed"
                  >
                    <span class="text-[9px] uppercase tracking-wider text-zinc-400">sent</span>
                    <span class="ml-1.5 font-mono text-violet-700 dark:text-violet-300">{{
                      s.audio.said
                    }}</span>
                  </div>

                  <!-- the clip no longer matches the script -->
                  <div
                    v-if="drift(s).length || s.audio.status === 'stale'"
                    class="mt-2 flex flex-wrap items-center gap-2 rounded bg-amber-400/10 px-2 py-1 text-amber-700 dark:text-amber-300"
                  >
                    <WarnIcon class="icon shrink-0" />
                    <span class="min-w-0 flex-1">{{
                      drift(s).length
                        ? `the script changed after this clip · ${drift(s).join(" · ")}`
                        : "edited after narration — this clip reads the old script"
                    }}</span>
                    <button
                      v-if="chapter.narration !== 'running'"
                      class="btn-ghost btn-xs shrink-0 border-amber-400"
                      @click.stop="narrationStore.retrySegment(bookId, chapterId, s.id)"
                    >
                      Render it again
                    </button>
                  </div>

                  <!-- the request failed -->
                  <div
                    v-if="s.audio.error"
                    class="mt-2 rounded border border-red-300 bg-red-500/5 px-2 py-1.5 dark:border-red-500/40"
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <b class="text-red-600">{{
                        s.audio.error.code ? "HTTP " + s.audio.error.code : "not sent"
                      }}</b
                      ><span class="min-w-0 flex-1">{{ s.audio.error.message }}</span
                      ><span v-if="s.audio.error.at" class="text-zinc-400">{{
                        clock(s.audio.error.at)
                      }}</span>
                    </div>
                    <pre
                      v-if="s.audio.error.body"
                      class="mt-1 max-h-16 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-1.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
                      >{{ s.audio.error.body }}</pre>
                  </div>

                  <!-- every take, the one in the book marked -->
                  <div
                    v-if="s.audio.takes?.length"
                    class="mt-2 flex flex-wrap items-center gap-1.5"
                  >
                    <span class="text-[9px] uppercase tracking-wider text-zinc-400">takes</span>
                    <button
                      v-for="t in allTakes(s)"
                      :key="t.n"
                      class="chip"
                      :class="[t.current && 'chip-on', t.rejected && 'chip-off']"
                      :title="takeTitle(t)"
                      @click.stop="
                        t.current
                          ? play('seg' + s.id, s.audio.duration, s.audio.url)
                          : playTake(s, t)
                      "
                    >
                      <component
                        :is="
                          (t.current ? onClip('seg' + s.id) : takePlaying(s, t))
                            ? PauseIcon
                            : PlayIcon
                        "
                        class="icon-sm icon-fill"
                      />
                      take {{ t.n }} · {{ t.duration.toFixed(1) }}s
                      <span v-if="t.current" class="text-[10px] opacity-70">in the book</span>
                      <span v-else-if="t.rejected" class="text-[10px]">not kept</span>
                    </button>
                  </div>

                  <!-- one segment, several requests -->
                  <details v-if="s.audio.cuts" class="mt-2">
                    <summary
                      class="cursor-pointer text-[9px] uppercase tracking-wider text-zinc-400"
                    >
                      sent as {{ s.audio.cuts!.length }} requests · cut at
                      {{ (s.audio.splitAt && AT[s.audio.splitAt]) ?? s.audio.splitAt }} · joined
                      after
                    </summary>
                    <ol class="mt-1 max-h-28 space-y-1 overflow-auto pr-1">
                      <li v-for="(c, i) in s.audio.cuts" :key="i" class="flex gap-3">
                        <span
                          class="w-14 shrink-0 whitespace-nowrap font-mono text-[10px] text-zinc-400"
                          >{{ i + 1 }} · {{ c.to - c.from }} ch</span
                        ><span class="min-w-0 flex-1 text-zinc-600 dark:text-zinc-300"
                          >{{ (s.audio.said ?? s.text).slice(c.from, c.to)
                          }}<span
                            v-if="c.at"
                            class="ml-2 font-mono text-[10px]"
                            :class="c.fallback ? 'text-amber-600' : 'text-zinc-400'"
                            ><CutIcon class="icon-sm" /> {{ AT[c.at]
                            }}{{ c.fallback ? " (fallback)" : "" }}</span
                          ></span
                        >
                      </li>
                    </ol>
                  </details>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <div v-if="!rows.length" class="p-8 text-center text-sm text-zinc-500">
        No {{ filter }} segments.
      </div>
    </div>

    <div
      class="border-t border-zinc-200 bg-zinc-50 px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <div class="flex items-center gap-3">
        <div class="flex shrink-0 items-center gap-0.5">
          <button class="icon-btn" :disabled="!isChapter" title="previous line" @click="prev()">
            <PrevIcon class="icon-sm" />
          </button>
          <button
            class="icon-btn"
            :disabled="!isChapter"
            title="back 10 seconds"
            @click="skip(-10)"
          >
            <BackIcon class="icon-sm" />
          </button>
          <button
            class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-600 text-white disabled:opacity-40"
            :disabled="!total"
            title="play the stitched chapter (space)"
            @click="playChapter()"
          >
            <component
              :is="isChapter && p.playing ? PauseIcon : PlayIcon"
              class="icon-lg icon-fill"
            />
          </button>
          <button
            class="icon-btn"
            :disabled="!isChapter"
            title="forward 10 seconds"
            @click="skip(10)"
          >
            <FwdIcon class="icon-sm" />
          </button>
          <button class="icon-btn" :disabled="!isChapter" title="next line" @click="next()">
            <NextIcon class="icon-sm" />
          </button>
        </div>
        <div class="min-w-0 flex-1">
          <div class="mb-1 flex items-center justify-between text-xs">
            <span class="truncate"
              ><b v-if="currentId"
                >#{{ currentId }} {{ segments.find((s) => s.id === currentId)?.speaker }}</b
              ><span v-else-if="isChapter && p.playing" class="text-zinc-500">silence</span
              ><span v-else class="text-zinc-500">{{
                total ? "Stitched chapter · click the bar to scrub" : "No audio yet"
              }}</span>
              <span v-if="total && !p.live" class="ml-1 text-[10px] text-amber-600"
                >timed, not heard — no rendered files in the prototype</span
              ></span
            >
            <span class="flex items-center gap-2">
              <button
                class="rounded border border-zinc-200 px-1 font-mono text-[10px] text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
                title="playback speed"
                @click="cycleRate()"
              >
                {{ p.rate }}×
              </button>
              <span class="font-mono text-zinc-500"
                >{{ fmt(isChapter ? p.pos : 0) }} / {{ fmt(total) }}</span
              >
            </span>
          </div>
          <div class="relative h-5 cursor-pointer overflow-hidden rounded" @click="scrub">
            <div class="absolute inset-0 flex gap-px">
              <template v-for="x in timeline" :key="x.s.id">
                <div
                  class="h-full"
                  :style="{
                    width: ((x.end - x.start) / total) * 100 + '%',
                    background: colorOf(x.s.speaker),
                    opacity: x.s.audio.status === 'stale' ? 0.35 : 0.75,
                  }"
                  :title="`#${x.s.id} ${x.s.speaker}`"
                ></div>
                <div
                  v-if="x.gap"
                  class="h-full bg-zinc-200 dark:bg-zinc-700"
                  :style="{ width: (x.gap / total) * 100 + '%' }"
                  :title="`${secs(x.gap)} of silence${x.s.pause != null ? ' — set on this line' : ''}`"
                ></div>
              </template>
              <div v-if="!timeline.length" class="h-full w-full bg-zinc-200 dark:bg-zinc-800"></div>
            </div>
            <div
              v-if="isChapter"
              class="absolute inset-y-0 left-0 bg-black/25 dark:bg-white/25"
              :style="{ width: (total ? (p.pos / total) * 100 : 0) + '%' }"
            ></div>
            <div
              v-if="isChapter"
              class="absolute inset-y-0 w-0.5 bg-black dark:bg-white"
              :style="{ left: (total ? (p.pos / total) * 100 : 0) + '%' }"
            ></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
