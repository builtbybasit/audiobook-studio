<script setup lang="ts">
// The sheet's first view: every effect, plus None, to try on the sheet's line and choose.
//
// The highlighted row is what the subject hears now (`choice.current`). A click on a row chooses
// it and plays it; ▶ only plays. One box above the list says what is used and where it comes
// from, and a change made here leaves a line under it naming the change in its scope, with Undo.
// The one action that reaches past the subject — making the chosen row the level above's — sits
// on that row alone and names its scope.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  Copy as CopyIcon,
  Loader2 as SpinIcon,
  Pause as PauseIcon,
  Pencil as EditIcon,
  Play as PlayIcon,
  Plus as AddIcon,
} from "@lucide/vue";

import { plural } from "@/lib/contents";
import { useCastStore } from "@/stores/cast";
import { useEffectsStore } from "@/stores/effects";
import type { Effect } from "@/types";
import { summaryOf } from "./catalog";
import { uniqueName } from "./chain";
import type { Choice, ChoiceView, Row } from "./choice";
import { sheetOnTop } from "./sheetOnTop";
import { useThinkers, type TryLine } from "./lines";
import type { Previews } from "./preview";

const props = defineProps<{
  bookId: string;
  view: ChoiceView;
  /** the speaker's name; empty on the book's sheet */
  name: string;
  line: TryLine | null;
  /** the list is the view on screen: its keys work */
  active: boolean;
  choice: Choice;
  previews: Previews;
}>();
const emit = defineEmits<{ edit: [id: string]; paste: [] }>();
const effectsStore = useEffectsStore();
const castStore = useCastStore();

interface Card {
  id: Row;
  name: string;
  summary: string;
  effect: Effect | null;
}
const cards = computed<Card[]>(() => [
  {
    id: "none",
    name: "None",
    summary: props.view === "effect" ? "The voice as it was made" : "Thoughts left plain",
    effect: null,
  },
  ...effectsStore.effects.map((e) => ({
    id: e.id,
    name: e.name,
    summary: summaryOf(e.chain),
    effect: e,
  })),
]);
const current = computed(() => props.choice.current.value);
const labelOf = (row: Row) => props.choice.labelOf(row);

// ---------- the book's one line about its speakers ----------
const thinkers = useThinkers(
  () => props.bookId,
  () => props.view === "book",
);
const bookCounts = computed(() => {
  const own = new Set(
    castStore
      .charactersOf(props.bookId)
      .filter((c) => c.thoughts)
      .map((c) => c.name),
  );
  const mine = [...thinkers.value].filter((n) => own.has(n)).length;
  return { using: thinkers.value.size - mine, own: mine };
});

// ---------- playing: one row at a time ----------
const el = new Audio();
const playing = ref<Row | null>(null);
const loading = ref<Row | null>(null);
el.addEventListener("ended", () => (playing.value = null));
el.addEventListener("pause", () => (playing.value = null));
function stop() {
  el.pause();
  playing.value = null;
  loading.value = null;
}
async function play(row: Row, restart = false) {
  const l = props.line;
  if (!l) return;
  if (playing.value === row && !restart) return stop();
  stop();
  loading.value = row;
  const url = await props.previews.urlFor(l.url, props.choice.effectsFor(l, row));
  // another row or line was asked for since: that one wins
  if (loading.value !== row || props.line !== l) return;
  loading.value = null;
  if (!url) return;
  el.src = url;
  await el.play().catch(() => {});
  playing.value = row;
}
// a new line plays through the row that was playing
watch(
  () => props.line?.key,
  () => {
    const was = playing.value;
    stop();
    if (was) void play(was, true);
  },
);
watch(
  () => props.active,
  (on) => {
    if (!on) stop();
  },
);

// ---------- choosing ----------
const focus = ref(
  Math.max(
    0,
    cards.value.findIndex((c) => c.id === current.value),
  ),
);
const list = ref<HTMLElement | null>(null);
function focusRow(i: number) {
  focus.value = i;
  const li = list.value?.querySelector<HTMLElement>(`[data-row="${i}"]`);
  li?.focus();
  li?.scrollIntoView({ block: "nearest" });
}
/** a click on a row chooses it and plays it */
function pick(i: number) {
  const c = cards.value[i];
  if (!c) return;
  focus.value = i;
  if (c.id !== current.value) props.choice.choose(c.id);
  void play(c.id, true);
}

/** the copy just made, marked in the list until the next one */
const justMade = ref<string | null>(null);
/** A copy right under the original, chosen for this subject; the list stays in view. */
async function duplicate(c: Card) {
  if (!c.effect) return;
  const copy = await effectsStore.duplicate(c.effect.id);
  if (!copy) return;
  props.choice.choose(copy.id);
  justMade.value = copy.id;
  await nextTick();
  focusRow(cards.value.findIndex((x) => x.id === copy.id));
}

async function newEffect() {
  const name = uniqueName("New effect", new Set(effectsStore.effects.map((e) => e.name)));
  const made = await effectsStore.create(name, []);
  if (made) emit("edit", made.id);
}

// ---------- keys, while the list is on screen: ↑↓, space, enter ----------
function onKey(e: KeyboardEvent) {
  if (!props.active || e.metaKey || e.ctrlKey || e.altKey || !sheetOnTop()) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, select, [contenteditable]")) return;
  const onControl = !!t?.closest("button, [role=switch], [role=slider], [role=radio]");
  const n = cards.value.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    focusRow((focus.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
  } else if (e.key === " " && !onControl) {
    e.preventDefault();
    const c = cards.value[focus.value];
    if (c) void play(c.id);
  } else if (e.key === "Enter" && !onControl) {
    e.preventDefault();
    const c = cards.value[focus.value];
    if (c && c.id !== current.value) props.choice.choose(c.id);
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  stop();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="space-y-2 px-3 pt-3">
      <!-- what is used now, and where it comes from -->
      <div class="rounded-md bg-zinc-100 px-2.5 py-2 text-xs dark:bg-zinc-800/70">
        <template v-if="view === 'effect'">
          {{ name }} uses: <b>{{ labelOf(current) }}</b>
        </template>
        <template v-else-if="view === 'thoughts' && choice.following.value">
          {{ name }}’s thoughts follow this book: <b>{{ labelOf(current) }}</b>
        </template>
        <template v-else-if="view === 'thoughts'">
          {{ name }}’s thoughts use their own: <b>{{ labelOf(current) }}</b> ·
          <button
            class="text-violet-600 hover:underline dark:text-violet-400"
            @click="choice.choose(choice.above.value)"
          >
            Follow this book again
          </button>
        </template>
        <template v-else>
          <template v-if="choice.following.value">
            This book follows all books: <b>{{ labelOf(current) }}</b>
          </template>
          <template v-else>
            This book uses its own: <b>{{ labelOf(current) }}</b> ·
            <button
              class="text-violet-600 hover:underline dark:text-violet-400"
              @click="choice.choose(choice.above.value)"
            >
              Follow all books again
            </button>
          </template>
          <div class="mt-0.5 text-[11px] text-zinc-500">
            {{ plural(bookCounts.using, "speaker uses", "speakers use") }} it · {{ bookCounts.own }}
            {{ bookCounts.own === 1 ? "has" : "have" }} their own
          </div>
        </template>
      </div>
      <div
        v-if="choice.changed.value"
        class="flex items-center gap-2 rounded-md bg-emerald-50 px-2.5 py-1.5 text-[11px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"
        role="status"
      >
        <span class="flex-1">{{ choice.changed.value.text }}</span>
        <button class="font-medium hover:underline" @click="choice.undo()">Undo</button>
      </div>
    </div>

    <ul ref="list" class="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
      <li
        v-for="(c, i) in cards"
        :key="c.id"
        :data-row="i"
        tabindex="0"
        class="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        :class="
          c.id === current
            ? 'border-violet-500 bg-violet-50/70 ring-1 ring-violet-500 dark:border-violet-500/70 dark:bg-violet-500/10'
            : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
        "
        :aria-current="c.id === current ? 'true' : undefined"
        @click="pick(i)"
        @focus="focus = i"
      >
        <button
          class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-white disabled:opacity-40"
          :class="
            c.effect
              ? 'bg-violet-600 hover:bg-violet-500'
              : 'bg-zinc-500 hover:bg-zinc-400 dark:bg-zinc-600'
          "
          :disabled="!line"
          :aria-label="`${playing === c.id ? 'Stop' : 'Play'} the line through ${c.name}`"
          @click.stop="play(c.id)"
        >
          <SpinIcon v-if="loading === c.id" class="icon animate-spin" />
          <PauseIcon v-else-if="playing === c.id" class="icon icon-fill" />
          <PlayIcon v-else class="icon icon-fill" />
        </button>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <b class="truncate text-sm">{{ c.name }}</b>
            <span
              v-if="justMade === c.id"
              class="shrink-0 rounded bg-emerald-500/15 px-1.5 py-px text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
              >new copy</span
            >
            <span
              v-if="view === 'book' && c.id === choice.libraryRow.value"
              class="shrink-0 rounded bg-sky-500/15 px-1.5 py-px text-[10px] font-semibold text-sky-700 dark:text-sky-300"
              >All books</span
            >
            <span
              v-if="view === 'thoughts' && c.id === choice.bookRow.value"
              class="shrink-0 rounded bg-amber-400/20 px-1.5 py-px text-[10px] font-semibold text-amber-700 dark:text-amber-300"
              >This book</span
            >
          </div>
          <div class="truncate text-[11px] text-zinc-500" :title="c.summary">{{ c.summary }}</div>
        </div>
        <button
          v-if="choice.canRaise(c.id)"
          class="btn-ghost btn-xs shrink-0"
          @click.stop="choice.raise(c.id)"
        >
          {{ view === "book" ? "Make default for all books" : "Make default for this book" }}
        </button>
        <template v-if="c.effect">
          <button
            class="shrink-0 rounded p-1 text-zinc-400 hover:text-violet-600"
            :aria-label="`Duplicate ${c.name}`"
            title="Duplicate"
            @click.stop="duplicate(c)"
          >
            <CopyIcon class="icon-sm" />
          </button>
          <button
            class="shrink-0 rounded p-1 text-zinc-400 hover:text-violet-600"
            :aria-label="`Edit ${c.name}`"
            title="Edit"
            @click.stop="emit('edit', c.id)"
          >
            <EditIcon class="icon-sm" />
          </button>
        </template>
      </li>
    </ul>

    <div class="flex items-center gap-3 border-t border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
      <button class="btn-ghost btn-xs" @click="newEffect">
        <AddIcon class="icon-sm" /> New effect
      </button>
      <button class="text-xs text-zinc-500 hover:text-violet-600" @click="emit('paste')">
        Paste Python…
      </button>
      <span class="ml-auto font-mono text-[10px] text-zinc-400">↑↓ · space · enter</span>
    </div>
  </div>
</template>
