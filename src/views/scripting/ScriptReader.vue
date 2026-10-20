<script setup lang="ts">
import { chapterName } from "@/lib/chapterNumber";
import { useBookScripts, useChapterHistory, useEffects } from "@/queries";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// Script reader: narration as prose, dialogue and thought as cards. Any line opens an editor in
// place (`SegmentEditor`) that can also split and join lines. Site text and notes stay in the script,
// marked rather than stripped; the detector's disagreements show under their line.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useScript } from "@/views/scripting/shared";
import { preview, provideSegmentEditing } from "@/views/scripting/segmentEditing";
import { useBurstToast } from "@/views/scripting/useBurstToast";
import { useReaderKeys } from "@/views/scripting/useReaderKeys";
import { useReader } from "@/stores/reader";
import ReaderSettings from "@/components/ReaderSettings.vue";
import ScriptHistory from "@/views/scripting/ScriptHistory.vue";
import ScriptProfileSelect from "@/views/scripting/ScriptProfileSelect.vue";
import CorrectionsNote from "@/views/scripting/CorrectionsNote.vue";
import SegmentEditor from "@/views/scripting/SegmentEditor.vue";
import ChapterCastRail from "@/views/scripting/ChapterCastRail.vue";
import LinePill from "@/views/scripting/LinePill.vue";
import ExpressionText from "@/components/ExpressionText.vue";
import { secs } from "@/lib/speech";
import { plural } from "@/lib/contents";
import { isSiteText, isSpoken, TYPE_LABEL } from "@/lib/siteText";
import { usePlayer } from "@/composables/usePlayer";
import { enumParam, idParam, useQueryParam } from "@/composables/useQueryParam";
import { chapterQueue, chapterQueueId, clipOf, segmentStart } from "@/composables/useChapterQueue";
import {
  AudioLines as NarrationIcon,
  ChevronUp as ChevronUpIcon,
  ChevronDown as ChevronDownIcon,
  Maximize2 as FocusIcon,
  Minimize2 as ExitFocusIcon,
  Flag as FlagIcon,
  History as HistoryIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  RotateCcw as RetryIcon,
  Scissors as SplitIcon,
  ScanSearch as SiteCheckIcon,
  TriangleAlert as WarnIcon,
  Users as CastIcon,
} from "@lucide/vue";
import { UiSelect, UiToggleGroup } from "@/ui";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import type { Segment } from "@/types";

const props = withDefaults(
  defineProps<{ bookId: string; chapterId: number; focusMode?: boolean }>(),
  { focusMode: false },
);
const emit = defineEmits<{ "toggle-focus": [] }>();
const { segments, cast, counts, inChapter, colorOf } = useScript(props);
const filterOpts = computed(() => [
  { value: "", label: "All speakers" },
  ...inChapter.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    hint: counts.value[c.name] + "",
  })),
]);
const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();
const scriptingStore = useScriptingStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const reader = useReader();
const route = useRoute();
const router = useRouter();
// Every chapter's script, for book-wide counts and the player's next chapter.
const bookScripts = useBookScripts(() => props.bookId);
// for the line effects' names
useEffects();
const volume = computed(() => libraryStore.volumeOf(props.bookId, props.chapterId));
const multiVolume = computed(() => libraryStore.volumesOf(props.bookId).length > 1);

/** In the URL so another page can link to "Site text". Hidden marked lines are still counted. */
const mode = useQueryParam("lines", enumParam(["all", "dialogue", "site"], "all"));
const warnOpen = ref(false); // the unverified-chunk banner reads as one line until asked
const speaker = ref(""); // '' = everyone
/** the line whose editor is open */
const open = ref<number | null>(null);
/** the line the keys act on; mirrored to `?seg=` so links and reloads land on it */
const focus = ref<number | null>(null);
const linked = useQueryParam("seg", idParam());
const editing = provideSegmentEditing(props, { open, focus });
const { splitting, editingText, nextOf, gapOf, bookGap, setPause } = editing;

const inSite = (s: Segment) => isSiteText(s.type) || !!s.siteCheck;
const rows = computed(() =>
  segments.value.filter(
    (s) =>
      (mode.value === "all" ||
        (mode.value === "dialogue" ? s.type === "dialogue" || s.type === "thought" : inSite(s))) &&
      (!speaker.value || s.speaker === speaker.value),
  ),
);
const chapter = computed(() => libraryStore.chapter(props.bookId, props.chapterId)!);
/** undefined for a skipped chapter */
const number = computed(() => libraryStore.numberOf(props.bookId, props.chapterId));
// Counted among kept chapters; `volumeIndex` would count cover and contents pages too.
const numberInVolume = computed(
  () =>
    libraryStore
      .chaptersOf(props.bookId)
      .filter(
        (c) => c.volumeId === chapter.value.volumeId && !c.excluded && c.id <= props.chapterId,
      ).length,
);
const book = computed(() => libraryStore.bookById(props.bookId));
const siteText = computed(() => segments.value.filter((s) => s.type === "watermark").length);
const notes = computed(() => segments.value.filter((s) => s.type === "note").length);
const siteRows = computed(() => segments.value.filter(inSite).length);
/** marked lines the filters in force leave off the page */
const hiddenSite = computed(
  () =>
    segments.value.filter((s) => isSiteText(s.type)).length -
    rows.value.filter((s) => isSiteText(s.type)).length,
);
const spoken = (s: Segment) => isSpoken(s, book.value);
const chars = computed(() => segments.value.reduce((a, s) => a + s.text.length, 0));

function nextNew() {
  const s = segments.value.find((s) => cast.value.find((c) => c.name === s.speaker)?.isNew);
  if (s) {
    open.value = s.id;
    document.getElementById("seg-" + s.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
const unresolved = computed(() => inChapter.value.filter((c) => c.isNew).length);
const fallbacks = computed(() => segments.value.filter((s) => s.fallback));

const { continuing, announce } = useBurstToast();

/** Keyboard pause nudge. Toasts with undo: the line may have scrolled out of view. */
let pauseWas: number | null = null;
function nudgePause(s: Segment, step: number) {
  const key = `pause:${s.id}`;
  if (!continuing(key)) pauseWas = s.pause ?? null;
  const was = pauseWas;
  const v = Math.max(0, Math.round((gapOf(s) + step) * 100) / 100);
  const next = v === bookGap(s) ? null : v;
  if (next === (s.pause ?? null)) return;
  setPause(s, next);
  const say = (p: number | null) =>
    p === null
      ? `the book's ${secs(bookGap(s))}`
      : p === 0
        ? "no pause — runs straight on"
        : secs(p);
  announce(key, () =>
    uiStore.toast(`Pause after #${s.id}: ${say(next)}`, {
      description: `Was ${say(was)}. Silence is stitched at build time, so no clip goes stale.`,
      undo: () => setPause(s, was),
    }),
  );
}

// Plays the same chapter queue as the ledger, from this line on.
const { p, playQueue, toggle } = usePlayer();
const queueId = computed(() => chapterQueueId(props.bookId, props.chapterId));
const onClip = (s: Segment) => p.clipId === clipOf(s.id) && p.playing;
function playLine(s: Segment) {
  if (!s.audio.duration) return;
  if (p.id === queueId.value && p.clipId === clipOf(s.id)) return toggle();
  const q = chapterQueue(props.bookId, props.chapterId, {
    href: (id) => `/book/${props.bookId}/scripting?ch=${id}`,
    onChapter: (id) => void router.replace({ query: { ...route.query, ch: String(id) } }),
  });
  const at = segmentStart(props.bookId, props.chapterId, s.id);
  if (q && at != null) playQueue(q, at);
}
// Follow the playhead only while playing this chapter, so scrolling back is never fought.
watch(
  () => p.clipId,
  (id) => {
    if (!id || !p.playing || p.id !== queueId.value) return;
    document.getElementById(`seg-${id.slice(3)}`)?.scrollIntoView({ block: "nearest" });
  },
);

// Counted as the ledger's "Re-narrate changed" counts them.
const stale = computed(() => narrationStore.changedSegments(props.bookId, props.chapterId).length);
const edits = computed(() => segments.value.filter((s) => s.edited).length);

// Re-script: held to the same blockers as the page's Run.
const rescriptOpen = ref(false);
const rescriptBlockers = computed(
  () => scriptingStore.scriptEstimate(props.bookId, [props.chapterId]).blockers,
);
const diff = computed(() => scriptsStore.scriptDiff(props.bookId, props.chapterId));
const showDiff = ref(true);
function rescript() {
  rescriptOpen.value = false;
  void scriptingStore.startRun(props.bookId, [props.chapterId], { quiet: true });
}
function jumpTo(id: number) {
  focus.value = id;
  open.value = null;
  nextTick(() =>
    document.getElementById("seg-" + id)?.scrollIntoView({ block: "center", behavior: "smooth" }),
  );
}

// History replaces the reader's body, so only one script is ever on screen.
const history = useQueryParam<boolean>("history", {
  parse: (text) => text === "1",
  serialize: (on) => (on ? "1" : undefined),
  default: false,
});
const historyPanel = ref<{ back: () => boolean } | null>(null);
// via the query so the count is right before the panel opens
const { versions: knownVersions } = useChapterHistory(
  () => props.bookId,
  () => props.chapterId,
);
const versionCount = computed(() => knownVersions.value.length);
function jumpFromHistory(id: number) {
  history.value = false;
  jumpTo(id);
}

const toggleFocus = () => emit("toggle-focus");
const root = ref<HTMLElement | null>(null);
watch(focus, (value) => (linked.value = value));
useReaderKeys({
  root,
  rows,
  segments,
  inChapter,
  editing,
  history,
  historyBack: () => !!historyPanel.value?.back(),
  focusMode: () => props.focusMode,
  toggleFocus,
  reader,
  nudgePause,
  playLine,
  assignSpeaker,
});
/** Number-key speaker swap. Toasts with undo since the line may be off screen; a quick correction
 *  merges into one toast from the original speaker. */
let assignWas = "";
let assignUndo: () => void = () => {};
function assignSpeaker(id: number, name: string) {
  const s = segments.value.find((x) => x.id === id);
  if (!s || s.speaker === name) return;
  const key = `speaker:${id}`;
  if (!continuing(key)) {
    assignWas = s.speaker;
    assignUndo = scriptsStore._editSnapshot(props.bookId, props.chapterId);
  }
  const was = assignWas;
  const revert = assignUndo;
  const line = preview(s.text, 60);
  scriptsStore.setSpeaker(props.bookId, props.chapterId, id, name);
  announce(key, () =>
    uiStore.toast(`#${id} is now ${name}`, {
      description: `Was ${was}. “${line}”`,
      undo: revert,
    }),
  );
}

onMounted(() => {
  if (linked.value) jumpTo(linked.value);
});
watch(linked, (id) => {
  if (id && id !== focus.value) jumpTo(id);
});
watch(open, (v) => {
  if (v) focus.value = v;
  if (v !== editingText.value) editingText.value = null;
});
</script>

<template>
  <div
    ref="root"
    class="grid h-full gap-4"
    :class="reader.showCast ? 'lg:grid-cols-[1fr_300px]' : 'grid-cols-1'"
  >
    <div class="card flex min-h-0 min-w-0 flex-col">
      <div class="border-b border-zinc-200 px-4 pb-3 pt-4 sm:px-6 dark:border-zinc-800">
        <div class="flex flex-wrap items-start gap-2">
          <div class="min-w-[200px] flex-1">
            <div class="label">
              <span v-if="multiVolume">{{ volume?.name }} · </span
              ><template v-if="number"
                >Chapter {{ number
                }}<span
                  v-if="multiVolume"
                  class="font-normal normal-case tracking-normal text-zinc-400"
                >
                  (ch. {{ numberInVolume }} of this volume)</span
                ></template
              ><template v-else>Skipped chapter</template>
            </div>
            <h2 class="truncate font-serif text-2xl">{{ chapter.title }}</h2>
            <div class="mt-0.5 text-xs text-zinc-500">
              {{ segments.length }} segments
              <template v-if="siteText"> · {{ siteText }} site text</template
              ><template v-if="notes"> · {{ plural(notes, "note") }}</template> ·
              {{ inChapter.length }} speakers · {{ (chars / 1000).toFixed(1) }}k chars
            </div>
          </div>
          <button
            v-if="unresolved"
            class="btn-ghost btn-xs border-amber-400 text-amber-600"
            @click="nextNew"
          >
            <WarnIcon class="icon-sm" /> {{ unresolved }} unreviewed speaker{{
              unresolved > 1 ? "s" : ""
            }}
            → jump
          </button>
          <PopoverRoot v-model:open="rescriptOpen">
            <PopoverTrigger class="btn-ghost btn-xs" data-tip="run the LLM again on this chapter"
              ><RetryIcon class="icon-sm" /> Re-script</PopoverTrigger
            >
            <PopoverPortal>
              <PopoverContent :side-offset="6" align="end" class="ui-popup w-80 p-3 text-xs">
                <div class="label mb-2">Re-script {{ chapterName(number) }}</div>
                <div class="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
                  <span class="text-zinc-500">Endpoint</span><ScriptProfileSelect />
                  <span class="text-zinc-500">Chunking</span>
                  <span class="text-zinc-400">Uses this endpoint’s request settings.</span>
                </div>
                <CorrectionsNote class="mt-2" :edits="edits" scope="this chapter" />
                <div class="mt-1 text-[11px] text-zinc-500">
                  <template v-if="segments.some((s) => s.audio.duration)"
                    >Narrated audio is kept; lines whose speaker or direction change become
                    stale.</template
                  >
                  A “what changed” panel appears when it finishes.
                </div>
                <div
                  v-if="rescriptBlockers.length"
                  class="mt-2 space-y-1 rounded-md bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
                  role="status"
                >
                  <p v-for="reason in rescriptBlockers" :key="reason">{{ reason }}</p>
                </div>
                <div class="mt-3 flex justify-end gap-2">
                  <button class="btn-ghost btn-xs" @click="rescriptOpen = false">Cancel</button
                  ><button
                    class="btn-primary btn-xs"
                    :disabled="!!rescriptBlockers.length"
                    @click="rescript"
                  >
                    Re-script now
                  </button>
                </div>
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
          <button
            class="btn-ghost btn-xs"
            :class="history && 'border-violet-400 text-violet-700 dark:text-violet-300'"
            :aria-pressed="history"
            :data-tip="
              history
                ? 'Back to the current script (Esc)'
                : 'Earlier versions of this chapter’s script — preview, compare and restore'
            "
            @click="history = !history"
          >
            <HistoryIcon class="icon-sm" /> History
            <span v-if="versionCount" class="text-zinc-400">{{ versionCount }}</span>
          </button>
          <button
            class="btn-ghost btn-xs"
            :class="reader.showCast && 'bg-zinc-200 dark:bg-zinc-800'"
            @click="reader.showCast = !reader.showCast"
          >
            <CastIcon class="icon-sm" /> Cast
            <span class="text-zinc-400">{{ inChapter.length }}</span>
          </button>
          <button
            class="btn-ghost btn-xs"
            :class="focusMode && 'bg-zinc-200 dark:bg-zinc-800'"
            :data-tip="focusMode ? 'Exit reader focus mode (Esc or F)' : 'Focus the reader (F)'"
            @click="emit('toggle-focus')"
          >
            <component :is="focusMode ? ExitFocusIcon : FocusIcon" class="icon-sm" />
            {{ focusMode ? "Exit focus" : "Focus reader" }}
          </button>
          <ReaderSettings />
        </div>
        <div v-if="!history" class="mt-3 flex flex-wrap items-center gap-2">
          <UiToggleGroup
            v-model="mode"
            :options="[
              { value: 'all', label: 'Everything' },
              { value: 'dialogue', label: 'Dialogue only' },
              ...(siteRows || mode === 'site'
                ? [{ value: 'site', label: `Site text ${siteRows}` }]
                : []),
            ]"
          />
          <UiSelect v-model="speaker" :options="filterOpts" size="xs" class="w-40" />
          <span class="ml-auto whitespace-nowrap text-[11px] text-zinc-400"
            >{{ rows.length }} shown<template v-if="hiddenSite">
              ·
              <button
                class="underline decoration-dotted hover:text-violet-500"
                data-tip="Show the lines marked as site text or notes"
                @click="((mode = 'site'), (speaker = ''))"
              >
                {{ hiddenSite }} marked not shown
              </button></template
            >
            · click any line to edit</span
          >
        </div>
      </div>

      <ScriptHistory
        v-if="history"
        ref="historyPanel"
        :book-id="bookId"
        :chapter-id="chapterId"
        @close="history = false"
        @jump="jumpFromHistory"
      />

      <div
        v-if="!history && fallbacks.length"
        class="border-b border-amber-300 bg-amber-400/10 text-xs text-amber-700 dark:border-amber-500/40 dark:text-amber-300"
      >
        <div class="flex items-center gap-3 px-6 py-1.5">
          <button
            class="flex min-w-0 flex-1 items-center gap-3 text-left"
            :aria-expanded="warnOpen"
            :data-tip="warnOpen ? 'hide the detail' : 'what this means'"
            @click="warnOpen = !warnOpen"
          >
            <WarnIcon class="icon shrink-0" />
            <span class="min-w-0 flex-1 truncate"
              ><b
                >{{ fallbacks.length }} chunk{{ fallbacks.length > 1 ? "s" : "" }} didn’t verify</b
              >
              — kept whole, read by the Narrator</span
            >
            <component
              :is="warnOpen ? ChevronUpIcon : ChevronDownIcon"
              class="icon shrink-0 opacity-60"
            />
          </button>
          <button
            class="btn-ghost btn-xs shrink-0 border-amber-400"
            @click="jumpTo(fallbacks[0].id)"
          >
            Show
          </button>
        </div>
        <p v-if="warnOpen" class="px-6 pb-2 pl-[3.4rem] leading-relaxed">
          The model’s split couldn’t be matched back to the source text, so
          {{ fallbacks.length > 1 ? "they were" : "it was" }} kept whole and will be read by the
          Narrator. Nothing is missing from the audio, but dialogue inside won’t get character
          voices — re-split the chunk, or split it by hand.
        </p>
      </div>
      <div
        v-if="!history && stale"
        class="flex items-center gap-3 border-b border-amber-300 bg-amber-400/10 px-6 py-2 text-xs text-amber-700 dark:border-amber-500/40 dark:text-amber-300"
      >
        <NarrationIcon class="icon shrink-0" />
        <span class="flex-1"
          ><b>{{ stale }} line{{ stale > 1 ? "s" : "" }} changed since narration</b> — the audio
          still reads the old script, and new lines have none of their own.</span
        >
        <RouterLink
          :to="{ path: `/book/${bookId}/narration`, query: { ch: chapterId } }"
          class="btn-primary btn-xs"
          ><RetryIcon class="icon-sm" /> Re-narrate changed</RouterLink
        >
      </div>
      <div
        v-if="!history && diff && showDiff"
        class="border-b border-violet-300 bg-violet-50 px-6 py-2 text-xs dark:border-violet-500/40 dark:bg-violet-500/10"
      >
        <div class="flex items-center gap-3">
          <RetryIcon class="icon-sm text-violet-500" />
          <span class="flex-1"
            ><b>Re-scripted.</b> {{ diff.prevCount }} → {{ diff.curCount }} segments ·
            <b>{{ diff.speaker.length }}</b> speaker change{{
              diff.speaker.length === 1 ? "" : "s"
            }}
            · <b>{{ diff.direction.length }}</b> direction change{{
              diff.direction.length === 1 ? "" : "s"
            }}
            · <b>{{ diff.added.length }}</b> new · <b>{{ diff.removed.length }}</b> gone<span
              v-if="!diff.total"
            >
              — identical to the previous run</span
            ></span
          >
          <button
            class="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            @click="scriptsStore.dismissDiff(bookId, chapterId)"
          >
            dismiss
          </button>
        </div>
        <ul v-if="diff.total" class="mt-1.5 max-h-28 space-y-0.5 overflow-auto pl-6">
          <li v-for="d in diff.speaker" :key="'s' + d.id" class="flex gap-2">
            <button class="font-mono text-violet-500 hover:underline" @click="jumpTo(d.id)">
              #{{ d.id }}</button
            ><span class="truncate"
              ><span class="text-zinc-500 line-through">{{ d.from }}</span> → <b>{{ d.to }}</b> ·
              {{ d.text.slice(0, 70) }}…</span
            >
          </li>
          <li v-for="d in diff.direction" :key="'d' + d.id" class="flex gap-2">
            <button class="font-mono text-violet-500 hover:underline" @click="jumpTo(d.id)">
              #{{ d.id }}</button
            ><span class="truncate"
              >direction <span class="text-zinc-500">{{ d.from || "—" }}</span> →
              <b>{{ d.to || "—" }}</b></span
            >
          </li>
          <li v-for="d in diff.added" :key="'a' + d.id" class="flex gap-2">
            <button class="font-mono text-emerald-600 hover:underline" @click="jumpTo(d.id)">
              #{{ d.id }}</button
            ><span class="truncate">new · {{ d.text.slice(0, 80) }}…</span>
          </li>
          <li v-for="(d, i) in diff.removed" :key="'r' + i" class="flex gap-2 text-zinc-500">
            <span class="font-mono">—</span
            ><span class="truncate">gone · {{ d.text.slice(0, 80) }}…</span>
          </li>
        </ul>
      </div>
      <div v-if="!history" class="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6">
        <div
          class="mx-auto"
          :class="[reader.widthClass, reader.fontClass]"
          :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }"
        >
          <template v-for="s in rows" :key="s.id">
            <div
              v-if="s.fallback"
              :id="'seg-' + s.id"
              class="mb-3 rounded-lg border border-dashed border-amber-400 bg-amber-400/5 px-4 py-3"
              :class="focus === s.id && 'ring-2 ring-amber-400'"
            >
              <div class="mb-1 flex items-center gap-2 font-sans text-xs leading-normal">
                <span
                  class="rounded bg-amber-400/20 px-1.5 py-0.5 font-semibold text-amber-700 dark:text-amber-300"
                  >unverified chunk · read as narration</span
                >
                <span class="text-zinc-500">~{{ s.fallbackCount }} segments collapsed</span>
                <span v-if="s.fallbackRetrying" class="ml-auto text-violet-500">re-splitting…</span>
                <template v-else>
                  <button
                    class="btn-ghost btn-xs ml-auto"
                    @click="scriptingStore.retryChunk(bookId, chapterId, s.id)"
                  >
                    <RetryIcon class="icon-sm" /> Re-split this chunk
                  </button>
                  <button class="btn-ghost btn-xs" @click="((open = s.id), (splitting = s.id))">
                    <SplitIcon class="icon-sm" /> Split by hand
                  </button>
                </template>
              </div>
              <p class="text-zinc-700 dark:text-zinc-300">
                <ExpressionText :book-id="bookId" :segment="s" />
              </p>
              <details class="mt-2 font-sans text-[11px] leading-normal text-zinc-500">
                <summary class="cursor-pointer">Why it failed</summary>
                <div class="mt-1 rounded bg-white p-2 font-mono dark:bg-zinc-900">
                  verify: reconstructed text diverged near
                  <span class="bg-red-500/15 text-red-600">“{{ s.fallbackMismatch }}…”</span>
                  after 2 retries → kept chunk whole (no prose dropped)
                </div>
              </details>
            </div>
            <!-- site text and notes -->
            <p
              v-else-if="isSiteText(s.type)"
              :id="'seg-' + s.id"
              data-line
              class="-mx-2 mb-3 flex cursor-text items-start gap-2 rounded px-2 py-0.5 transition-colors"
              :class="
                open === s.id
                  ? 'bg-violet-50 ring-1 ring-violet-300 dark:bg-violet-500/10 dark:ring-violet-500/40'
                  : focus === s.id
                    ? 'ring-1 ring-zinc-400'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              "
              @click="open = open === s.id ? null : s.id"
            >
              <span
                class="min-w-0 flex-1"
                :class="
                  s.type === 'watermark'
                    ? 'text-zinc-400 line-through decoration-zinc-400/70 dark:text-zinc-500'
                    : 'italic text-zinc-500 dark:text-zinc-400'
                "
                ><ExpressionText :book-id="bookId" :segment="s"
              /></span>
              <span
                class="mt-1 shrink-0 whitespace-nowrap rounded bg-zinc-100 px-1.5 py-0.5 font-sans text-[10px] font-medium leading-none text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                :data-tip="
                  spoken(s)
                    ? 'This book reads its notes aloud (Overview → Reading)'
                    : 'Kept in the script, left out of the audio'
                "
                >{{ TYPE_LABEL[s.type] }} · {{ spoken(s) ? "read" : "not read" }}</span
              >
              <button
                class="btn-ghost btn-xs mt-0.5 shrink-0 font-sans leading-none"
                :data-tip="`#${s.id} is the story — read it as narration`"
                @click.stop="scriptsStore.setLineType(bookId, chapterId, s.id, 'narration')"
              >
                Not site text
              </button>
              <button
                v-if="spoken(s) && s.audio.duration"
                class="icon-btn line-tool mt-0.5 shrink-0"
                :class="onClip(s) ? 'icon-btn-play is-on' : focus === s.id && 'is-on'"
                :aria-label="`${onClip(s) ? 'Pause' : 'Play'} line ${s.id}`"
                :data-tip="`Play the chapter from this line (p) · ${secs(s.audio.duration)}`"
                @click.stop="playLine(s)"
              >
                <component :is="onClip(s) ? PauseIcon : PlayIcon" class="icon-sm icon-fill" />
              </button>
            </p>
            <!-- narration -->
            <p
              v-else-if="s.type === 'narration'"
              :id="'seg-' + s.id"
              data-line
              class="-mx-2 mb-3 flex cursor-text items-start gap-2 rounded px-2 py-0.5 transition-colors"
              :class="
                open === s.id
                  ? 'bg-violet-50 ring-1 ring-violet-300 dark:bg-violet-500/10 dark:ring-violet-500/40'
                  : focus === s.id
                    ? 'ring-1 ring-zinc-400'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              "
              @click="open = open === s.id ? null : s.id"
            >
              <span class="min-w-0 flex-1"
                ><ExpressionText :book-id="bookId" :segment="s" /><span
                  v-if="s.flag"
                  class="ml-2 rounded bg-amber-400/20 px-1 font-sans text-[10px] font-semibold leading-none text-amber-700 dark:text-amber-300"
                  :data-tip="s.flag.note"
                  ><FlagIcon class="icon-sm" /> {{ s.flag.kind }}</span
                ><span
                  v-if="s.direction"
                  class="ml-2 font-sans text-[11px] leading-none text-violet-500/80"
                  >[{{ s.direction }}]</span
                ></span
              >
              <!-- same column as the cards' controls -->
              <button
                v-if="s.audio.duration"
                class="icon-btn line-tool mt-0.5 shrink-0"
                :class="onClip(s) ? 'icon-btn-play is-on' : focus === s.id && 'is-on'"
                :aria-label="`${onClip(s) ? 'Pause' : 'Play'} line ${s.id}`"
                :data-tip="`Play the chapter from this line (p) · ${secs(s.audio.duration)}`"
                @click.stop="playLine(s)"
              >
                <component :is="onClip(s) ? PauseIcon : PlayIcon" class="icon-sm icon-fill" />
              </button>
            </p>
            <!-- dialogue / thought -->
            <div
              v-else
              :id="'seg-' + s.id"
              data-line
              class="mb-3 cursor-pointer rounded-lg border-l-[3px] bg-zinc-50 px-4 py-2.5 transition-colors dark:bg-zinc-800/50"
              :style="{ borderLeftColor: colorOf(s.speaker) }"
              :class="
                open === s.id
                  ? 'ring-1 ring-violet-300 dark:ring-violet-500/40'
                  : focus === s.id
                    ? 'ring-1 ring-zinc-400'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
              "
              @click="open = open === s.id ? null : s.id"
            >
              <div class="mb-1 flex items-center gap-2 font-sans text-xs leading-normal">
                <LinePill :book-id="bookId" :s="s" :color="colorOf(s.speaker)" />
                <span
                  v-if="cast.find((c) => c.name === s.speaker)?.isNew"
                  class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                  >unreviewed</span
                >
                <span
                  v-if="s.audio.status === 'stale'"
                  class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                  data-tip="Edited after narration — audio no longer matches"
                  >audio stale</span
                >
                <span
                  v-if="s.flag"
                  class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                  :data-tip="`Flagged in the ledger: ${s.flag.note || s.flag.kind}`"
                  ><FlagIcon class="icon-sm" /> {{ s.flag.kind }}</span
                >
                <span v-if="s.direction" class="truncate italic text-zinc-500"
                  >— {{ s.direction }}</span
                >
                <span v-else class="italic text-zinc-300 dark:text-zinc-600">— no direction</span>
                <button
                  v-if="s.audio.duration"
                  class="icon-btn line-tool ml-auto shrink-0"
                  :class="onClip(s) ? 'icon-btn-play is-on' : focus === s.id && 'is-on'"
                  :aria-label="`${onClip(s) ? 'Pause' : 'Play'} ${s.speaker}’s line ${s.id}`"
                  :data-tip="`Play the chapter from this line (p) · ${secs(s.audio.duration)}`"
                  @click.stop="playLine(s)"
                >
                  <component :is="onClip(s) ? PauseIcon : PlayIcon" class="icon-sm icon-fill" />
                </button>
              </div>
              <p :class="s.type === 'thought' ? 'italic text-zinc-600 dark:text-zinc-300' : ''">
                <template v-if="s.type === 'dialogue'"
                  >‘<ExpressionText :book-id="bookId" :segment="s" />’</template
                ><template v-else><ExpressionText :book-id="bookId" :segment="s" /></template>
              </p>
            </div>
            <!-- the detector disagrees with this line's type -->
            <div
              v-if="s.siteCheck && !s.fallback"
              class="-mt-2 mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-sky-200 bg-sky-50 px-2 py-1 font-sans text-[11px] leading-normal text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200"
              role="note"
            >
              <SiteCheckIcon class="icon-sm shrink-0" />
              <span class="min-w-0 flex-1"
                ><b>{{
                  s.siteCheck.suggest === "watermark" ? "Looks like site text" : "Reads like story"
                }}</b>
                — {{ s.siteCheck.why }}</span
              >
              <button
                class="btn-ghost btn-xs"
                :data-tip="
                  s.siteCheck.suggest === 'watermark'
                    ? 'Mark it as site text — kept in the script, left out of the audio'
                    : 'Read it as narration'
                "
                @click.stop="scriptsStore.acceptSiteCheck(bookId, chapterId, s.id)"
              >
                Accept
              </button>
              <button
                class="btn-ghost btn-xs"
                :data-tip="`Keep it as ${TYPE_LABEL[s.type].toLowerCase()} and drop the suggestion`"
                @click.stop="scriptsStore.dismissSiteCheck(bookId, chapterId, s.id)"
              >
                Dismiss
              </button>
            </div>
            <SegmentEditor
              v-if="open === s.id"
              :book-id="bookId"
              :chapter-id="chapterId"
              :segment="s"
            />
            <div
              v-if="s.pause != null && nextOf(s)"
              class="-mt-1 mb-3 flex items-center gap-2 font-sans text-[10px] leading-none text-zinc-400"
            >
              <span class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800"></span>
              <button
                class="chip"
                :data-tip="`this line sets its own pause instead of the book's ${secs(bookGap(s))} — click to clear it`"
                @click="setPause(s, null)"
              >
                <PauseIcon class="icon-sm icon-fill" />
                {{ s.pause === 0 ? "runs straight on" : secs(s.pause) + " pause" }}
              </button>
              <span class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800"></span>
            </div>
          </template>
          <div v-if="!rows.length" class="py-10 text-center text-sm text-zinc-500">
            {{
              segments.length
                ? "Nothing matches this filter."
                : "This chapter's script has no lines."
            }}
          </div>
        </div>
      </div>
      <div
        v-if="!history"
        class="hidden border-t border-zinc-200 px-6 py-1 font-sans text-[11px] text-zinc-400 xl:block dark:border-zinc-800"
      >
        <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">j</kbd>/<kbd
          class="rounded bg-zinc-100 px-1 dark:bg-zinc-800"
          >k</kbd
        >
        move · <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">↵</kbd> edit ·
        <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">1</kbd>–<kbd
          class="rounded bg-zinc-100 px-1 dark:bg-zinc-800"
          >9</kbd
        >
        assign speaker
        <span class="ml-1"
          >(<template v-for="(c, i) in inChapter.slice(0, 9)" :key="c.name"
            ><span v-if="i" class="mx-0.5">·</span><b>{{ i + 1 }}</b>
            {{ c.name.split(" ")[0] }}</template
          >)</span
        >
        ·
        <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">[</kbd>/<kbd
          class="rounded bg-zinc-100 px-1 dark:bg-zinc-800"
          >]</kbd
        >
        pause · <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">s</kbd> split ·
        <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">m</kbd> join with next ·
        <kbd class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">c</kbd> cast
      </div>
    </div>

    <ChapterCastRail
      v-if="reader.showCast"
      v-model:speaker="speaker"
      :book-id="bookId"
      :chapter-id="chapterId"
      :book-counted="!bookScripts.loading.value && !bookScripts.failed.value.length"
      :book-unread="bookScripts.failed.value.length"
      @retry="bookScripts.retry()"
    />
  </div>
</template>
