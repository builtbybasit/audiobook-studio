<script setup lang="ts">
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";

// Shared chapter selector: checkboxes + per-stage status. Chapters are grouped by volume when a
// novel spans several EPUBs; each volume header can collapse and select/deselect its chapters.
// Each row has a peek (raw text preview) and can be skipped (excluded from every stage).
// Keyboard: ↑↓ move, space ticks, ↵ opens, / focuses search.
// A book can have near a thousand rows, so a row keeps to cheap elements — a native tick box, and
// a peek button that opens the one popover the list shares — and what it shows is worked out once.
import { computed, ref } from "vue";
import { isNarrated } from "@/lib/scriptReview";
import { findsChapter, numberCell } from "@/lib/chapterNumber";
import { chapterState, selectionSummary } from "@/lib/runPlan";
import { idSetParam, textParam, useQueryParam } from "@/composables/useQueryParam";
import { applySpan, useRangeSelect } from "@/composables/useRangeSelect";
import { clockDuration } from "@/lib/time";
import ChapterPeek from "@/components/ChapterPeek.vue";
import { dotClass } from "@/components/statusDot";
import { UiCheckbox, UiSelect } from "@/ui";
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
const chapters = computed(() => libraryStore.chaptersOf(props.bookId));
const volumes = computed(() => libraryStore.volumesOf(props.bookId));
const grouped = computed(() =>
  volumes.value.map((v) => ({ ...v, chapters: chapters.value.filter((c) => c.volumeId === v.id) })),
);
const multi = computed(() => volumes.value.length > 1);
const collapsed = useQueryParam("closed", idSetParam());
const q = useQueryParam("find", textParam());
const search = ref<HTMLInputElement | null>(null);
const canPick = (c: Chapter) => props.selectable(c) && !c.excluded;
/** reading numbers: what each row shows and the search finds a number by (skipped rows have none) */
const numbers = computed(() => libraryStore.chapterNumbers[props.bookId]);
const matches = (c: Chapter) =>
  !q.value || findsChapter(c.title, numbers.value?.get(c.id), q.value);

function statusOf(c: Chapter): string {
  if (props.stage === "scripting") return c.scripting;
  if (props.stage === "narration") return c.narration;
  return isNarrated(c) ? (c.narration === "stale" ? "stale" : "done") : "none";
}
const finished = (status: string) => ["done", "fallback", "stale"].includes(status);
const isDone = (c: Chapter) => finished(statusOf(c));
/** What a row says after its title, in one word or number: skipped, how far a run has got, how
 *  the last one went, or — once a chapter is done — its script's lines or its audio's length. */
type Tag = { text: string; class: string; title?: string };
function tagOf(c: Chapter, status: string): Tag | null {
  if (c.excluded) return { text: "skipped", class: "text-zinc-400" };
  if (status === "running") {
    const pct = props.stage === "scripting" ? c.scriptingProgress : c.narrationProgress;
    return { text: `${Math.round(pct)}%`, class: "w-9 text-right font-mono text-violet-500" };
  }
  if (status === "failed") return { text: "failed", class: "text-red-500" };
  if (status === "stale")
    return { text: "stale", class: "text-amber-600", title: "edited after narration" };
  if (status === "fallback")
    return {
      text: "fallback",
      class: "text-amber-600",
      title: "a chunk didn't verify and was kept as narration",
    };
  if (props.stage === "scripting" && c.scripting === "done") {
    // every line the script holds — the ones not read aloud are still lines of the script, and
    // the title says how many of them there are. Blank until the count is read.
    const lines = scriptsStore.lineCountsOf(props.bookId, c.id);
    const skipped = lines?.skipped ?? 0;
    return {
      text: lines ? String(lines.total + skipped) : "",
      class: "font-mono text-zinc-400",
      title: skipped ? `segments · ${skipped} not read aloud` : "segments",
    };
  }
  if (props.stage !== "scripting" && c.duration)
    return { text: clockDuration(c.duration), class: "font-mono text-zinc-400" };
  return null;
}
/** A chapter as its row shows it, worked out once for the row rather than once per binding. */
type Row = {
  c: Chapter;
  n: number | undefined;
  status: string;
  pickable: boolean;
  tag: Tag | null;
};
/** A volume as the list shows it: the rows the search leaves in it, the ids a tick on its header
 *  covers, and how many of those rows this stage has finished. */
type VolumeRow = Volume & { rows: Row[]; pickIds: number[]; done: number };
const visible = computed(() =>
  grouped.value.flatMap((v): VolumeRow[] => {
    const rows = v.chapters.filter(matches).map((c): Row => {
      const status = statusOf(c);
      return {
        c,
        n: numbers.value?.get(c.id),
        status,
        pickable: canPick(c),
        tag: tagOf(c, status),
      };
    });
    if (!rows.length) return [];
    const pickIds = rows.filter((r) => r.pickable).map((r) => r.c.id);
    return [{ ...v, rows, pickIds, done: rows.filter((r) => finished(r.status)).length }];
  }),
);
const visiblePickable = computed(() => visible.value.flatMap((v) => v.pickIds));
const eligible = computed(() => chapters.value.filter(canPick));
/** the selection as a set: a row asks it once per render, and a book can tick every chapter */
const picked = computed(() => new Set(props.modelValue));
const range = useRangeSelect(visiblePickable);
function jump(id: string | number | null) {
  document
    .getElementById(`vol-${props.bookId}-${id}`)
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
  const s = new Set(collapsed.value);
  s.delete(Number(id));
  collapsed.value = s;
}

function toggle(id: number, e?: MouseEvent | KeyboardEvent) {
  const on = !picked.value.has(id);
  emit("update:modelValue", [...applySpan(props.modelValue, range.span(id, e), on)]);
}
function all() {
  emit("update:modelValue", visiblePickable.value);
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
    chapters.value.filter((c) => picked.value.has(c.id)),
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
/** a volume header's tick: every row of it, some, or none */
function volTick(v: VolumeRow): boolean | "indeterminate" {
  const n = v.pickIds.filter((id) => picked.value.has(id)).length;
  return n > 0 && n === v.pickIds.length ? true : n > 0 ? "indeterminate" : false;
}
function toggleVol(v: VolumeRow) {
  const set = new Set(props.modelValue);
  if (volTick(v) === true) v.pickIds.forEach((id) => set.delete(id));
  else v.pickIds.forEach((id) => set.add(id));
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
  } else if (e.target !== el) {
    // the tick box and the peek inside the row answer space and enter themselves
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
  void libraryStore.setExcluded(props.bookId, c.id, v);
  if (v && picked.value.has(c.id))
    emit(
      "update:modelValue",
      props.modelValue.filter((x) => x !== c.id),
    );
}
/** The one peek the list shares, and the row whose peek button opened it. */
const peekOpen = ref(false);
const peekId = ref<number | null>(null);
const peekEl = ref<HTMLElement>();
const peeked = computed(() => chapters.value.find((c) => c.id === peekId.value));
function openPeek(c: Chapter, e: MouseEvent) {
  if (peekOpen.value && peekId.value === c.id) {
    peekOpen.value = false;
    return;
  }
  peekId.value = c.id;
  peekEl.value = e.currentTarget as HTMLElement;
  peekOpen.value = true;
}
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
          <UiCheckbox :model-value="volTick(v)" size="xs" @update:model-value="toggleVol(v)" />
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
            >{{ v.done }}/{{ v.rows.length }}</span
          >
        </div>
        <template v-if="!collapsed.has(v.id)">
          <div
            v-for="{ c, n, status, pickable, tag } in v.rows"
            :key="c.id"
            data-row
            tabindex="0"
            class="group flex items-center gap-2 px-3 py-1.5 text-sm outline-none focus-visible:bg-zinc-100 dark:focus-visible:bg-zinc-800"
            :class="[
              openedId === c.id
                ? 'bg-violet-50 dark:bg-violet-500/10'
                : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
              !pickable && 'opacity-50',
            ]"
            @keydown="onRowKey($event, c)"
          >
            <UiCheckbox
              :model-value="picked.has(c.id)"
              :disabled="!pickable"
              :aria-label="n == null ? `Select ${c.title} (skipped)` : `Select chapter ${n}`"
              @click="toggle(c.id, $event)"
            />
            <span
              :class="dotClass(c.excluded ? 'none' : status)"
              :title="c.excluded ? 'none' : status"
            ></span>
            <button
              class="min-w-0 flex-1 truncate text-left"
              :class="[
                openedId === c.id && 'font-semibold',
                c.excluded && 'line-through decoration-zinc-400',
              ]"
              tabindex="-1"
              @click="emit('open', c.id)"
            >
              <span class="mr-1.5 font-mono text-[11px] text-zinc-400">{{ numberCell(n) }}</span
              >{{ c.title }}
            </button>
            <!-- peek -->
            <button
              data-peek
              class="rounded px-1 text-[11px] text-zinc-400 opacity-0 hover:text-violet-500 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
              title="peek at the chapter text"
              :aria-label="`Preview and exclude ${n == null ? 'skipped chapter' : `chapter ${n}`}, ${c.title}`"
              aria-haspopup="dialog"
              :aria-expanded="peekOpen && peekId === c.id"
              @click="openPeek(c, $event)"
            >
              <!-- lucide's eye as plain markup: an icon component is two instances a row -->
              <svg
                class="icon-sm"
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
                />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <span v-if="tag" class="text-[11px]" :class="tag.class" :title="tag.title">{{
              tag.text
            }}</span>
          </div>
        </template>
      </template>
    </div>

    <ChapterPeek
      v-model:open="peekOpen"
      :book-id="bookId"
      :chapter="peeked"
      :anchor="peekEl"
      @skip="skip"
    />

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
