<script setup lang="ts">
import { useLibraryStore } from "@/stores/library";

// Choosing what goes in the audiobook. The shared ChapterPicker is built around "run this stage on
// these chapters" and hides anything a stage cannot act on; a build is the opposite problem — a
// chapter that *cannot* be exported is exactly the one you need to see, because leaving it out has
// to be a decision rather than a silent omission. So this list lets any chapter be ticked and says
// what is wrong with it, and the plan panel turns that into something to do.
//
// It also has to stay usable at 214 chapters: search, a status filter that doubles as navigation,
// per-volume select and collapse, a jump box, and range selection with shift.
import { computed, nextTick, ref, watch } from "vue";

import { readinessOf, READINESS } from "@/lib/exports";
import { clock } from "@/views/export/shared";
import StatusDot from "@/components/StatusDot.vue";
import { UiCheckbox, UiSelect } from "@/ui";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Search as SearchIcon,
} from "@lucide/vue";
import type { Chapter, ChapterReadiness, Volume } from "@/types";

const props = defineProps<{ bookId: string; modelValue: number[] }>();
const emit = defineEmits<{ "update:modelValue": [number[]] }>();
const libraryStore = useLibraryStore();

const chapters = computed(() => libraryStore.chaptersOf(props.bookId));
const volumes = computed(() => libraryStore.volumesOf(props.bookId));
const multi = computed(() => volumes.value.length > 1);
const selected = computed(() => new Set(props.modelValue));
const readiness = computed(() => {
  const m = new Map<number, ChapterReadiness>();
  for (const c of chapters.value) m.set(c.id, readinessOf(c));
  return m;
});
/** A chapter that is skipped is out of every stage; it cannot be put in a file either. */
const canPick = (c: Chapter) => !c.excluded;

const q = ref("");
const search = ref<HTMLInputElement | null>(null);
const collapsed = ref(new Set<number>());
const lastClicked = ref<number | null>(null);

type FilterKey = "all" | "selected" | "ready" | "attention";
const filter = ref<FilterKey>("all");
const counts = computed(() => {
  const out = { total: 0, ready: 0, stale: 0, missing: 0, failed: 0, running: 0, skipped: 0 };
  for (const c of chapters.value) {
    const r = readiness.value.get(c.id)!;
    out.total++;
    if (r === "ready") out.ready++;
    else if (r === "stale") out.stale++;
    else if (r === "missing") out.missing++;
    else if (r === "partial" || r === "failed") out.failed++;
    else if (r === "running") out.running++;
    else out.skipped++;
  }
  return out;
});
const attention = computed(() => counts.value.stale + counts.value.missing + counts.value.failed);
const needsAttention = (c: Chapter) =>
  selected.value.has(c.id) && !["ready", "skipped"].includes(readiness.value.get(c.id)!);

const FILTERS = computed(() => [
  { key: "all" as const, label: "All", n: counts.value.total },
  { key: "selected" as const, label: "Selected", n: props.modelValue.length },
  { key: "ready" as const, label: "Ready", n: counts.value.ready },
  { key: "attention" as const, label: "Needs attention", n: attention.value },
]);

function passes(c: Chapter) {
  const r = readiness.value.get(c.id)!;
  if (filter.value === "selected" && !selected.value.has(c.id)) return false;
  if (filter.value === "ready" && r !== "ready") return false;
  if (filter.value === "attention" && ["ready", "skipped"].includes(r)) return false;
  if (!q.value) return true;
  const needle = q.value.trim().toLowerCase();
  return c.title.toLowerCase().includes(needle) || String(c.id) === needle;
}
const visible = computed(() =>
  volumes.value
    .map((v) => ({
      ...v,
      chapters: chapters.value.filter((c) => c.volumeId === v.id && passes(c)),
    }))
    .filter((v) => v.chapters.length),
);
const shown = computed(() => visible.value.reduce((a, v) => a + v.chapters.length, 0));
/** Ticked chapters the current filter is hiding — a selection you cannot see is a build going wrong. */
const hidden = computed(() => {
  const here = new Set(visible.value.flatMap((v) => v.chapters.map((c) => c.id)));
  return props.modelValue.filter((id) => !here.has(id)).length;
});

type VolumeRow = Volume & { chapters: Chapter[] };
const set = (ids: number[]) => emit("update:modelValue", ids);
const pickable = (list: Chapter[]) => list.filter(canPick).map((c) => c.id);

function toggle(id: number, e?: MouseEvent | KeyboardEvent) {
  const next = new Set(props.modelValue);
  if (e?.shiftKey && lastClicked.value != null) {
    // a range over what is on screen, not over the whole book — the list you can see is the list
    const ids = visible.value.flatMap((v) => pickable(v.chapters));
    const a = ids.indexOf(lastClicked.value);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      const on = !next.has(id);
      for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1))
        if (on) next.add(x);
        else next.delete(x);
      lastClicked.value = id;
      return set([...next]);
    }
  }
  if (next.has(id)) next.delete(id);
  else next.add(id);
  lastClicked.value = id;
  set([...next]);
}
/** Both things hide a ticked chapter, so both have to go — the promise is "show everything". */
function showEverything() {
  filter.value = "all";
  q.value = "";
}
const wholeBook = () => set(pickable(chapters.value));
const allReady = () =>
  set(chapters.value.filter((c) => readiness.value.get(c.id) === "ready").map((c) => c.id));
const none = () => set([]);

function volState(v: VolumeRow) {
  const ids = pickable(chapters.value.filter((c) => c.volumeId === v.id));
  const n = ids.filter((id) => selected.value.has(id)).length;
  return { ids, on: n, all: ids.length > 0 && n === ids.length, some: n > 0 && n < ids.length };
}
function toggleVol(v: VolumeRow) {
  const { ids, all } = volState(v);
  const next = new Set(props.modelValue);
  for (const id of ids)
    if (all) next.delete(id);
    else next.add(id);
  set([...next]);
}
function toggleCollapse(id: number) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}
async function jump(id: string | number | null) {
  const next = new Set(collapsed.value);
  next.delete(Number(id));
  collapsed.value = next;
  await nextTick();
  document
    .getElementById(`xvol-${props.bookId}-${id}`)
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
}
// changing book resets what is only meaningful for one book
watch(
  () => props.bookId,
  () => {
    q.value = "";
    filter.value = "all";
    collapsed.value = new Set();
  },
);

function onRowKey(e: KeyboardEvent, c: Chapter) {
  const el = e.currentTarget as HTMLElement;
  const rows = [...(el.closest("[data-list]")?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  const i = rows.indexOf(el);
  if (e.key === "ArrowDown" || e.key === "j") {
    e.preventDefault();
    rows[i + 1]?.focus();
  } else if (e.key === "ArrowUp" || e.key === "k") {
    e.preventDefault();
    rows[i - 1]?.focus();
  } else if (e.key === " ") {
    e.preventDefault();
    if (canPick(c)) toggle(c.id, e);
  }
}
function onListKey(e: KeyboardEvent) {
  if (e.key === "/" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) {
    e.preventDefault();
    search.value?.focus();
  }
}
const tone: Record<string, string> = {
  ok: "text-zinc-400",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-500",
  muted: "text-zinc-400",
};
</script>

<template>
  <div class="card flex h-full min-h-0 flex-col" @keydown="onListKey">
    <div class="border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
      <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div class="label">
          What goes in<span
            v-if="multi"
            class="font-normal normal-case tracking-normal text-zinc-400"
          >
            · {{ volumes.length }} volumes</span
          >
        </div>
        <div class="font-mono text-xs">
          <b>{{ modelValue.length }}</b
          ><span class="text-zinc-400">/{{ counts.total }} chapters</span>
        </div>
      </div>
      <div class="mt-1.5 flex flex-wrap gap-1">
        <button class="chip" @click="wholeBook">Whole book</button>
        <button class="chip" @click="allReady">All ready ({{ counts.ready }})</button>
        <button class="chip" :disabled="!modelValue.length" @click="none">Clear</button>
      </div>
    </div>

    <div class="flex items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
      <div class="input flex min-w-0 flex-1 items-center gap-1 py-0.5">
        <SearchIcon class="icon-sm shrink-0 text-zinc-400" />
        <input
          ref="search"
          v-model="q"
          class="min-w-0 flex-1 bg-transparent py-0.5 text-xs focus:outline-none"
          placeholder="Find a chapter… (title or number)"
          aria-label="Find a chapter"
        />
      </div>
      <UiSelect
        v-if="multi"
        :model-value="undefined"
        :options="volumes.map((v) => ({ value: v.id, label: v.name.split('·')[0].trim() }))"
        placeholder="Jump…"
        size="xs"
        class="w-20 shrink-0"
        @update:model-value="jump"
      />
    </div>

    <div class="flex flex-wrap gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
      <button
        v-for="f in FILTERS"
        :key="f.key"
        class="chip"
        :class="[
          filter === f.key && 'chip-on',
          f.key === 'attention' && f.n && filter !== f.key && 'border-amber-400 text-amber-600',
        ]"
        :aria-pressed="filter === f.key"
        @click="filter = f.key"
      >
        {{ f.label }} <span class="font-mono opacity-60">{{ f.n }}</span>
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto py-1" data-list>
      <p v-if="!visible.length" class="px-3 py-6 text-center text-xs text-zinc-500">
        No chapter matches this filter.
      </p>
      <template v-for="v in visible" :key="v.id">
        <div
          v-if="multi"
          :id="`xvol-${bookId}-${v.id}`"
          class="sticky top-0 z-10 flex items-center gap-2 border-y border-zinc-100 bg-zinc-50 px-3 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900"
        >
          <UiCheckbox
            :model-value="volState(v).all ? true : volState(v).some ? 'indeterminate' : false"
            size="xs"
            :aria-label="`Select every chapter of ${v.name}`"
            @update:model-value="toggleVol(v)"
          />
          <button
            class="min-w-0 flex-1 truncate text-left font-semibold"
            :title="v.name"
            @click="toggleCollapse(v.id)"
          >
            <component
              :is="collapsed.has(v.id) ? ChevronRightIcon : ChevronDownIcon"
              class="mr-1 icon-sm text-zinc-400"
            />{{ v.name }}
          </button>
          <span class="shrink-0 font-mono text-[10px] text-zinc-400"
            >{{ volState(v).on }}/{{ volState(v).ids.length }}</span
          >
        </div>
        <template v-if="!collapsed.has(v.id)">
          <div
            v-for="c in v.chapters"
            :key="c.id"
            data-row
            tabindex="0"
            class="group flex items-center gap-2 px-3 py-1.5 text-sm outline-none hover:bg-zinc-50 focus-visible:bg-zinc-100 dark:hover:bg-zinc-800/60 dark:focus-visible:bg-zinc-800"
            :class="[
              needsAttention(c) && 'bg-amber-400/5',
              !canPick(c) && 'opacity-50',
              selected.has(c.id) &&
                'border-l-2 border-violet-500 pl-[calc(0.75rem-2px)] dark:border-violet-400',
            ]"
            @keydown="onRowKey($event, c)"
          >
            <UiCheckbox
              :model-value="selected.has(c.id)"
              :disabled="!canPick(c)"
              :aria-label="`Include chapter ${c.id}, ${c.title}`"
              @click="toggle(c.id, $event)"
            />
            <StatusDot :status="READINESS[readiness.get(c.id)!].dot" />
            <span class="min-w-0 flex-1 truncate" :title="c.title">
              <span class="mr-1.5 font-mono text-[11px] text-zinc-400">{{
                String(c.id).padStart(String(counts.total).length, "0")
              }}</span
              ><span :class="c.excluded && 'line-through decoration-zinc-400'">{{ c.title }}</span>
            </span>
            <span
              v-if="readiness.get(c.id) !== 'ready'"
              class="shrink-0 whitespace-nowrap text-[11px]"
              :class="tone[READINESS[readiness.get(c.id)!].tone]"
              :title="READINESS[readiness.get(c.id)!].label"
              >{{ READINESS[readiness.get(c.id)!].short }}</span
            >
            <span v-else class="shrink-0 font-mono text-[11px] text-zinc-400">{{
              clock(c.duration)
            }}</span>
          </div>
        </template>
      </template>
    </div>

    <div
      class="shrink-0 border-t border-zinc-200 px-3 py-2 text-[11px] leading-relaxed text-zinc-500 dark:border-zinc-800"
    >
      <p v-if="hidden" class="text-amber-600 dark:text-amber-400">
        {{ hidden }} ticked chapter{{ hidden === 1 ? " is" : "s are" }} hidden by
        {{ q && filter !== "all" ? "the search and the filter" : q ? "the search" : "this filter" }}
        — <button class="underline" @click="showEverything">show everything</button>.
      </p>
      <p v-else-if="filter !== 'all'">Showing {{ shown }} of {{ counts.total }} chapters.</p>
      <p v-else>shift-click selects a range · <kbd class="font-mono">/</kbd> searches</p>
    </div>
  </div>
</template>
