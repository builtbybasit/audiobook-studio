<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";

// Script reader: narration flows as prose; dialogue and thought are lifted into cards with a
// speaker pill and the voice direction. Right rail (toggleable) = the cast *in this chapter* with
// aliases, spoiler-hidden descriptions and inline rename/merge; the rest of the cast is collapsed.
// Any segment can be clicked to edit speaker / type / direction in place. Typography via the Aa menu.
// The model's segment boundaries are not always right — two speakers in one segment, or a sentence cut
// in half — so the editor can split a segment at any word gap (click the gap; sentence ends are marked)
// and join it with its neighbour. Both invalidate the audio they touch and both are undoable.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useScript, TYPES } from "@/views/scripting/shared";
import { directionOptions } from "@/lib/bulk";
import { useReader } from "@/stores/reader";
import ReaderSettings from "@/components/ReaderSettings.vue";
import VoicePicker from "@/components/VoicePicker.vue";
import ExpressionText from "@/components/ExpressionText.vue";
import ExpressionEditor from "@/components/ExpressionEditor.vue";
import { PAUSE_STEPS, defaultPause, pauseAfter, secs } from "@/lib/speech";
import {
  AudioLines as NarrationIcon,
  ChevronUp as ChevronUpIcon,
  ChevronDown as ChevronDownIcon,
  PanelRightClose as HideCastIcon,
  Maximize2 as FocusIcon,
  Minimize2 as ExitFocusIcon,
  Flag as FlagIcon,
  Pause as PauseIcon,
  RotateCcw as RetryIcon,
  Scissors as SplitIcon,
  TriangleAlert as WarnIcon,
  Users as CastIcon,
} from "@lucide/vue";
import { UiSelect, UiCombobox, UiToggleGroup, UiTooltip, UiSwitch } from "@/ui";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import type { Character, Gender, Segment, SegmentType } from "@/types";
const typeOpts = TYPES.map((t) => ({ value: t, label: t }));
const speakerOpts = computed(() => [
  ...inChapter.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    group: "In this chapter",
    hint: counts.value[c.name] + " lines",
    keywords: c.aliases.join(" "),
  })),
  ...rest.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    group: "Rest of cast",
    keywords: c.aliases.join(" "),
  })),
]);
const filterOpts = computed(() => [
  { value: "", label: "All speakers" },
  ...inChapter.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    hint: counts.value[c.name] + "",
  })),
]);

const props = withDefaults(
  defineProps<{ bookId: string; chapterId: number; focusMode?: boolean }>(),
  { focusMode: false },
);
const emit = defineEmits<{ "toggle-focus": [] }>();
const { segments, cast, counts, inChapter, colorOf } = useScript(props);
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();
const scriptsStore = useScriptsStore();
const reader = useReader();
const volume = computed(() => libraryStore.volumeOf(props.bookId, props.chapterId));
const multiVolume = computed(() => libraryStore.volumesOf(props.bookId).length > 1);

const mode = ref("all"); // all | dialogue
const warnOpen = ref(false); // the unverified-chunk banner reads as one line until asked
const speaker = ref(""); // '' = everyone
const open = ref<number | null>(null);
const showRest = ref(false);
const revealed = ref(new Set<string>());
const editingName = ref<string | null>(null);
const draft = ref("");

const rows = computed(() =>
  segments.value.filter(
    (s) =>
      (mode.value === "all" || s.type !== "narration") &&
      (!speaker.value || s.speaker === speaker.value),
  ),
);
const rest = computed(() => cast.value.filter((c) => !counts.value[c.name]));
const chapter = computed(() => libraryStore.chapter(props.bookId, props.chapterId)!);
const chars = computed(() => segments.value.reduce((a, s) => a + s.text.length, 0));

function jumpToSpeaker(name: string) {
  speaker.value = speaker.value === name ? "" : name;
}
function startRename(c: Character) {
  editingName.value = c.name;
  draft.value = c.name;
}
function commitRename() {
  if (editingName.value) castStore.renameCharacter(props.bookId, editingName.value, draft.value);
  editingName.value = null;
}
function nextNew() {
  const s = segments.value.find((s) => cast.value.find((c) => c.name === s.speaker)?.isNew);
  if (s) {
    open.value = s.id;
    document.getElementById("seg-" + s.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
const unresolved = computed(() => inChapter.value.filter((c) => c.isNew).length);
const fallbacks = computed(() => segments.value.filter((s) => s.fallback));
const route = useRoute();

// directions: presets + everything already used in this book, free text allowed
const dirOpts = computed(() => directionOptions(scriptsStore.segments, props.bookId));
// ---- segment boundaries: split at a word gap, join with a neighbour
const splitting = ref<number | null>(null);
interface Tok {
  text: string;
  /** offset of the gap *before* this token */
  at: number;
  /** the previous token ended a sentence — the likely cut */
  strong: boolean;
}
function tokensOf(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /\S+\s*/g;
  let m: RegExpExecArray | null;
  let strong = false;
  while ((m = re.exec(text))) {
    out.push({ text: m[0], at: m.index, strong });
    strong = /[.!?…][”’"')\]]?\s*$/.test(m[0]);
  }
  return out;
}
const at = (id: number) => segments.value.findIndex((x) => x.id === id);
const nextOf = (s: Segment): Segment | undefined => segments.value[at(s.id) + 1];
const prevOf = (s: Segment): Segment | undefined => segments.value[at(s.id) - 1];
const preview = (t: string, n = 42) => (t.length > n ? t.slice(0, n) + "…" : t);
function doSplit(s: Segment, offset: number) {
  const id = scriptsStore.splitSegment(props.bookId, props.chapterId, s.id, offset);
  splitting.value = null;
  if (id == null) return;
  // the second half is the one that usually needs a different speaker — open it
  open.value = id;
  focus.value = id;
  nextTick(() =>
    document.getElementById("seg-" + id)?.scrollIntoView({ block: "center", behavior: "smooth" }),
  );
}
function doJoin(s: Segment, dir: "next" | "prev") {
  const first = dir === "next" ? s : prevOf(s);
  if (!first || !nextOf(first)) return;
  if (scriptsStore.joinSegments(props.bookId, props.chapterId, first.id)) {
    open.value = first.id;
    focus.value = first.id;
  }
}

// ---- pacing: how long the book holds after this line. Silence is stitched, not rendered, so a
// pause changes the chapter's length without invalidating a single clip.
const pacing = computed(() => castStore.pacingOf(props.bookId));
const gapOf = (s: Segment) => pauseAfter(s, nextOf(s), pacing.value);
const bookGap = (s: Segment) => defaultPause(s, nextOf(s), pacing.value);
const setPause = (s: Segment, v: number | null) =>
  castStore.setPause(props.bookId, props.chapterId, s.id, v);

const GENDER_LABEL: Partial<Record<Gender, string>> = { m: "male", f: "female", n: "neutral" };
const sameSpeakerCount = (s: Segment) =>
  segments.value.filter((x) => x.speaker === s.speaker && x.id !== s.id).length;

// stale nudge: lines whose audio is out of date — edited after narration, or a half of a split that
// has never been rendered at all (only counts once the chapter has audio)
const stale = computed(
  () =>
    segments.value.filter(
      (s) =>
        s.audio.status === "stale" ||
        (chapter.value.narration !== "none" && s.audio.status === "none"),
    ).length,
);
const edits = computed(() => segments.value.filter((s) => s.edited).length);

// re-script: run the LLM again on this chapter, optionally re-applying manual edits; then show the diff
const rescriptOpen = ref(false);
const keepEdits = ref(true);
const diff = computed(() => scriptsStore.scriptDiff(props.bookId, props.chapterId));
const showDiff = ref(true);
function rescript() {
  rescriptOpen.value = false;
  scriptingStore.runScripting(props.bookId, [props.chapterId], { keepEdits: keepEdits.value });
}
function jumpTo(id: number) {
  focus.value = id;
  open.value = null;
  nextTick(() =>
    document.getElementById("seg-" + id)?.scrollIntoView({ block: "center", behavior: "smooth" }),
  );
}

// keyboard: j/k or ↑/↓ move, Enter edit, Esc close, 1–9 assign speaker (in-chapter order), c toggles cast
const focus = ref<number | null>(null);
function moveFocus(d: number) {
  const ids = rows.value.map((r) => r.id);
  const i = focus.value == null ? -1 : ids.indexOf(focus.value);
  focus.value = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + d))] ?? null;
  document
    .getElementById("seg-" + focus.value)
    ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t.closest('[data-expression-editor], [role="dialog"]')) return;
  // inside a field: let the widget (combobox/select) handle Escape itself; a second Escape closes the editor
  if (
    ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) ||
    t.isContentEditable ||
    t.closest?.("[role=listbox],[role=option]")
  ) {
    if (e.key === "Escape" && t.getAttribute("role") !== "combobox") t.blur();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "j") {
    e.preventDefault();
    moveFocus(1);
  } else if (e.key === "ArrowUp" || e.key === "k") {
    e.preventDefault();
    moveFocus(-1);
  } else if (e.key === "Enter" && focus.value) {
    open.value = open.value === focus.value ? null : focus.value;
  } else if (e.key === "Escape") {
    if (open.value || splitting.value) {
      open.value = null;
      splitting.value = null;
    } else if (props.focusMode) emit("toggle-focus");
  } else if (e.key === "s" && focus.value) {
    splitting.value = splitting.value === focus.value ? null : focus.value;
    open.value = null;
  } else if (e.key === "m" && focus.value) {
    const s = segments.value.find((x) => x.id === focus.value);
    if (s) doJoin(s, "next");
  } else if ((e.key === "[" || e.key === "]") && focus.value) {
    const s = segments.value.find((x) => x.id === focus.value);
    if (s && nextOf(s)) {
      const v = Math.max(0, Math.round((gapOf(s) + (e.key === "]" ? 0.25 : -0.25)) * 100) / 100);
      setPause(s, v === bookGap(s) ? null : v);
    }
  } else if (e.key === "c") {
    reader.showCast = !reader.showCast;
  } else if (e.key === "f") {
    emit("toggle-focus");
  } else if (e.key === "/" && !e.shiftKey) {
    e.preventDefault();
    document.querySelector<HTMLInputElement>('input[placeholder^="Find chapter"]')?.focus();
  } else if (/^[1-9]$/.test(e.key) && focus.value) {
    const c = inChapter.value[Number(e.key) - 1];
    if (c) scriptsStore.setSpeaker(props.bookId, props.chapterId, focus.value, c.name);
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  if (route.query.seg) jumpTo(Number(route.query.seg));
});
onUnmounted(() => window.removeEventListener("keydown", onKey));
watch(
  () => route.query.seg,
  (v) => {
    if (v) jumpTo(Number(v));
  },
);
watch(open, (v) => {
  if (v) focus.value = v;
});
</script>

<template>
  <div
    class="grid h-full gap-4"
    :class="reader.showCast ? 'lg:grid-cols-[1fr_300px]' : 'grid-cols-1'"
  >
    <!-- reader -->
    <div class="card flex min-h-0 min-w-0 flex-col">
      <div class="border-b border-zinc-200 px-4 pb-3 pt-4 sm:px-6 dark:border-zinc-800">
        <div class="flex flex-wrap items-start gap-2">
          <div class="min-w-[200px] flex-1">
            <div class="label">
              <span v-if="multiVolume">{{ volume?.name }} · </span>Chapter {{ chapter.id
              }}<span
                v-if="multiVolume"
                class="font-normal normal-case tracking-normal text-zinc-400"
              >
                (ch. {{ chapter.volumeIndex }} of this volume)</span
              >
            </div>
            <h2 class="truncate font-serif text-2xl">{{ chapter.title }}</h2>
            <div class="mt-0.5 text-xs text-zinc-500">
              {{ segments.length }} segments · {{ inChapter.length }} speakers ·
              {{ (chars / 1000).toFixed(1) }}k chars ·
              <span class="font-mono">chapter_{{ String(chapter.id).padStart(3, "0") }}.json</span>
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
            <PopoverTrigger class="btn-ghost btn-xs" title="run the LLM again on this chapter"
              ><RetryIcon class="icon-sm" /> Re-script</PopoverTrigger
            >
            <PopoverPortal>
              <PopoverContent :side-offset="6" align="end" class="ui-popup w-80 p-3 text-xs">
                <div class="label mb-2">Re-script chapter {{ chapter.id }}</div>
                <div class="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
                  <span class="text-zinc-500">Profile</span
                  ><UiSelect
                    v-model="scriptingStore.scriptSettings.profile"
                    :options="
                      endpointsStore.profiles.map((p) => ({
                        value: p.id,
                        label: p.name,
                        hint: p.model,
                      }))
                    "
                    size="xs"
                    block
                  />
                  <span class="text-zinc-500">Chunking</span>
                  <span class="text-zinc-400">Uses this endpoint’s request settings.</span>
                </div>
                <div class="mt-2 rounded-md bg-zinc-50 p-2 dark:bg-zinc-800/60">
                  <template v-if="edits"
                    ><UiSwitch
                      v-model="keepEdits"
                      :label="`keep my ${edits} manual edit${edits === 1 ? '' : 's'}`"
                    />
                    <div class="mt-1 text-[11px] text-zinc-500">
                      {{
                        keepEdits
                          ? "Speaker, type, direction and expression annotations are re-applied where the text still matches."
                          : "Your edits are discarded — the new run wins."
                      }}
                    </div></template
                  >
                  <div v-else class="text-[11px] text-zinc-500">
                    No manual edits in this chapter.
                  </div>
                </div>
                <div class="mt-1 text-[11px] text-zinc-500">
                  <template v-if="segments.some((s) => s.audio.duration)"
                    >Narrated audio is kept; lines whose speaker or direction change become
                    stale.</template
                  >
                  A “what changed” panel appears when it finishes.
                </div>
                <div class="mt-3 flex justify-end gap-2">
                  <button class="btn-ghost btn-xs" @click="rescriptOpen = false">Cancel</button
                  ><button class="btn-primary btn-xs" @click="rescript">Re-script now</button>
                </div>
              </PopoverContent>
            </PopoverPortal>
          </PopoverRoot>
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
            :title="focusMode ? 'Exit reader focus mode (Esc or F)' : 'Focus the reader (F)'"
            @click="emit('toggle-focus')"
          >
            <component :is="focusMode ? ExitFocusIcon : FocusIcon" class="icon-sm" />
            {{ focusMode ? "Exit focus" : "Focus reader" }}
          </button>
          <ReaderSettings />
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <UiToggleGroup
            v-model="mode"
            :options="[
              { value: 'all', label: 'Everything' },
              { value: 'dialogue', label: 'Dialogue only' },
            ]"
          />
          <UiSelect v-model="speaker" :options="filterOpts" size="xs" class="w-40" />
          <span class="ml-auto whitespace-nowrap text-[11px] text-zinc-400"
            >{{ rows.length }} shown · click any line to edit</span
          >
        </div>
      </div>

      <div
        v-if="fallbacks.length"
        class="border-b border-amber-300 bg-amber-400/10 text-xs text-amber-700 dark:border-amber-500/40 dark:text-amber-300"
      >
        <div class="flex items-center gap-3 px-6 py-1.5">
          <button
            class="flex min-w-0 flex-1 items-center gap-3 text-left"
            :aria-expanded="warnOpen"
            :title="warnOpen ? 'hide the detail' : 'what this means'"
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
        v-if="stale"
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
        v-if="diff && showDiff"
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
      <div class="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6">
        <div
          class="mx-auto"
          :class="[reader.widthClass, reader.fontClass]"
          :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }"
        >
          <template v-for="s in rows" :key="s.id">
            <div
              v-if="splitting === s.id"
              class="mb-1 flex flex-wrap items-center gap-2 rounded-md bg-violet-50 px-2 py-1 font-sans text-[11px] leading-normal text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
            >
              <b>Click the gap where this segment should be cut.</b>
              <span class="text-violet-500/70">⁄ marks the end of a sentence.</span>
              <button class="ml-auto underline" @click="splitting = null">Cancel</button>
            </div>
            <!-- unverified chunk kept whole -->
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
                  <button class="btn-ghost btn-xs" @click="splitting = s.id">
                    <SplitIcon class="icon-sm" /> Split by hand
                  </button>
                </template>
              </div>
              <p class="text-zinc-700 dark:text-zinc-300">
                <template v-if="splitting === s.id"
                  ><span v-for="(t, i) in tokensOf(s.text)" :key="i"
                    ><button
                      v-if="i"
                      class="split-gap"
                      :class="t.strong && 'split-gap-strong'"
                      :title="`cut here — the new segment starts “${preview(s.text.slice(t.at), 30)}”`"
                      @click.stop="doSplit(s, t.at)"
                    >
                      ⁄</button
                    >{{ t.text }}</span
                  ></template
                ><template v-else><ExpressionText :book-id="bookId" :segment="s" /></template>
              </p>
              <details class="mt-2 font-sans text-[11px] leading-normal text-zinc-500">
                <summary class="cursor-pointer">Why it failed</summary>
                <div class="mt-1 rounded bg-white p-2 font-mono dark:bg-zinc-900">
                  verify: reconstructed text diverged near
                  <span class="bg-red-500/15 text-red-600">“{{ s.fallbackMismatch }}…”</span> after
                  2 retries → kept chunk whole (no prose dropped)
                </div>
              </details>
            </div>
            <!-- narration: plain prose -->
            <p
              v-else-if="s.type === 'narration'"
              :id="'seg-' + s.id"
              class="-mx-2 mb-3 cursor-text rounded px-2 py-0.5 transition-colors"
              :class="
                open === s.id
                  ? 'bg-violet-50 ring-1 ring-violet-300 dark:bg-violet-500/10 dark:ring-violet-500/40'
                  : focus === s.id
                    ? 'ring-1 ring-zinc-400'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              "
              @click="open = open === s.id ? null : s.id"
            >
              <template v-if="splitting === s.id"
                ><span v-for="(t, i) in tokensOf(s.text)" :key="i"
                  ><button
                    v-if="i"
                    class="split-gap"
                    :class="t.strong && 'split-gap-strong'"
                    :title="`cut here — the new segment starts “${preview(s.text.slice(t.at), 30)}”`"
                    @click.stop="doSplit(s, t.at)"
                  >
                    ⁄</button
                  >{{ t.text }}</span
                ></template
              ><template v-else><ExpressionText :book-id="bookId" :segment="s" /></template
              ><span
                v-if="s.flag"
                class="ml-2 rounded bg-amber-400/20 px-1 font-sans text-[10px] font-semibold leading-none text-amber-700 dark:text-amber-300"
                :title="s.flag.note"
                ><FlagIcon class="icon-sm" /> {{ s.flag.kind }}</span
              ><span
                v-if="s.direction"
                class="ml-2 font-sans text-[11px] leading-none text-violet-500/80"
                >[{{ s.direction }}]</span
              >
            </p>
            <!-- dialogue / thought: card -->
            <div
              v-else
              :id="'seg-' + s.id"
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
                <span
                  class="rounded-full px-2 py-0.5 font-medium"
                  :style="{ background: colorOf(s.speaker) + '33', color: colorOf(s.speaker) }"
                >
                  <span class="opacity-70">{{ s.type === "thought" ? "…" : "“" }}</span>
                  {{ s.speaker }}
                </span>
                <span
                  v-if="cast.find((c) => c.name === s.speaker)?.isNew"
                  class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                  >unreviewed</span
                >
                <span
                  v-if="s.audio.status === 'stale'"
                  class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                  title="Edited after narration — audio no longer matches"
                  >audio stale</span
                >
                <span
                  v-if="s.flag"
                  class="rounded bg-amber-400/20 px-1 text-[10px] font-semibold text-amber-600"
                  :title="`Flagged in the ledger: ${s.flag.note || s.flag.kind}`"
                  ><FlagIcon class="icon-sm" /> {{ s.flag.kind }}</span
                >
                <span v-if="s.direction" class="truncate italic text-zinc-500"
                  >— {{ s.direction }}</span
                >
                <span v-else class="italic text-zinc-300 dark:text-zinc-600">— no direction</span>
              </div>
              <p :class="s.type === 'thought' ? 'italic text-zinc-600 dark:text-zinc-300' : ''">
                <template v-if="splitting === s.id"
                  ><span v-for="(t, i) in tokensOf(s.text)" :key="i"
                    ><button
                      v-if="i"
                      class="split-gap"
                      :class="t.strong && 'split-gap-strong'"
                      :title="`cut here — the new segment starts “${preview(s.text.slice(t.at), 30)}”`"
                      @click.stop="doSplit(s, t.at)"
                    >
                      ⁄</button
                    >{{ t.text }}</span
                  ></template
                ><template v-else-if="s.type === 'dialogue'"
                  >‘<ExpressionText :book-id="bookId" :segment="s" />’</template
                ><template v-else><ExpressionText :book-id="bookId" :segment="s" /></template>
              </p>
            </div>
            <!-- inline editor -->
            <div
              v-if="open === s.id"
              class="-mt-1 mb-4 grid grid-cols-2 items-end gap-2 rounded-md border border-violet-300 bg-white p-2 font-sans text-xs leading-normal 2xl:grid-cols-[1fr_1fr_2fr_auto] dark:border-violet-500/40 dark:bg-zinc-900"
              @click.stop
            >
              <label
                >Speaker<UiCombobox
                  :model-value="s.speaker"
                  :options="speakerOpts"
                  size="xs"
                  class="mt-1"
                  block
                  @update:model-value="
                    (v) => scriptsStore.setSpeaker(bookId, chapterId, s.id, String(v))
                  "
              /></label>
              <label
                >Type<UiSelect
                  :model-value="s.type"
                  :options="typeOpts"
                  size="xs"
                  class="mt-1"
                  block
                  @update:model-value="
                    (v) =>
                      scriptsStore.updateSegment(bookId, chapterId, s.id, {
                        type: v as SegmentType,
                      })
                  "
              /></label>
              <label class="col-span-2 2xl:col-span-1"
                >Direction <span class="text-zinc-400">— pick or type your own</span>
                <div class="mt-1 flex items-center gap-1">
                  <UiCombobox
                    :model-value="s.direction"
                    :options="dirOpts"
                    custom
                    placeholder="e.g. whispered, hesitant"
                    size="xs"
                    class="min-w-0 flex-1"
                    block
                    @update:model-value="
                      (v) =>
                        scriptsStore.updateSegment(bookId, chapterId, s.id, {
                          direction: String(v),
                        })
                    "
                  />
                  <UiTooltip
                    :text="`Set “${s.direction || '—'}” on every ${s.speaker} line in this chapter (${sameSpeakerCount(s)} more)`"
                    ><button
                      class="btn-ghost btn-xs whitespace-nowrap"
                      :disabled="!s.direction || !sameSpeakerCount(s)"
                      @click="
                        scriptsStore.applyDirection(bookId, chapterId, s.speaker, s.direction)
                      "
                    >
                      → all {{ s.speaker.split(" ")[0] }}
                    </button></UiTooltip
                  >
                </div>
              </label>
              <div class="flex items-center gap-2 justify-self-end">
                <span v-if="s.edited" class="text-[10px] text-zinc-400">edited</span
                ><button class="btn-ghost btn-xs" @click="open = null">Done</button>
              </div>
              <ExpressionEditor
                :book-id="bookId"
                :chapter-id="chapterId"
                :segment="s"
                class="col-span-2 border-t border-zinc-200 pt-2 2xl:col-span-4 dark:border-zinc-800"
              />
              <!-- boundaries: the model grouped two speakers together, or cut a sentence in half -->
              <div
                class="col-span-2 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-2 2xl:col-span-4 dark:border-zinc-800"
              >
                <span class="text-zinc-400">Boundaries</span>
                <UiTooltip
                  text="Cut this segment in two — then give the second half its own speaker (s)"
                  ><button class="btn-ghost btn-xs" @click="((open = null), (splitting = s.id))">
                    <SplitIcon class="icon-sm" /> Split…
                  </button></UiTooltip
                >
                <UiTooltip
                  v-if="prevOf(s)"
                  :text="`Join into #${prevOf(s)!.id} (${prevOf(s)!.speaker}): “…${preview(prevOf(s)!.text.slice(-40), 40)}”${prevOf(s)!.speaker === s.speaker ? '' : ' — both halves would be read by ' + prevOf(s)!.speaker}`"
                  ><button class="btn-ghost btn-xs" @click="doJoin(s, 'prev')">
                    <ChevronUpIcon class="icon-sm" /> Join up
                  </button></UiTooltip
                >
                <UiTooltip
                  v-if="nextOf(s)"
                  :text="`Join #${nextOf(s)!.id} (${nextOf(s)!.speaker}) into this one: “${preview(nextOf(s)!.text)}”${nextOf(s)!.speaker === s.speaker ? '' : ' — both halves would be read by ' + s.speaker}`"
                  ><button class="btn-ghost btn-xs" @click="doJoin(s, 'next')">
                    <ChevronDownIcon class="icon-sm" /> Join next (m)
                  </button></UiTooltip
                >
                <span
                  v-if="nextOf(s) && nextOf(s)!.speaker !== s.speaker"
                  class="text-[10px] text-zinc-400"
                  >next line is {{ nextOf(s)!.speaker }}</span
                >
                <span v-if="s.audio.duration" class="ml-auto text-[10px] text-amber-600"
                  >either one makes this line's audio stale</span
                >
              </div>
              <!-- pacing: silence after this line. Stitched at build time, so no clip is invalidated. -->
              <div
                v-if="nextOf(s)"
                class="col-span-2 flex flex-wrap items-center gap-1.5 border-t border-zinc-200 pt-2 2xl:col-span-4 dark:border-zinc-800"
              >
                <span class="text-zinc-400">Pause after</span>
                <button
                  v-for="v in PAUSE_STEPS"
                  :key="String(v)"
                  class="chip"
                  :class="(s.pause ?? null) === v && 'chip-on'"
                  @click="setPause(s, v)"
                >
                  {{ v === null ? `book · ${secs(bookGap(s))}` : v === 0 ? "run on" : secs(v) }}
                </button>
                <span class="ml-auto text-[10px] text-zinc-400"
                  >silence is stitched, not rendered — nothing goes stale
                  (<kbd>[</kbd>&nbsp;<kbd>]</kbd>)</span
                >
              </div>
            </div>
            <!-- a line that holds, or runs straight on, shown where the gap actually falls -->
            <div
              v-if="s.pause != null && nextOf(s)"
              class="-mt-1 mb-3 flex items-center gap-2 font-sans text-[10px] leading-none text-zinc-400"
            >
              <span class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800"></span>
              <button
                class="chip"
                :title="`this line sets its own pause instead of the book's ${secs(bookGap(s))} — click to clear it`"
                @click="setPause(s, null)"
              >
                <PauseIcon class="icon-sm icon-fill" />
                {{ s.pause === 0 ? "runs straight on" : secs(s.pause) + " pause" }}
              </button>
              <span class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800"></span>
            </div>
          </template>
          <div v-if="!rows.length" class="py-10 text-center text-sm text-zinc-500">
            Nothing matches this filter.
          </div>
        </div>
      </div>
      <div
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

    <!-- cast rail -->
    <div
      v-if="reader.showCast"
      class="card max-h-[50vh] min-h-0 overflow-y-auto overflow-x-hidden p-3 lg:max-h-none"
    >
      <div class="mb-2 flex items-center gap-2">
        <span class="label">In this chapter · {{ inChapter.length }} speakers</span>
        <button
          class="icon-btn ml-auto"
          title="hide the cast (c)"
          aria-label="Hide the cast"
          @click="reader.showCast = false"
        >
          <HideCastIcon class="icon-sm" />
        </button>
      </div>
      <div
        v-for="c in inChapter"
        :key="c.name"
        class="mb-2 rounded-lg border p-3 text-sm transition-colors"
        :class="[
          speaker === c.name
            ? 'border-violet-400 bg-violet-50 dark:bg-violet-500/10'
            : 'border-zinc-200 dark:border-zinc-800',
          c.isNew && 'border-dashed border-amber-400',
        ]"
      >
        <div class="flex items-center gap-2">
          <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: c.color }"></span>
          <input
            v-if="editingName === c.name"
            v-model="draft"
            class="input min-w-0 flex-1 py-0"
            autofocus
            @keydown.enter="commitRename"
            @keydown.esc="editingName = null"
            @blur="commitRename"
          />
          <button
            v-else
            class="min-w-0 flex-1 truncate text-left font-semibold"
            @click="jumpToSpeaker(c.name)"
            @dblclick="startRename(c)"
          >
            {{ c.name }}
          </button>
          <span class="text-[11px] text-zinc-400">{{ GENDER_LABEL[c.gender] ?? "unknown" }}</span>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-1 pl-4 text-[11px] text-zinc-500">
          <span>{{ counts[c.name] }} lines</span>
          <template v-if="c.aliases.length"
            ><span>· a.k.a.</span
            ><span
              v-for="a in c.aliases"
              :key="a"
              class="rounded bg-zinc-100 px-1 dark:bg-zinc-800"
              >{{ a }}</span
            ></template
          >
          <RouterLink
            v-if="c.isNew"
            :to="`/book/${bookId}/cast`"
            class="rounded bg-amber-400/20 px-1 font-semibold text-amber-600 hover:underline"
            title="review this name on the Cast page — rename it, or merge it into the speaker it belongs to"
            >new · alias?</RouterLink
          >
        </div>
        <div class="mt-2 pl-4 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
          <template v-if="!c.description"
            ><span class="italic text-zinc-400">No description yet.</span></template
          >
          <template v-else-if="revealed.has(c.name) || c.name === 'Narrator'">{{
            c.description
          }}</template>
          <button
            v-else
            class="rounded border border-dashed border-zinc-300 px-2 py-1 italic text-zinc-400 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
            @click="revealed = new Set([...revealed, c.name])"
          >
            description hidden — spoilers · show
          </button>
        </div>
        <div class="mt-2 flex items-center gap-1 pl-4 text-[11px]">
          <VoicePicker
            v-model="c.voice"
            :book-id="bookId"
            :speaker="c.name"
            size="xs"
            class="min-w-0 flex-1"
            block
          />
          <button
            class="shrink-0 rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            @click="startRename(c)"
          >
            rename
          </button>
        </div>
      </div>

      <button
        class="mt-1 w-full rounded-lg border border-dashed border-zinc-300 py-2 text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
        @click="showRest = !showRest"
      >
        {{ showRest ? "Hide" : "Show" }} the rest of the cast ({{ rest.length }})
      </button>
      <div v-if="showRest" class="mt-2 space-y-0.5">
        <div
          v-for="c in rest"
          :key="c.name"
          class="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span class="h-2 w-2 rounded-full" :style="{ background: c.color }"></span>
          <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
          <span class="font-mono text-zinc-400">{{
            scriptsStore.lineCounts(bookId)[c.name] ?? 0
          }}</span>
        </div>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-zinc-400">
        Click a name to filter the reader to their lines, double-click to rename, and set the voice
        it is read in right here. A speaker with no voice of their own borrows the Narrator’s.
      </p>
    </div>
  </div>
</template>
