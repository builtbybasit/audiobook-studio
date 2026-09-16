<script setup lang="ts">
// The chapter list of the contents review: reading order, grouped by volume, every row a decision.
// The checkbox is the decision itself — ticked means "in the audiobook" — so there is no second
// selection to keep track of; shift ticks a range of what is on screen, the volume header ticks a
// volume, and the strip above the list ticks a kind of note. Opening a chapter is a separate click
// and never changes a tick.
import { computed, nextTick, ref } from "vue";
import { excerptOf, stateOf } from "@/lib/contents";
import { STATE_CHIP, words } from "@/views/contents/shared";
import { UiCheckbox } from "@/ui";
import type { Chapter, Volume } from "@/types";
import { ChevronDown as ChevronDownIcon, ChevronRight as ChevronRightIcon } from "@lucide/vue";

export interface VolumeRow extends Volume {
  chapters: Chapter[];
  /** every chapter of the volume, not only the ones on screen */
  all: Chapter[];
}

const props = defineProps<{
  bookId: string;
  rows: VolumeRow[];
  multi: boolean;
  total: number;
  opened: number | null;
  collapsed: Set<number>;
  textOf: (c: Chapter) => string;
  /** the search or a filter is narrowing the list */
  narrowed: boolean;
}>();
const emit = defineEmits<{
  open: [id: number];
  /** tick or untick one chapter; with shift, the run from the last click */
  toggle: [c: Chapter, e: MouseEvent | KeyboardEvent];
  toggleVolume: [v: VolumeRow];
  "update:collapsed": [Set<number>];
  nextUndecided: [];
  search: [];
}>();

const excerpts = new Map<string, string>();
function excerpt(c: Chapter): string {
  const k = `${c.id}:${c.note?.kind ?? ""}:${c.note?.at ?? ""}`;
  let e = excerpts.get(k);
  if (e == null) {
    e = excerptOf(props.textOf(c));
    excerpts.set(k, e);
  }
  return e;
}

const pad = computed(() => String(props.total).length);
const rowId = (id: number) => `contents-${props.bookId}-${id}`;

function volState(v: VolumeRow) {
  const on = v.all.filter((c) => !c.excluded).length;
  return {
    on,
    all: on === v.all.length,
    some: on > 0 && on < v.all.length,
    hidden: v.all.length - v.chapters.length,
  };
}
function toggleCollapse(id: number) {
  const next = new Set(props.collapsed);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  emit("update:collapsed", next);
}

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
    emit("toggle", c, e);
  } else if (e.key === "Enter") {
    e.preventDefault();
    emit("open", c.id);
  } else if (e.key === "n") {
    e.preventDefault();
    emit("nextUndecided");
  }
}
function onListKey(e: KeyboardEvent) {
  if (e.key === "/" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) {
    e.preventDefault();
    emit("search");
  }
}
/** Put the keyboard on a row, opening its volume first if it is folded away. */
async function focusRow(id: number, volumeId: number) {
  if (props.collapsed.has(volumeId)) {
    const next = new Set(props.collapsed);
    next.delete(volumeId);
    emit("update:collapsed", next);
    await nextTick();
  }
  const el = document.getElementById(rowId(id));
  el?.scrollIntoView({ block: "nearest" });
  el?.focus();
}
const list = ref<HTMLElement | null>(null);
defineExpose({ focusRow });
</script>

<template>
  <div ref="list" class="min-h-0 flex-1 overflow-auto py-1" data-list @keydown="onListKey">
    <template v-for="v in rows" :key="v.id">
      <div
        v-if="multi"
        :id="`cvol-${bookId}-${v.id}`"
        class="sticky top-0 z-10 flex items-center gap-2 border-y border-zinc-100 bg-zinc-50 px-3 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-900"
      >
        <UiCheckbox
          :model-value="volState(v).all ? true : volState(v).some ? 'indeterminate' : false"
          size="xs"
          :aria-label="`Include every chapter of ${v.name} in the audiobook`"
          :title="
            volState(v).all
              ? `Skip all ${v.all.length} chapters of this volume`
              : `Include all ${v.all.length} chapters of this volume`
          "
          @update:model-value="emit('toggleVolume', v)"
        />
        <button
          class="min-w-0 flex-1 truncate text-left font-semibold"
          :title="v.name"
          :aria-expanded="!collapsed.has(v.id)"
          @click="toggleCollapse(v.id)"
        >
          <component
            :is="collapsed.has(v.id) ? ChevronRightIcon : ChevronDownIcon"
            class="mr-1 icon-sm text-zinc-400"
          />{{ v.name }}
          <span
            v-if="v.importing"
            class="ml-1 rounded bg-violet-500/15 px-1 py-px text-[10px] font-medium text-violet-700 dark:text-violet-300"
            >new</span
          >
        </button>
        <span
          class="shrink-0 font-mono text-[10px] text-zinc-400"
          :title="`${volState(v).on} of ${v.all.length} chapters in the audiobook`"
          >{{ volState(v).on }}/{{ v.all.length }} in<template
            v-if="narrowed && volState(v).hidden"
          >
            · {{ volState(v).hidden }} hidden</template
          ></span
        >
      </div>
      <template v-if="!collapsed.has(v.id)">
        <div
          v-for="c in v.chapters"
          :id="rowId(c.id)"
          :key="c.id"
          data-row
          tabindex="0"
          class="group grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-1.5 text-sm outline-none focus-visible:bg-zinc-100 dark:focus-visible:bg-zinc-800"
          :class="[
            opened === c.id
              ? 'bg-violet-50 dark:bg-violet-500/10'
              : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
            stateOf(c) === 'suggested' && opened !== c.id && 'bg-amber-400/5',
          ]"
          :aria-label="`Chapter ${c.id}, ${c.title}${c.note ? `, ${c.note.reason}` : ''}${c.excluded ? ', skipped' : ''}`"
          @keydown="onRowKey($event, c)"
        >
          <UiCheckbox
            class="mt-0.5"
            :model-value="!c.excluded"
            :aria-label="`Include chapter ${c.id}, ${c.title}, in the audiobook`"
            :title="c.excluded ? 'Include in the audiobook' : 'Skip for the audiobook'"
            @click="emit('toggle', c, $event)"
          />
          <span class="mt-0.5 font-mono text-[11px] text-zinc-400">{{
            String(c.id).padStart(pad, "0")
          }}</span>
          <div class="min-w-0">
            <button
              class="block w-full truncate text-left"
              :class="[
                opened === c.id && 'font-semibold',
                c.excluded && 'text-zinc-500 line-through decoration-zinc-400',
              ]"
              :title="c.title"
              tabindex="-1"
              @click="emit('open', c.id)"
            >
              {{ c.title }}
            </button>
            <div class="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500">
              <span
                v-if="STATE_CHIP[stateOf(c)]"
                class="chip shrink-0 px-1.5 py-0 text-[10px]"
                :class="STATE_CHIP[stateOf(c)]!.cls"
                >{{ STATE_CHIP[stateOf(c)]!.label }}</span
              >
              <span v-if="c.note" class="shrink-0" :class="c.excluded && 'text-zinc-400'">{{
                c.note.reason
              }}</span>
              <span v-if="c.note" class="hidden text-zinc-300 sm:inline dark:text-zinc-700">·</span>
              <span class="hidden min-w-0 truncate font-serif text-zinc-400 sm:inline">{{
                excerpt(c)
              }}</span>
            </div>
          </div>
          <span class="mt-0.5 shrink-0 font-mono text-[10px] text-zinc-400">{{
            words(c.words)
          }}</span>
        </div>
      </template>
    </template>
  </div>
</template>
