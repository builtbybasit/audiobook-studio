<script setup lang="ts">
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";

// Shared chapter selector: checkboxes + per-stage status. Chapters are grouped by volume when a
// novel spans several EPUBs; each volume header can collapse and select/deselect its chapters.
// Each row has a peek (raw text preview) and can be skipped (excluded from every stage).
// Keyboard: ↑↓ move, space ticks, ↵ opens, / focuses search.
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isNarrated } from "@/lib/scriptReview";
import { chapterState, selectionSummary } from "@/lib/runPlan";
import { queryIdSet, queryText } from "@/lib/query";
import { clockDuration } from "@/lib/time";
import StatusDot from "@/components/StatusDot.vue";
import { UiCheckbox, UiSelect } from "@/ui";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Eye as PeekIcon,
} from "@lucide/vue";
import type { Chapter, Volume } from "@/types";

const props = withDefaults(
  defineProps<{
    bookId: string;
    stage: "scripting" | "narration" | "export";
    modelValue?: number[];
    openedId?: number | null;
    runLabel?: string;
    runDisabled?: boolean;
    /** what the run will actually do, in one line, under the button */
    runNote?: string;
    /** chapters the run will act on, when that differs from the number ticked */
    runCount?: number | null;
    /** why some ticked chapters are not in the run */
    runSkipped?: string;
    /** which chapters this stage may act on */
    selectable?: (c: Chapter) => boolean;
  }>(),
  {
    modelValue: () => [],
    openedId: null,
    runLabel: "Run",
    runNote: "",
    runCount: null,
    runSkipped: "",
    selectable: () => true,
  },
);
const emit = defineEmits<{
  "update:modelValue": [number[]];
  open: [number];
  run: [number[]];
}>();
const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
const route = useRoute();
const router = useRouter();
const chapters = computed(() => libraryStore.chaptersOf(props.bookId));
const volumes = computed(() => libraryStore.volumesOf(props.bookId));
const grouped = computed(() =>
  volumes.value.map((v) => ({ ...v, chapters: chapters.value.filter((c) => c.volumeId === v.id) })),
);
/** A volume plus the chapters that belong to it, as rendered by the list. */
type VolumeRow = Volume & { chapters: Chapter[] };
const multi = computed(() => volumes.value.length > 1);
const collapsed = ref(queryIdSet(route.query.closed));
const q = ref(queryText(route.query.find));
const search = ref<HTMLInputElement | null>(null);
const lastClicked = ref<number | null>(null);
const canPick = (c: Chapter) => props.selectable(c) && !c.excluded;
const matches = (c: Chapter) =>
  !q.value || c.title.toLowerCase().includes(q.value.toLowerCase()) || String(c.id) === q.value;
const visible = computed(() =>
  grouped.value
    .map((v) => ({ ...v, chapters: v.chapters.filter(matches) }))
    .filter((v) => v.chapters.length),
);
const visiblePickable = computed(() => visible.value.flatMap((v) => v.chapters.filter(canPick)));
const eligible = computed(() => chapters.value.filter(canPick));
watch(q, (value) => {
  if (queryText(route.query.find) === value) return;
  void router.replace({ query: { ...route.query, find: value || undefined } });
});
watch(collapsed, (value) => {
  const closed = [...value].sort((a, b) => a - b).join(",");
  if (queryText(route.query.closed) === closed) return;
  void router.replace({ query: { ...route.query, closed: closed || undefined } });
});
watch(
  () => route.query.find,
  (value) => {
    const next = queryText(value);
    if (q.value !== next) q.value = next;
  },
);
watch(
  () => route.query.closed,
  (value) => {
    const next = queryIdSet(value);
    const ordered = (ids: Set<number>) => [...ids].sort((a, b) => a - b).join(",");
    if (ordered(next) !== ordered(collapsed.value)) collapsed.value = next;
  },
);
function jump(id: string | number | null) {
  document
    .getElementById(`vol-${props.bookId}-${id}`)
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
  const s = new Set(collapsed.value);
  s.delete(Number(id));
  collapsed.value = s;
}

function statusOf(c: Chapter): string {
  if (props.stage === "scripting") return c.scripting;
  if (props.stage === "narration") return c.narration;
  return isNarrated(c) ? (c.narration === "stale" ? "stale" : "done") : "none";
}
const isDone = (c: Chapter) => ["done", "fallback", "stale"].includes(statusOf(c));
function progressOf(c: Chapter) {
  return props.stage === "scripting" ? c.scriptingProgress : c.narrationProgress;
}
function toggle(id: number, e?: MouseEvent | KeyboardEvent) {
  const set = new Set(props.modelValue);
  if (e?.shiftKey && lastClicked.value != null) {
    const ids = visiblePickable.value.map((c) => c.id);
    const a = ids.indexOf(lastClicked.value);
    const b = ids.indexOf(id);
    const on = !set.has(id);
    for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) {
      if (on) set.add(x);
      else set.delete(x);
    }
  } else if (set.has(id)) set.delete(id);
  else set.add(id);
  lastClicked.value = id;
  emit("update:modelValue", [...set]);
}
function all() {
  emit(
    "update:modelValue",
    visiblePickable.value.map((c) => c.id),
  );
}
function allEligible() {
  emit(
    "update:modelValue",
    eligible.value.map((c) => c.id),
  );
}
function none() {
  emit("update:modelValue", []);
}
/** What the current selection contains: “8 chapters selected: 3 new, 5 already scripted.” */
const summary = computed(() =>
  selectionSummary(
    chapters.value.filter((c) => props.modelValue.includes(c.id)),
    props.stage === "export" ? "narration" : props.stage,
  ),
);
/**
 * Selection shortcuts. They read the whole book, never the search — a filtered list is the one
 * thing the header says out loud — and only appear when they would select something, so the row
 * stays short on a book that has nothing failed or stale.
 */
const shortcuts = computed(() => {
  const stage = props.stage === "export" ? "narration" : props.stage;
  const of = (test: (c: Chapter) => boolean) =>
    chapters.value.filter((c) => canPick(c) && test(c)).map((c) => c.id);
  const state = (c: Chapter) => chapterState(c, stage);
  return [
    {
      id: "pending",
      label: "Pending",
      ids: of((c) => !isDone(c)),
      title: "every chapter this stage has not finished",
    },
    {
      id: "done",
      label: "Completed",
      ids: of((c) => state(c) === "done"),
      title:
        stage === "scripting"
          ? "chapters that already have a script — running them again replaces it"
          : "chapters that are already narrated — running them again replaces their audio",
    },
    {
      id: "stale",
      label: "Stale",
      ids: of((c) => state(c) === "stale"),
      title: "narrated, then the script moved under the audio",
    },
    {
      id: "failed",
      label: "Failed",
      ids: of((c) => state(c) === "failed"),
      title: "chapters whose last run at this stage failed",
    },
  ].filter((g) => g.ids.length);
});
function select(ids: number[]) {
  emit("update:modelValue", ids);
}
function volState(v: VolumeRow) {
  const ids = v.chapters.filter(canPick).map((c) => c.id);
  const n = ids.filter((id) => props.modelValue.includes(id)).length;
  return {
    all: ids.length > 0 && n === ids.length,
    some: n > 0 && n < ids.length,
    done: v.chapters.filter(isDone).length,
  };
}
function toggleVol(v: VolumeRow) {
  const ids = v.chapters.filter(canPick).map((c) => c.id);
  const set = new Set(props.modelValue);
  if (volState(v).all) ids.forEach((id) => set.delete(id));
  else ids.forEach((id) => set.add(id));
  emit("update:modelValue", [...set]);
}
function toggleCollapse(id: number) {
  const s = new Set(collapsed.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  collapsed.value = s;
}
const counts = computed(() => {
  const out: Record<string, number> = {
    done: 0,
    failed: 0,
    running: 0,
    stale: 0,
    fallback: 0,
    excluded: 0,
  };
  for (const c of chapters.value) {
    if (c.excluded) {
      out.excluded++;
      continue;
    }
    const s = statusOf(c);
    if (s in out) out[s]++;
  }
  out.done += out.fallback + out.stale;
  return out;
});
// keyboard on the list: rows are focusable; arrows move, space ticks, enter opens
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
  } else if (e.key === "Enter") {
    e.preventDefault();
    emit("open", c.id);
  }
}
function onListKey(e: KeyboardEvent) {
  if (e.key === "/") {
    e.preventDefault();
    search.value?.focus();
  }
}
function skip(c: Chapter, v: boolean) {
  libraryStore.setExcluded(props.bookId, c.id, v);
  if (v && props.modelValue.includes(c.id))
    emit(
      "update:modelValue",
      props.modelValue.filter((x) => x !== c.id),
    );
}
const peek = (c: Chapter) => {
  const t = scriptsStore.rawText(props.bookId, c.id);
  return t.length > 700 ? t.slice(0, 700) + "…" : t;
};
</script>

<template>
  <div class="card flex h-full flex-col" @keydown="onListKey">
    <div
      class="flex items-center justify-between border-b border-zinc-200 px-3 py-2 dark:border-zinc-800"
    >
      <div>
        <div class="label">
          Chapters<span v-if="multi" class="font-normal normal-case tracking-normal text-zinc-400">
            · {{ volumes.length }} volumes</span
          >
        </div>
        <div class="text-xs text-zinc-500">
          {{ counts.done }} done · {{ counts.failed }} failed<span v-if="counts.stale">
            · <span class="text-amber-600">{{ counts.stale }} stale</span></span
          ><span v-if="counts.excluded">
            ·
            <RouterLink
              :to="`/book/${bookId}/contents`"
              class="underline decoration-zinc-300"
              title="review contents"
              >{{ counts.excluded }} skipped</RouterLink
            ></span
          >
          · {{ modelValue.length }} selected
        </div>
      </div>
      <div class="flex shrink-0 gap-1">
        <button
          class="btn-ghost btn-xs"
          :title="
            q
              ? `select the ${visiblePickable.length} chapters matching “${q}”`
              : 'select every chapter in the book'
          "
          @click="all"
        >
          {{ q ? `All ${visiblePickable.length} results` : `All ${eligible.length}` }}
        </button>
        <button
          v-if="q"
          class="btn-ghost btn-xs"
          title="ignore the filter and select every chapter in the book"
          @click="allEligible"
        >
          Whole book ({{ eligible.length }})
        </button>
        <button class="btn-ghost btn-xs" @click="none">None</button>
      </div>
    </div>

    <!-- selection shortcuts, and what the selection actually contains -->
    <div class="border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      <div class="flex flex-wrap items-center gap-1">
        <span class="mr-0.5 text-[10px] uppercase tracking-wider text-zinc-400">Select</span>
        <button
          v-for="g in shortcuts"
          :key="g.id"
          class="btn-ghost btn-xs"
          :title="g.title"
          @click="select(g.ids)"
        >
          {{ g.label }} <span class="text-zinc-400">{{ g.ids.length }}</span>
        </button>
        <span v-if="q" class="ml-auto text-[10px] text-zinc-400">whole book, not the filter</span>
      </div>
      <p
        class="mt-1 truncate text-[11px]"
        :title="summary.text"
        :class="
          summary.counts.done || summary.counts.stale
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-zinc-500'
        "
      >
        {{ summary.text }}
      </p>
    </div>

    <div class="flex items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
      <input
        ref="search"
        v-model="q"
        class="input min-w-0 flex-1 py-0.5 text-xs"
        placeholder="Find chapter… (title or #)"
      />
      <UiSelect
        v-if="multi"
        :model-value="undefined"
        :options="volumes.map((v) => ({ value: v.id, label: v.name.split('·')[0].trim() }))"
        placeholder="Jump to…"
        size="xs"
        class="w-24"
        @update:model-value="jump"
      />
    </div>

    <!-- the list is the part that flexes, and the part that must never be squeezed to nothing:
         every line above and below it is bounded, so a long note cannot eat the chapters -->
    <div class="min-h-24 flex-1 overflow-auto py-1" data-list>
      <div v-if="!visible.length" class="px-3 py-4 text-center text-xs text-zinc-500">
        No chapter matches “{{ q }}”.
      </div>
      <template v-for="v in visible" :key="v.id">
        <div
          v-if="multi"
          :id="`vol-${bookId}-${v.id}`"
          class="sticky top-0 z-10 flex items-center gap-2 border-y border-zinc-100 bg-zinc-50 px-3 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900"
        >
          <UiCheckbox
            :model-value="volState(v).all ? true : volState(v).some ? 'indeterminate' : false"
            size="xs"
            @update:model-value="toggleVol(v)"
          />
          <button
            class="min-w-0 flex-1 truncate text-left font-semibold"
            @click="toggleCollapse(v.id)"
          >
            <component
              :is="collapsed.has(v.id) ? ChevronRightIcon : ChevronDownIcon"
              class="mr-1 icon-sm text-zinc-400"
            />{{ v.name }}
          </button>
          <span class="shrink-0 font-mono text-[10px] text-zinc-400" :title="v.file"
            >{{ volState(v).done }}/{{ v.chapters.length }}</span
          >
        </div>
        <template v-if="!collapsed.has(v.id)">
          <div
            v-for="c in v.chapters"
            :key="c.id"
            data-row
            tabindex="0"
            class="group flex items-center gap-2 px-3 py-1.5 text-sm outline-none focus-visible:bg-zinc-100 dark:focus-visible:bg-zinc-800"
            :class="[
              openedId === c.id
                ? 'bg-violet-50 dark:bg-violet-500/10'
                : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
              !canPick(c) && 'opacity-50',
            ]"
            @keydown="onRowKey($event, c)"
          >
            <UiCheckbox
              :model-value="modelValue.includes(c.id)"
              :disabled="!canPick(c)"
              @click="toggle(c.id, $event)"
            />
            <StatusDot :status="c.excluded ? 'none' : statusOf(c)" />
            <button
              class="min-w-0 flex-1 truncate text-left"
              :class="[
                openedId === c.id && 'font-semibold',
                c.excluded && 'line-through decoration-zinc-400',
              ]"
              tabindex="-1"
              @click="emit('open', c.id)"
            >
              <span class="mr-1.5 font-mono text-[11px] text-zinc-400">{{
                String(c.id).padStart(2, "0")
              }}</span
              >{{ c.title }}
            </button>
            <!-- peek -->
            <PopoverRoot>
              <PopoverTrigger
                class="rounded px-1 text-[11px] text-zinc-400 opacity-0 hover:text-violet-500 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                title="peek at the chapter text"
                :aria-label="`Preview and exclude chapter ${c.id}, ${c.title}`"
                ><PeekIcon class="icon-sm"
              /></PopoverTrigger>
              <PopoverPortal>
                <PopoverContent
                  side="right"
                  :side-offset="8"
                  align="start"
                  class="ui-popup w-[min(420px,90vw)] p-3 text-xs"
                >
                  <div class="mb-1 flex items-baseline gap-2">
                    <b class="text-sm">{{ c.title }}</b
                    ><span class="text-zinc-400"
                      >~{{ c.words.toLocaleString() }} words ·
                      {{ Math.round((c.words * 5.6) / 1000) }}k chars</span
                    >
                  </div>
                  <p
                    class="max-h-48 overflow-auto whitespace-pre-line font-serif text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300"
                  >
                    {{ peek(c) }}
                  </p>
                  <div
                    class="mt-2 flex items-center gap-2 border-t border-zinc-100 pt-2 dark:border-zinc-800"
                  >
                    <span class="text-zinc-500"
                      >{{
                        c.excluded
                          ? "Skipped: left out of every stage and the audiobook."
                          : c.note
                            ? c.note.reason + "."
                            : "A notice, front matter, or a duplicate? Skip it."
                      }}
                      <RouterLink :to="`/book/${bookId}/contents?ch=${c.id}`" class="underline"
                        >Review contents</RouterLink
                      ></span
                    >
                    <button class="btn-ghost btn-xs ml-auto" @click="skip(c, !c.excluded)">
                      {{ c.excluded ? "Include again" : "Skip this chapter" }}
                    </button>
                  </div>
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
            <span v-if="c.excluded" class="text-[11px] text-zinc-400">skipped</span>
            <span
              v-else-if="statusOf(c) === 'running'"
              class="w-9 text-right font-mono text-[11px] text-violet-500"
              >{{ Math.round(progressOf(c)) }}%</span
            >
            <span v-else-if="statusOf(c) === 'failed'" class="text-[11px] text-red-500"
              >failed</span
            >
            <span
              v-else-if="statusOf(c) === 'stale'"
              class="text-[11px] text-amber-600"
              title="edited after narration"
              >stale</span
            >
            <span
              v-else-if="statusOf(c) === 'fallback'"
              class="text-[11px] text-amber-600"
              title="a chunk didn't verify and was kept as narration"
              >fallback</span
            >
            <span
              v-else-if="stage === 'scripting' && c.scripting === 'done'"
              class="font-mono text-[11px] text-zinc-400"
              title="segments"
              >{{ scriptsStore.segmentsOf(bookId, c.id).length }}</span
            >
            <span
              v-else-if="stage !== 'scripting' && c.duration"
              class="font-mono text-[11px] text-zinc-400"
              >{{ clockDuration(c.duration) }}</span
            >
          </div>
        </template>
      </template>
    </div>

    <div class="border-t border-zinc-200 p-2 dark:border-zinc-800">
      <!-- one line each: the long form of both is said in full in the run panel beside this -->
      <p v-if="runNote" class="mb-1 truncate text-[11px] text-zinc-500" :title="runNote">
        {{ runNote }}
      </p>
      <p
        v-if="runSkipped"
        class="mb-1 truncate text-[11px] text-amber-700 dark:text-amber-400"
        :title="runSkipped"
      >
        {{ runSkipped }}
      </p>
      <div v-if="!runNote" class="mb-1 text-center text-[10px] text-zinc-400">
        shift-click selects a range · <PeekIcon class="icon-sm" /> peeks at the text
      </div>
      <button
        class="btn-primary w-full justify-center"
        :disabled="runDisabled || !(runCount ?? modelValue.length)"
        @click="emit('run', modelValue)"
      >
        {{ runLabel }}
        <span class="opacity-70">({{ runCount ?? modelValue.length }})</span>
      </button>
    </div>
  </div>
</template>
