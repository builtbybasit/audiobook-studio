<script setup lang="ts">
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

// The shelf. Books first: each card says the one next thing to do, how far along it is, what is
// running or broken, and whether its audiobook still matches it. Adding is a button, a sample
// menu, or a drop anywhere on the page — the drop target only grows when a file is actually being
// dragged, so it never takes the room the books need. A book still in its contents review is a
// card of its own rather than a book that quietly went missing.
//
// The shelf has two shapes — a grid of covers, and a table with the pipeline as columns — and can
// be narrowed by a search and a state filter and put in an order. All of that lives in the URL
// (`?view=list&q=harbour&filter=attention&sort=todo`) like the rest of the workspace state, so a
// narrowed shelf can be linked to and survives a reload; the shape is remembered for the next
// visit as well.
import { useStorage } from "@vueuse/core";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { Book } from "@/types";
import EmptyState from "@/components/EmptyState.vue";
import AddEpubDialog from "@/components/AddEpubDialog.vue";
import { pendingFor, pickedFrom, type PendingAdd, type PickedFile } from "@/components/addEpub";
import ImportingCard from "@/views/library/ImportingCard.vue";
import SampleMenu from "@/views/library/SampleMenu.vue";
import ShelfGrid from "@/views/library/ShelfGrid.vue";
import ShelfTable from "@/views/library/ShelfTable.vue";
import { bookFacts } from "@/views/library/bookFacts";
import {
  asShelfFilter,
  asShelfSort,
  filterCounts,
  SHELF_FILTERS,
  SHELF_SORTS,
  shelfView,
  type ShelfEntry,
  type ShelfFilter,
  type ShelfSort,
} from "@/views/library/shelf";
import { plural } from "@/views/library/shared";
import { IMPORT_SAMPLES } from "@/mock";
import {
  LayoutGrid as GridIcon,
  Library as LibraryIcon,
  Plus as AddIcon,
  Rows3 as ListIcon,
  Search as SearchIcon,
  Upload as DropIcon,
  X as ClearIcon,
} from "@lucide/vue";

const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const uiStore = useUiStore();
const route = useRoute();
const router = useRouter();
const pending = ref<PendingAdd | null>(null);

const shelved = computed(() => libraryStore.shelved);
const importing = computed(() => libraryStore.books.filter((b) => b.importing));
const running = computed(
  () =>
    new Set(jobsStore.activeJobs.map((j) => j.bookId).filter((id) => libraryStore.bookById(id)))
      .size,
);
const subtitle = computed(() => {
  if (!shelved.value.length) return "Add an EPUB, or try a sample, to start.";
  const parts = [plural(shelved.value.length, "book")];
  if (running.value) parts.push(`${running.value} running`);
  if (importing.value.length) parts.push(`${importing.value.length} being reviewed`);
  return parts.join(" · ");
});

// ---- grid or list
type View = "grid" | "list";
const VIEW_KEY = "library.view";
const VIEWS: { key: View; label: string; icon: typeof GridIcon }[] = [
  { key: "grid", label: "Covers", icon: GridIcon },
  { key: "list", label: "Table", icon: ListIcon },
];
// the last choice, remembered per browser; the URL carries it too, for a link and a private window
const remembered = useStorage<View>(VIEW_KEY, "grid");
const view = computed<View>(() => {
  const v = route.query.view;
  if (v === "list" || v === "grid") return v;
  return remembered.value === "list" ? "list" : "grid";
});
function setView(v: View) {
  remembered.value = v;
  void router.replace({ query: { ...route.query, view: v } });
}
// a remembered choice shows in the URL too, so the link a person copies says what they saw
watch(
  () => route.query.view,
  (v) => {
    if (v !== "list" && v !== "grid" && route.path === "/library" && remembered.value === "list")
      void router.replace({ query: { ...route.query, view: "list" } });
  },
  { immediate: true },
);

// ---- search, filter, order — in the URL, read back when the URL changes
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const q = ref(text(route.query.q));
const filter = ref<ShelfFilter>(asShelfFilter(route.query.filter));
const sort = ref<ShelfSort>(asShelfSort(route.query.sort));
watch([q, filter, sort], () => {
  const next = {
    ...route.query,
    q: q.value.trim() || undefined,
    filter: filter.value === "all" ? undefined : filter.value,
    sort: sort.value === "added" ? undefined : sort.value,
  };
  if (JSON.stringify(next) !== JSON.stringify(route.query)) void router.replace({ query: next });
});
watch(
  () => route.query,
  (query) => {
    if (route.path !== "/library") return;
    if (text(query.q) !== q.value.trim()) q.value = text(query.q);
    filter.value = asShelfFilter(query.filter);
    sort.value = asShelfSort(query.sort);
  },
);

const entries = computed<ShelfEntry[]>(() =>
  shelved.value.map((book) => ({ book, facts: bookFacts(book.id) })),
);
const visible = computed(() =>
  shelfView(entries.value, { q: q.value, filter: filter.value, sort: sort.value }),
);
const counts = computed(() => filterCounts(entries.value, q.value));
const narrowed = computed(() => !!q.value.trim() || filter.value !== "all");
const visibleBooks = computed(() => visible.value.map((e) => e.book));
function clear() {
  q.value = "";
  filter.value = "all";
}

// `/` puts the cursor in the search, as in the contents review
const searchBox = ref<HTMLInputElement | null>(null);
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (t && (t.closest("input, textarea, select, [contenteditable]") || t.closest("[role=dialog]")))
    return;
  e.preventDefault();
  searchBox.value?.focus();
}

function open(b: Book) {
  uiStore.currentBookId = b.id;
  router.push(`/book/${b.id}`);
}
/** A chosen file opens the Add dialog; the review comes after. */
function addFile(picked: PickedFile, bookId: string | null = null) {
  pending.value = pendingFor(picked, bookId);
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const picked = pickedFrom(input.files);
  input.value = "";
  if (picked) addFile(picked);
}
/** One of the sample EPUBs: the same dialog, with the file and its contents already chosen. */
function addSample(id: string) {
  const s = IMPORT_SAMPLES.find((x) => x.id === id);
  if (!s) return;
  pending.value = { ...pendingFor(s.volumes[0].file, null, s.id), title: s.title };
}

// ---- drop anywhere on the page. The strip under the header is the standing hint; the full-page
// target appears only while a file is over the window, counted in and out so a drag across child
// elements does not flicker it.
const dragging = ref(false);
let depth = 0;
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
function onEnter(e: DragEvent) {
  if (!hasFiles(e)) return;
  depth++;
  dragging.value = true;
}
function onLeave(e: DragEvent) {
  if (!hasFiles(e)) return;
  depth = Math.max(0, depth - 1);
  if (!depth) dragging.value = false;
}
function onOver(e: DragEvent) {
  if (hasFiles(e)) e.preventDefault();
}
function onDrop(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  dragging.value = false;
  const picked = pickedFrom(e.dataTransfer?.files);
  if (picked) addFile(picked);
}
onMounted(() => {
  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("dragover", onOver);
  window.addEventListener("drop", onDrop);
  window.addEventListener("keydown", onKey);
});
onUnmounted(() => {
  window.removeEventListener("dragenter", onEnter);
  window.removeEventListener("dragleave", onLeave);
  window.removeEventListener("dragover", onOver);
  window.removeEventListener("drop", onDrop);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="mx-auto max-w-6xl p-4 sm:p-6">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Library</h1>
        <p class="text-sm text-zinc-500">{{ subtitle }}</p>
      </div>
      <div class="flex items-center gap-2">
        <div
          class="mr-1 inline-flex rounded-md border border-zinc-300 p-0.5 dark:border-zinc-700"
          role="group"
          aria-label="Shelf layout"
        >
          <button
            v-for="v in VIEWS"
            :key="v.key"
            class="grid h-7 w-8 place-items-center rounded transition-colors"
            :class="
              view === v.key
                ? 'bg-violet-600 text-white'
                : 'text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
            "
            :aria-pressed="view === v.key"
            :aria-label="v.label"
            :title="v.label"
            @click="setView(v.key)"
          >
            <component :is="v.icon" class="icon" />
          </button>
        </div>
        <SampleMenu @pick="addSample" />
        <label class="btn-primary cursor-pointer"
          ><AddIcon class="icon" /> Add EPUB<input
            type="file"
            accept=".epub"
            class="hidden"
            @change="onPick"
        /></label>
      </div>
    </div>

    <!-- the standing hint: one line, out of the way -->
    <p
      class="mb-4 flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-700"
    >
      <DropIcon class="icon-sm text-zinc-400" />
      Drop an .epub anywhere on this page — a new novel, or another volume of one you already have.
    </p>

    <EmptyState
      v-if="!shelved.length && !importing.length"
      :icon="LibraryIcon"
      title="No books yet"
      body="Each EPUB becomes a novel, or a volume of one you already have. You review what goes in the audiobook before it is added."
    >
      <label class="btn-primary cursor-pointer"
        ><AddIcon class="icon" /> Add EPUB<input
          type="file"
          accept=".epub"
          class="hidden"
          @change="onPick"
      /></label>
      <SampleMenu @pick="addSample" />
    </EmptyState>

    <template v-else>
      <!-- a file read but not yet added: not on the shelf, not lost either -->
      <div v-if="importing.length" class="mb-4 space-y-2">
        <ImportingCard v-for="b in importing" :key="b.id" :book="b" />
      </div>

      <!-- find, narrow, order -->
      <div v-if="shelved.length" class="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <label class="relative">
          <SearchIcon
            class="pointer-events-none absolute left-2 top-1/2 icon-sm -translate-y-1/2 text-zinc-400"
          />
          <input
            ref="searchBox"
            v-model="q"
            type="search"
            class="input w-56 pl-7 pr-7 text-xs"
            placeholder="Find a book or author…  /"
            aria-label="Find a book or author"
            @keydown.esc="q = ''"
          />
          <button
            v-if="q"
            class="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Clear the search"
            @click="q = ''"
          >
            <ClearIcon class="icon-sm" />
          </button>
        </label>
        <div class="flex flex-wrap gap-1" role="group" aria-label="Show only">
          <button
            v-for="f in SHELF_FILTERS"
            :key="f.key"
            class="chip"
            :class="filter === f.key ? 'chip-on' : 'chip-off'"
            :aria-pressed="filter === f.key"
            :disabled="!counts[f.key] && filter !== f.key"
            @click="filter = f.key"
          >
            {{ f.label }}
            <span class="ml-1 font-mono text-[10px] opacity-70">{{ counts[f.key] }}</span>
          </button>
        </div>
        <label class="ml-auto flex items-center gap-1.5 text-zinc-500">
          Order
          <select v-model="sort" class="input py-0.5 text-xs" aria-label="Order the shelf by">
            <option v-for="s in SHELF_SORTS" :key="s.key" :value="s.key">{{ s.label }}</option>
          </select>
        </label>
      </div>

      <p v-if="narrowed && visible.length" class="mb-2 text-xs text-zinc-500" aria-live="polite">
        {{ visible.length }} of {{ plural(shelved.length, "book") }} ·
        <button class="underline hover:text-zinc-800 dark:hover:text-zinc-200" @click="clear">
          Show all
        </button>
      </p>

      <div
        v-if="narrowed && !visible.length"
        class="card grid place-items-center px-6 py-10 text-center text-sm"
        aria-live="polite"
      >
        <div>
          <div class="font-medium">
            <template v-if="q.trim()">Nothing matches “{{ q.trim() }}”</template>
            <template v-else>No books here</template>
          </div>
          <p class="mt-1 text-xs text-zinc-500">
            {{ plural(shelved.length, "book") }} on the shelf<template v-if="filter !== 'all'"
              >, none of them {{ SHELF_FILTERS.find((f) => f.key === filter)?.label.toLowerCase() }}
              <template v-if="q.trim()">and matching the search</template></template
            >.
          </p>
          <button class="btn-ghost btn-xs mt-3" @click="clear">Show all books</button>
        </div>
      </div>
      <ShelfGrid
        v-else-if="view === 'grid'"
        :books="visibleBooks"
        @open="open"
        @add-volume="(b, picked) => addFile(picked, b.id)"
      />
      <ShelfTable
        v-else
        :books="visibleBooks"
        :sort="sort"
        @open="open"
        @add-volume="(b, picked) => addFile(picked, b.id)"
        @sort="(s) => (sort = s)"
      />
    </template>

    <!-- the full-page drop target, only while a file is over the window -->
    <div
      v-if="dragging"
      class="pointer-events-none fixed inset-0 z-30 grid place-items-center bg-violet-500/10 p-6 backdrop-blur-[1px]"
    >
      <div
        class="grid place-items-center rounded-2xl border-4 border-dashed border-violet-500 bg-white/90 px-10 py-8 text-center shadow-2xl dark:bg-zinc-900/90"
      >
        <DropIcon class="mb-2 h-8 w-8 text-violet-500" />
        <div class="text-lg font-medium">Drop to add</div>
        <div class="text-sm text-zinc-500">A new novel, or another volume of one you have.</div>
      </div>
    </div>

    <AddEpubDialog :pending="pending" @close="pending = null" />
  </div>
</template>
