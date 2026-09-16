<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// Script search across every scripted chapter of the book: text, speaker, direction. Results open the
// reader at that exact segment — and can be ticked instead, for a correction applied to many lines at
// once: change speaker, set or clear direction, flag for review. Selecting is not opening: the
// checkbox never navigates, and the row's link never selects.
//
// The selection is a set of segment keys, not a slice of what is on screen, so "select all matching"
// covers matches further down the list than the page shows. Changing the query or the filters throws
// the selection away rather than carry hidden lines into a correction.
import { computed, nextTick, ref, watch } from "vue";
import type { Component } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isScripted } from "@/lib/scriptReview";
import { UiCheckbox, UiSelect, UiToggleGroup } from "@/ui";
import { useFilter } from "reka-ui";
import { useBookId } from "@/composables/useBookId";
import {
  Flag as FlagIcon,
  Megaphone as DirectionIcon,
  SpellCheck as PronounceIcon,
  Undo2 as UndoIcon,
  UserRoundCog as SpeakerIcon,
  X as ClearIcon,
} from "@lucide/vue";
import StatusDot from "@/components/StatusDot.vue";
import BulkPanel from "@/views/search/BulkPanel.vue";
import PronunciationDialog from "@/views/search/PronunciationDialog.vue";
import DemoScenarios from "@/views/search/DemoScenarios.vue";
import type { BulkResult, BulkTarget, SearchScenario, Segment, UndoEntry } from "@/types";

const castStore = useCastStore();
const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const route = useRoute();
const router = useRouter();
const bookId = useBookId();
const q = ref(String(route.query.q ?? ""));
const speaker = ref(String(route.query.speaker ?? ""));
const type = ref("all");
watch(
  () => route.query.q,
  (v) => {
    if (v != null) q.value = String(v);
  },
);
watch(q, (v) => router.replace({ query: { ...route.query, q: v || undefined } }));
watch(
  () => route.query.speaker,
  (v) => {
    speaker.value = String(v ?? "");
  },
);
watch(speaker, (v) => router.replace({ query: { ...route.query, speaker: v || undefined } }));
const { contains } = useFilter({ sensitivity: "base" });
const cast = computed(() => castStore.charactersOf(bookId));
const speakerOpts = computed(() => [
  { value: "", label: "Any speaker" },
  ...cast.value.map((c) => ({ value: c.name, label: c.name, color: c.color })),
]);
const results = computed(() => {
  const s = q.value.trim();
  const out = [];
  for (const c of libraryStore.chaptersOf(bookId).filter(isScripted)) {
    const hits = scriptsStore
      .segmentsOf(bookId, c.id)
      .filter(
        (x) =>
          (!speaker.value || x.speaker === speaker.value) &&
          (type.value === "all" || x.type === type.value) &&
          (!s || contains(x.text, s) || contains(x.direction ?? "", s) || contains(x.speaker, s)),
      );
    if (hits.length) out.push({ chapter: c, hits });
  }
  return out;
});
const total = computed(() => results.value.reduce((a, r) => a + r.hits.length, 0));

// ---------- what is on screen ----------
// Results are shown a page at a time; the counts and every "select all" always speak for the whole
// match set, never for the page.
const PAGE = 40;
const shown = ref(PAGE);
const pages = computed(() => {
  let left = shown.value;
  const out: {
    chapter: (typeof results.value)[number]["chapter"];
    hits: Segment[];
    hidden: number;
  }[] = [];
  for (const r of results.value) {
    if (left <= 0) break;
    const hits = r.hits.slice(0, left);
    left -= hits.length;
    out.push({ chapter: r.chapter, hits, hidden: r.hits.length - hits.length });
  }
  return out;
});
const onScreen = computed(() => pages.value.reduce((a, r) => a + r.hits.length, 0));

// ---------- selection ----------
const selected = ref(new Set<string>());
const keyOf = (chId: number, segId: number) => `${chId}:${segId}`;
const isOn = (chId: number, segId: number) => selected.value.has(keyOf(chId, segId));
const targets = computed<BulkTarget[]>(() =>
  [...selected.value]
    .map((k) => {
      const [chId, segId] = k.split(":");
      return { chId: Number(chId), segId: Number(segId) };
    })
    .sort((a, b) => a.chId - b.chId || a.segId - b.segId),
);
const selectedChapters = computed(() => new Set(targets.value.map((t) => t.chId)).size);
/** what changed last, for the screen reader and the strip under the search box */
const announcement = ref("");

function set(keys: string[], on: boolean) {
  const next = new Set(selected.value);
  for (const k of keys) {
    if (on) next.add(k);
    else next.delete(k);
  }
  selected.value = next;
}
const toggleLine = (chId: number, segId: number) => set([keyOf(chId, segId)], !isOn(chId, segId));
const chapterKeys = (chId: number) =>
  (results.value.find((r) => r.chapter.id === chId)?.hits ?? []).map((s) => keyOf(chId, s.id));
function chapterState(chId: number): boolean | "indeterminate" {
  const keys = chapterKeys(chId);
  const n = keys.filter((k) => selected.value.has(k)).length;
  return n === 0 ? false : n === keys.length ? true : "indeterminate";
}
function toggleChapter(chId: number) {
  const keys = chapterKeys(chId);
  set(keys, chapterState(chId) !== true);
}
const allKeys = computed(() =>
  results.value.flatMap((r) => r.hits.map((s) => keyOf(r.chapter.id, s.id))),
);
const allState = computed<boolean | "indeterminate">(() => {
  if (!allKeys.value.length) return false;
  const n = allKeys.value.filter((k) => selected.value.has(k)).length;
  return n === 0 ? false : n === allKeys.value.length ? true : "indeterminate";
});
function selectAll() {
  set(allKeys.value, true);
  announcement.value = `${allKeys.value.length} matching lines selected, including ${Math.max(0, total.value - onScreen.value)} not on screen.`;
}
function clearSelection() {
  const n = selected.value.size;
  selected.value = new Set();
  panel.value = null; // a panel with nothing selected has nothing to say
  announcement.value = n ? `Selection cleared — ${n} line${n === 1 ? "" : "s"}.` : "";
}

// a different query or filter means a different match set: the old selection is dropped rather than
// carried along invisibly
const criteria = computed(() => JSON.stringify([q.value.trim(), speaker.value, type.value]));
watch(criteria, () => {
  shown.value = PAGE;
  panel.value = null;
  if (!selected.value.size) return;
  const n = selected.value.size;
  selected.value = new Set();
  announcement.value = `Selection cleared: the search changed, so the ${n} selected line${n === 1 ? "" : "s"} no longer apply.`;
  uiStore.toast(`Selection cleared — ${n} line${n === 1 ? "" : "s"}`, {
    kind: "info",
    description: "The search changed, so nothing stays selected out of sight.",
    timeout: 4000,
  });
});

// ---------- corrections ----------
// The bar's three actions open one panel, in place, under the buttons. Re-pressing the same button
// closes it, and closing puts the focus back where it came from.
type BulkKind = "speaker" | "direction" | "flag";
const ACTIONS: { kind: BulkKind; label: string; icon: Component }[] = [
  { kind: "speaker", label: "Change speaker…", icon: SpeakerIcon },
  { kind: "direction", label: "Direction…", icon: DirectionIcon },
  { kind: "flag", label: "Flag for review…", icon: FlagIcon },
];
const panel = ref<BulkKind | null>(null);
let opener: HTMLElement | null = null;
function openPanel(kind: BulkKind, e: MouseEvent) {
  if (panel.value === kind) return closePanel();
  opener = e.currentTarget as HTMLElement;
  panel.value = kind;
}
function closePanel() {
  panel.value = null;
  nextTick(() => opener?.focus());
}
const pronounce = ref(false);
const last = ref<{ result: BulkResult; entry: UndoEntry | null } | null>(null);
const undoable = computed(() => uiStore.undoPending(last.value?.entry ?? null));

function applied(result: BulkResult) {
  last.value = { result, entry: result.entry };
  panel.value = null;
  clearSelection();
  announcement.value = `${result.label}: ${result.changed} line${result.changed === 1 ? "" : "s"} changed.`;
}
function undo() {
  if (!last.value?.entry) return;
  uiStore.revertEntry(last.value.entry);
  announcement.value = `Undone: ${last.value.result.label}.`;
}

function resetScenario() {
  clearSelection();
  last.value = null;
}
function runScenario(s: SearchScenario) {
  clearSelection();
  last.value = null;
  q.value = s.query;
  speaker.value = s.speaker;
  type.value = s.type;
  nextTick(() => (shown.value = PAGE));
}

// ---------- display helpers ----------
function mark(text: string): { t: string; hit?: boolean }[] {
  const s = q.value.trim();
  if (!s) return [{ t: text }];
  const parts: { t: string; hit?: boolean }[] = [];
  let i = 0;
  const lower = text.toLowerCase(),
    needle = s.toLowerCase();
  while (i < text.length) {
    const j = lower.indexOf(needle, i);
    if (j < 0) {
      parts.push({ t: text.slice(i) });
      break;
    }
    if (j > i) parts.push({ t: text.slice(i, j) });
    parts.push({ t: text.slice(j, j + s.length), hit: true });
    i = j + s.length;
  }
  return parts;
}
const colorOf = (n: string) => cast.value.find((c) => c.name === n)?.color ?? "#71717a";
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
    <div class="flex flex-wrap items-start gap-2">
      <div class="min-w-0 flex-1">
        <h1 class="text-2xl font-semibold">Search the script</h1>
        <p class="text-sm text-zinc-500">
          Every line of {{ libraryStore.bookById(bookId)?.title }} that has been scripted — text,
          speaker or direction. Tick lines to correct them together.
        </p>
      </div>
      <DemoScenarios :book-id="bookId" @pick="runScenario" @reset="resetScenario" />
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="q"
        class="input min-w-[200px] flex-1"
        placeholder="Search text, a speaker, or a direction…"
        autofocus
      />
      <UiSelect v-model="speaker" :options="speakerOpts" class="w-44" />
      <UiToggleGroup
        v-model="type"
        :options="[
          { value: 'all', label: 'all' },
          { value: 'dialogue', label: 'dialogue' },
          { value: 'narration', label: 'narration' },
          { value: 'thought', label: 'thought' },
        ]"
      />
    </div>

    <!-- scope: what is selected, out of what -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-zinc-500">
      <label v-if="total" class="flex items-center gap-1.5">
        <UiCheckbox
          :model-value="allState"
          :aria-label="`Select all ${total} matching lines`"
          @update:model-value="() => (allState === true ? clearSelection() : selectAll())"
        />
        <span>Select all matching results</span>
      </label>
      <span>
        <b v-if="selected.size" class="text-zinc-900 dark:text-zinc-100"
          >{{ selected.size }} selected</b
        ><span v-if="selected.size"> · </span>{{ total }} matching line{{
          total === 1 ? "" : "s"
        }}
        in {{ results.length }} chapter{{ results.length === 1 ? "" : "s" }}
      </span>
      <button v-if="selected.size" class="chip" @click="clearSelection">
        <ClearIcon class="icon-sm" /> Clear selection
      </button>
      <button v-if="q.trim()" class="chip ml-auto" @click="pronounce = true">
        <PronounceIcon class="icon-sm" /> Add pronunciation…
      </button>
    </div>
    <p aria-live="polite" class="sr-only">{{ announcement }}</p>

    <!-- what just happened, with the batch's one undo -->
    <div
      v-if="last"
      class="card flex flex-wrap items-center gap-x-3 gap-y-1 border-violet-300 p-3 text-sm dark:border-violet-500/40"
    >
      <span
        ><b>{{ last.result.label }}</b> — {{ last.result.changed }} line{{
          last.result.changed === 1 ? "" : "s"
        }}
        in {{ last.result.chapters }} chapter{{
          last.result.chapters === 1 ? "" : "s"
        }}
        changed<template v-if="last.result.skipped"
          >, {{ last.result.skipped }} left as they were</template
        >.</span
      >
      <span v-if="last.result.stale" class="text-xs text-amber-600"
        >{{ last.result.stale }} clip{{ last.result.stale === 1 ? "" : "s" }} need re-narration —
        the audio is kept until you run it.</span
      >
      <button v-if="undoable" class="btn-ghost btn-xs ml-auto" @click="undo">
        <UndoIcon class="icon-sm" /> Undo this batch
      </button>
      <span v-else class="ml-auto text-xs text-zinc-400">undone</span>
      <button class="btn-ghost btn-xs" aria-label="Dismiss this result" @click="last = null">
        <ClearIcon class="icon-sm" />
      </button>
    </div>

    <!-- bulk actions: only while something is selected. The bar sticks to the top of the results, so
         it never covers them or the player at the bottom, and its panel opens inside it rather than
         over the lines it is about. A tall panel scrolls inside the bar instead of eating the page. -->
    <div
      v-if="selected.size"
      class="sticky top-0 z-30 -mx-1 max-h-[70dvh] overflow-y-auto rounded-lg border border-violet-300 bg-white/95 shadow-sm backdrop-blur dark:border-violet-500/40 dark:bg-zinc-900/95"
    >
      <div class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
        <span class="font-medium"
          >{{ selected.size }} line{{ selected.size === 1 ? "" : "s" }}
          <span class="font-normal text-zinc-500"
            >in {{ selectedChapters }} chapter{{ selectedChapters === 1 ? "" : "s" }}</span
          ></span
        >
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="a in ACTIONS"
            :key="a.kind"
            class="btn-ghost btn-xs"
            :class="panel === a.kind && 'border-violet-400 text-violet-600 dark:text-violet-300'"
            :aria-expanded="panel === a.kind"
            aria-controls="bulk-panel"
            @click="openPanel(a.kind, $event)"
          >
            <component :is="a.icon" class="icon-sm" /> {{ a.label }}
          </button>
        </div>
        <button class="btn-ghost btn-xs ml-auto" @click="clearSelection">
          <ClearIcon class="icon-sm" /> Clear
        </button>
      </div>
      <BulkPanel
        :book-id="bookId"
        :kind="panel"
        :targets="targets"
        @close="closePanel"
        @applied="applied"
      />
    </div>

    <div v-for="r in pages" :key="r.chapter.id" class="card">
      <div
        class="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
      >
        <UiCheckbox
          :model-value="chapterState(r.chapter.id)"
          :aria-label="`Select all matching lines in ${r.chapter.title}`"
          @update:model-value="() => toggleChapter(r.chapter.id)"
        />
        <RouterLink
          :to="{ path: `/book/${bookId}/scripting`, query: { ch: r.chapter.id } }"
          class="flex min-w-0 flex-1 items-center gap-2 hover:text-violet-500"
          ><span class="font-mono text-xs text-zinc-400">{{
            String(r.chapter.id).padStart(2, "0")
          }}</span
          ><b class="truncate">{{ r.chapter.title }}</b></RouterLink
        >
        <span class="shrink-0 text-xs text-zinc-400"
          >{{ r.hits.length + r.hidden }} match{{
            r.hits.length + r.hidden === 1 ? "" : "es"
          }}</span
        >
      </div>
      <div
        v-for="s in r.hits"
        :key="s.id"
        class="flex items-start gap-2 border-b border-zinc-100 px-3 py-2 text-sm last:border-0 dark:border-zinc-800/70"
        :class="isOn(r.chapter.id, s.id) && 'bg-violet-50/70 dark:bg-violet-500/10'"
      >
        <UiCheckbox
          class="mt-1"
          :model-value="isOn(r.chapter.id, s.id)"
          :aria-label="`Select line ${s.id}: ${s.text.slice(0, 60)}`"
          @update:model-value="() => toggleLine(r.chapter.id, s.id)"
        />
        <RouterLink
          :to="{ path: `/book/${bookId}/scripting`, query: { ch: r.chapter.id, seg: s.id } }"
          class="-my-1 flex min-w-0 flex-1 items-start gap-3 rounded px-1 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        >
          <span
            class="mt-0.5 shrink-0 rounded-full px-2 text-xs"
            :style="{ background: colorOf(s.speaker) + '33', color: colorOf(s.speaker) }"
            >{{ s.speaker }}</span
          >
          <span class="min-w-0 flex-1" :class="s.type === 'thought' && 'italic'"
            ><template v-for="(p, i) in mark(s.text)" :key="i"
              ><mark v-if="p.hit" class="rounded bg-amber-300/60 px-0.5 dark:bg-amber-500/40">{{
                p.t
              }}</mark
              ><template v-else>{{ p.t }}</template></template
            ><span v-if="s.direction" class="ml-2 text-[11px] text-violet-500"
              >[{{ s.direction }}]</span
            ></span
          >
          <span class="mt-0.5 flex shrink-0 items-center gap-1.5">
            <FlagIcon
              v-if="s.flag"
              class="icon-sm text-amber-500"
              :aria-label="`flagged: ${s.flag.kind}`"
            />
            <StatusDot v-if="s.audio.status !== 'none'" :status="s.audio.status" />
            <span class="font-mono text-[10px] text-zinc-400">#{{ s.id }}</span>
          </span>
        </RouterLink>
      </div>
      <div v-if="r.hidden" class="px-3 py-1 text-[11px] text-zinc-400">
        +{{ r.hidden }} more in this chapter, not shown
      </div>
    </div>

    <div
      v-if="total > onScreen"
      class="flex flex-wrap items-center justify-center gap-3 text-xs text-zinc-500"
    >
      <span
        >Showing {{ onScreen }} of {{ total }} matching lines. “Select all matching results”
        includes the {{ total - onScreen }} not shown.</span
      >
      <button class="btn-ghost btn-xs" @click="shown += PAGE">
        Show {{ Math.min(PAGE, total - onScreen) }} more
      </button>
    </div>

    <div v-if="!results.length" class="card p-8 text-center text-sm text-zinc-500">
      {{ q ? `Nothing matches “${q}”.` : "Type to search." }}
    </div>

    <PronunciationDialog :book-id="bookId" :open="pronounce" :term="q" @close="pronounce = false" />
  </div>
</template>
