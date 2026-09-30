<script setup lang="ts">
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

// The shelf. Books first: each card says the one next thing to do, how far along it is, what is
// running or broken, and whether its audiobook still matches it. Adding is a button or a drop
// anywhere on the page — the drop target only grows when a file is actually being dragged, so it never takes the room the books need. A book still in its contents review is a
// card of its own rather than a book that quietly went missing.
//
// The shelf has two shapes — a grid of covers, and a table with the pipeline as columns — and can
// be narrowed by a search and a state filter and put in an order. All of that lives in the URL
// (`?view=list&q=harbour&filter=attention&sort=todo`) like the rest of the workspace state, so a
// narrowed shelf can be linked to and survives a reload; the shape is remembered for the next
// visit as well.
//
// With the server not answering, the shelf is not empty but unknown, so the page says that where
// the books would be — how to start the server, and a retry. The demo is the server's too, so it
// is no way round it.
import { useStorage } from "@vueuse/core";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import type { Book } from "@/types";
import EmptyState from "@/components/EmptyState.vue";
import AddEpubDialog from "@/components/AddEpubDialog.vue";
import { pendingFor, pickedFrom, type PendingAdd, type PickedFile } from "@/components/addEpub";
import ImportingCard from "@/views/library/ImportingCard.vue";
import ShelfGrid from "@/views/library/ShelfGrid.vue";
import ShelfTable from "@/views/library/ShelfTable.vue";
import { bookFacts } from "@/views/library/bookFacts";
import {
  filterCounts,
  SHELF_FILTERS,
  SHELF_SORTS,
  shelfView,
  type ShelfEntry,
  type ShelfSort,
} from "@/views/library/shelf";
import { plural } from "@/lib/contents";
import { enumParam, textParam, useQueryParam } from "@/composables/useQueryParam";
import { UiSelect } from "@/ui";
import {
  LayoutGrid as GridIcon,
  Library as LibraryIcon,
  Plus as AddIcon,
  Rows3 as ListIcon,
  RotateCw as RetryIcon,
  Search as SearchIcon,
  ServerOff as OfflineIcon,
  Upload as DropIcon,
  X as ClearIcon,
} from "@lucide/vue";

const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const uiStore = useUiStore();
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
  if (libraryStore.unreachable) return "Your library is on the server, which is not answering.";
  if (!shelved.value.length) return "Add an EPUB to start.";
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
const inUrl = useQueryParam("view", enumParam<View, null>(["grid", "list"], null));
const view = computed<View>(() => inUrl.value ?? (remembered.value === "list" ? "list" : "grid"));
function setView(v: View) {
  remembered.value = v;
  inUrl.value = v;
}
// a remembered choice shows in the URL too, so the link a person copies says what they saw
watch(
  inUrl,
  (v) => {
    if (v == null && remembered.value === "list") inUrl.value = "list";
  },
  { immediate: true },
);

// ---- search, filter, order — in the URL, read back when the URL changes
const q = useQueryParam("q", textParam({ trim: true }));
const filter = useQueryParam(
  "filter",
  enumParam(
    SHELF_FILTERS.map((f) => f.key),
    "all",
  ),
);
const sort = useQueryParam(
  "sort",
  enumParam(
    SHELF_SORTS.map((s) => s.key),
    "added",
  ),
);
const SORT_OPTIONS = SHELF_SORTS.map((s) => ({ value: s.key, label: s.label }));

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
// Loading the page again reads everything a server that just started has: the shelf, the
// endpoints and the queue alike.
const retry = () => location.reload();

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
      v-if="!libraryStore.unreachable"
      class="mb-4 flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-700"
    >
      <DropIcon class="icon-sm text-zinc-400" />
      Drop an .epub anywhere on this page — a new novel, or another volume of one you already have.
    </p>

    <!-- no server: a library that cannot be read is not an empty one -->
    <div
      v-if="libraryStore.unreachable"
      role="alert"
      class="card grid place-items-center p-8 text-center"
    >
      <div class="max-w-md">
        <div
          class="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-red-50 text-red-500 dark:bg-red-500/10"
        >
          <OfflineIcon class="h-6 w-6" />
        </div>
        <div class="text-lg font-medium">The server is not running</div>
        <p class="mt-1 text-sm text-zinc-500">
          Your books, scripts and audio are kept by the server, and nothing answered for it. Start
          it with <code class="font-mono">pnpm dev</code>, which runs it beside this page, then try
          again.
        </p>
        <button class="btn-primary mt-4" @click="retry">
          <RetryIcon class="icon" /> Try again
        </button>
      </div>
    </div>

    <EmptyState
      v-else-if="!shelved.length && !importing.length"
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
          <UiSelect
            :model-value="sort"
            :options="SORT_OPTIONS"
            size="xs"
            class="w-40"
            aria-label="Order the shelf by"
            @update:model-value="(v) => (sort = v as ShelfSort)"
          />
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
