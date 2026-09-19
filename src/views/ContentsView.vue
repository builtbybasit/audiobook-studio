<script setup lang="ts">
import { useDemoStore } from "@/stores/demo";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// Contents review: what goes in the audiobook. Reached twice — straight after an EPUB is read, when
// confirming is what adds the book to the library, and any time later from the overview, when every
// change applies at once. It is one page either way, so a chapter skipped on import is restored in
// the same place, with the same words.
//
// Nothing here removes content. A skipped chapter keeps its text, its number and its place, and
// leaves every stage and the audiobook; the suggestions the import attached are a reason beside a
// title until the person acts on them. What the button says it adds is what goes in.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useMediaQuery } from "@vueuse/core";
import { importLabel, isUndecided, plural } from "@/lib/contents";
import { useBookId } from "@/composables/useBookId";
import ContentsList, { type VolumeRow } from "@/views/contents/ContentsList.vue";
import ContentsPreview from "@/views/contents/ContentsPreview.vue";
import ContentsSuggestions from "@/views/contents/ContentsSuggestions.vue";
import { FILTER_KEYS, FILTER_LABEL, passes, type ContentsFilter } from "@/views/contents/shared";
import { UiSelect } from "@/ui";
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { BookOpen as ReadIcon, Search as SearchIcon, X as ClearIcon } from "@lucide/vue";
import type { Chapter, NoticeGroup, NoticeKind } from "@/types";

const demoStore = useDemoStore();
const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const route = useRoute();
const router = useRouter();
const bookId = useBookId();

const book = computed(() => libraryStore.bookById(bookId));
const chapters = computed(() => libraryStore.chaptersOf(bookId));
const volumes = computed(() => libraryStore.volumesOf(bookId));
const multi = computed(() => volumes.value.length > 1);
const summary = computed(() => libraryStore.contentsOf(bookId));
const groups = computed(() => libraryStore.noticeGroupsOf(bookId));
/** book: a new novel waiting to be added; volume: one more volume of a shelved book; null: shelved */
const importing = computed<"book" | "volume" | null>(() =>
  book.value?.importing ? "book" : libraryStore.importingVolume(bookId) ? "volume" : null,
);
const newVolume = computed(() => libraryStore.importingVolume(bookId));

// ---- page state, kept in the URL so leaving and coming back finds the same view
const queryText = (value: unknown) =>
  Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
const queryIds = (value: unknown) =>
  new Set(queryText(value).split(",").map(Number).filter(Number.isFinite));
const asFilter = (v: unknown): ContentsFilter =>
  FILTER_KEYS.includes(queryText(v) as ContentsFilter) ? (queryText(v) as ContentsFilter) : "all";

const q = ref(queryText(route.query.find));
const filter = ref<ContentsFilter>(asFilter(route.query.filter));
const kind = ref<NoticeKind | null>((queryText(route.query.kind) as NoticeKind) || null);
const collapsed = ref<Set<number>>(
  route.query.closed != null
    ? queryIds(route.query.closed)
    : // a new volume of a shelved book: the volumes already reviewed start folded away
      new Set(newVolume.value ? volumes.value.filter((v) => !v.importing).map((v) => v.id) : []),
);
const wide = useMediaQuery("(min-width: 1024px)");
const opened = ref<number | null>(Number(route.query.ch) || null);
// on a phone the groups would push the list off the screen, so they start folded there
const suggestionsOpen = ref(wide.value);
const search = ref<HTMLInputElement | null>(null);
const list = ref<InstanceType<typeof ContentsList> | null>(null);
const lastClicked = ref<number | null>(null);
const cancelling = ref(false);

// the first thing worth reading is the first chapter still to decide — on a clean book, nothing
if (opened.value == null && wide.value) opened.value = chapters.value.find(isUndecided)?.id ?? null;
onMounted(async () => {
  await nextTick();
  if (opened.value != null)
    document
      .getElementById(`contents-${bookId}-${opened.value}`)
      ?.scrollIntoView({ block: "center" });
});

// Reading a chapter here makes it the book's current chapter, so Scripting opens on the one you
// were just reading. Contents keeps its own first pick — the chapter still to decide — because
// that is the job this page is for.
watch(
  opened,
  (id) => {
    if (id != null) uiStore.openChapter(bookId, id);
  },
  { immediate: true },
);

watch([q, filter, kind, collapsed, opened], () => {
  const next = {
    ...route.query,
    find: q.value || undefined,
    filter: filter.value === "all" ? undefined : filter.value,
    kind: kind.value ?? undefined,
    closed: collapsed.value.size ? [...collapsed.value].sort((a, b) => a - b).join(",") : undefined,
    ch: opened.value ?? undefined,
  };
  if (JSON.stringify(next) !== JSON.stringify(route.query)) void router.replace({ query: next });
});
// a demo scenario replaces the world under the page; a seeded book is still here, so start over
watch(
  () => demoStore._epoch,
  () => {
    opened.value = chapters.value.find(isUndecided)?.id ?? null;
    filter.value = "all";
    kind.value = null;
    q.value = "";
  },
);

// ---- the list
const rows = computed<VolumeRow[]>(() =>
  volumes.value
    .map((v) => {
      const all = chapters.value.filter((c) => c.volumeId === v.id);
      return {
        ...v,
        all,
        chapters: all.filter((c) => passes(c, filter.value, kind.value, q.value)),
      };
    })
    .filter((v) => v.chapters.length),
);
const visible = computed(() => rows.value.flatMap((v) => v.chapters));
const narrowed = computed(() => !!q.value || filter.value !== "all" || !!kind.value);
const filterCounts = computed<Record<ContentsFilter, number>>(() => ({
  all: summary.value.total,
  included: summary.value.included,
  suggested: summary.value.suggested,
  review: summary.value.review,
  skipped: summary.value.skipped,
}));
const kindLabel = computed(() => groups.value.find((g) => g.kind === kind.value)?.label ?? "");

const textOf = (c: Chapter) => scriptsStore.rawText(bookId, c.id);
const openedChapter = computed(() =>
  opened.value == null ? undefined : libraryStore.chapter(bookId, opened.value),
);
const openedParts = computed(() =>
  openedChapter.value ? scriptsStore.partsOf(bookId, openedChapter.value.id) : [],
);
// With a server answering, a chapter's prose is fetched the first time it is opened. The seeded
// world generates its own and this does nothing. Either way the preview reads one getter.
watch(
  openedChapter,
  (c) => {
    if (c) void libraryStore.loadText(bookId, c.id);
  },
  { immediate: true },
);
const undecidedAfter = computed(
  () => chapters.value.filter((c) => isUndecided(c) && c.id !== opened.value).length,
);

// ---- decisions. Every one goes through the store's two actions, so the row, the preview, the
// strip and the volume header leave a chapter in exactly the same state.
function toggle(c: Chapter, e?: MouseEvent | KeyboardEvent) {
  const skip = !c.excluded;
  if (e?.shiftKey && lastClicked.value != null) {
    // a run over what is on screen, not over the whole book — the list you can see is the list
    const ids = visible.value.map((x) => x.id);
    const a = ids.indexOf(lastClicked.value);
    const b = ids.indexOf(c.id);
    if (a >= 0 && b >= 0) {
      const run = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      libraryStore.skipChapters(bookId, run, skip, {
        quiet: run.length === 1,
        scope: `chapters ${Math.min(...run)}–${Math.max(...run)}`,
      });
      lastClicked.value = c.id;
      return;
    }
  }
  libraryStore.skipChapters(bookId, [c.id], skip, { quiet: true });
  lastClicked.value = c.id;
}
function toggleVolume(v: VolumeRow) {
  const on = v.all.filter((c) => !c.excluded).length;
  const skip = on === v.all.length;
  const hidden = v.all.length - v.chapters.length;
  libraryStore.skipChapters(
    bookId,
    v.all.map((c) => c.id),
    skip,
    {
      scope: v.name + (narrowed.value && hidden ? ` (${hidden} of them hidden by the filter)` : ""),
    },
  );
}
function skipGroup(g: NoticeGroup) {
  libraryStore.skipChapters(bookId, g.pending, true, { scope: g.label.toLowerCase() });
}
function keepGroup(g: NoticeGroup) {
  libraryStore.keepChapters(bookId, g.pending);
}
function skipAllSuggested() {
  const ids = chapters.value
    .filter((c) => isUndecided(c) && c.note?.verdict === "skip")
    .map((c) => c.id);
  libraryStore.skipChapters(bookId, ids, true, { scope: "every suggested chapter" });
}
function review(k: NoticeKind | null) {
  kind.value = k;
  if (k) {
    filter.value = "all";
    const first =
      chapters.value.find((c) => c.note?.kind === k && isUndecided(c)) ??
      chapters.value.find((c) => c.note?.kind === k);
    if (first && wide.value) opened.value = first.id;
  }
}
function setFilter(f: ContentsFilter) {
  filter.value = f;
  kind.value = null;
}
function showEverything() {
  filter.value = "all";
  kind.value = null;
  q.value = "";
}

// ---- reading. Opening never touches a tick; moving keeps the list where it is.
function open(id: number) {
  opened.value = id;
}
function step(delta: number) {
  const ids = visible.value.map((c) => c.id);
  const i = opened.value == null ? -1 : ids.indexOf(opened.value);
  const next = ids[i < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, i + delta))];
  if (next != null) open(next);
}
async function nextUndecided() {
  const all = chapters.value;
  const from = opened.value == null ? -1 : all.findIndex((c) => c.id === opened.value);
  const after = all.slice(from + 1).find(isUndecided) ?? all.find(isUndecided);
  if (!after) return;
  if (!passes(after, filter.value, kind.value, q.value)) showEverything();
  open(after.id);
  await nextTick();
  await list.value?.focusRow(after.id, after.volumeId);
}
async function closeSheet() {
  const id = opened.value;
  opened.value = null;
  await nextTick();
  if (id != null) document.getElementById(`contents-${bookId}-${id}`)?.focus();
}
async function jump(id: string | number | null) {
  const next = new Set(collapsed.value);
  next.delete(Number(id));
  collapsed.value = next;
  await nextTick();
  document
    .getElementById(`cvol-${bookId}-${id}`)
    ?.scrollIntoView({ block: "start", behavior: "smooth" });
}

// ---- the import itself
const included = computed(() => {
  if (!newVolume.value) return summary.value.included;
  return chapters.value.filter((c) => c.volumeId === newVolume.value!.id && !c.excluded).length;
});
const newTotal = computed(() =>
  newVolume.value
    ? chapters.value.filter((c) => c.volumeId === newVolume.value!.id).length
    : summary.value.total,
);
const actionLabel = computed(() =>
  importLabel(importing.value === "volume" ? "volume" : "book", included.value),
);
async function confirm() {
  if (!(await libraryStore.confirmImport(bookId))) return;
  uiStore.currentBookId = bookId;
  void router.push(`/book/${bookId}`);
}
async function discard() {
  const what = await libraryStore.discardImport(bookId);
  if (!what) return;
  cancelling.value = false;
  uiStore.toast(what === "book" ? "Import cancelled" : "Volume not added", {
    kind: "info",
    description: "Nothing was added to the library.",
    timeout: 4000,
  });
  void router.push(what === "book" ? "/library" : `/book/${bookId}`);
}
</script>

<template>
  <div v-if="book" class="flex h-full min-h-0 flex-col">
    <!-- header: what this is, and the numbers that matter -->
    <div
      class="shrink-0 border-b border-zinc-200 bg-white px-4 py-3 sm:px-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div class="min-w-0">
          <div class="text-[11px] text-zinc-500">
            {{
              importing === "book"
                ? "Review contents before adding"
                : importing === "volume"
                  ? "Review the new volume before adding"
                  : "Contents"
            }}
          </div>
          <h1 class="truncate font-serif text-xl leading-tight">{{ book.title }}</h1>
          <div class="text-xs text-zinc-500">
            {{ book.author }} · {{ plural(summary.total, "chapter")
            }}<template v-if="multi"> in {{ volumes.length }} volumes</template
            ><template v-if="importing === 'volume' && newVolume">
              · {{ newVolume.name }} is new ({{ plural(newTotal, "chapter") }})</template
            ><span v-if="book.volumes[0]?.file" class="hidden font-mono sm:inline">
              · {{ (newVolume ?? book.volumes[0]).file }}</span
            >
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <p
            v-if="!summary.noted"
            class="rounded-md bg-emerald-500/10 px-3 py-1.5 text-emerald-700 dark:text-emerald-300"
          >
            No notices found. Every chapter is story and goes in the audiobook{{
              importing ? " — nothing to review." : "."
            }}
          </p>
          <template v-if="importing">
            <template v-if="cancelling">
              <span class="text-zinc-500">Discard this import? Nothing was added.</span>
              <button class="btn-ghost btn-xs" @click="cancelling = false">Keep reviewing</button>
              <button
                class="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500"
                @click="discard"
              >
                Discard
              </button>
            </template>
            <template v-else>
              <button class="btn-ghost" @click="cancelling = true">
                {{ importing === "book" ? "Cancel import" : "Don’t add this volume" }}
              </button>
              <button
                class="btn-primary"
                :disabled="!included"
                :title="!included ? 'Include at least one chapter' : ''"
                @click="confirm"
              >
                {{ actionLabel }}
              </button>
            </template>
          </template>
          <RouterLink v-else :to="`/book/${bookId}`" class="btn-ghost">Back to overview</RouterLink>
        </div>
      </div>
    </div>

    <ContentsSuggestions
      :groups="groups"
      :summary="summary"
      :kind="kind"
      v-model:open="suggestionsOpen"
      @review="review"
      @skip-group="skipGroup"
      @keep-group="keepGroup"
      @skip-all="skipAllSuggested"
    />

    <div class="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,44%)]">
      <!-- the list, with its own scroll -->
      <div class="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
        <div
          class="flex shrink-0 items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800"
        >
          <div class="input flex min-w-0 flex-1 items-center gap-1 py-0.5">
            <SearchIcon class="icon-sm shrink-0 text-zinc-400" />
            <input
              ref="search"
              v-model="q"
              class="min-w-0 flex-1 bg-transparent py-0.5 text-xs focus:outline-none"
              placeholder="Find a chapter… (title, number or reason)"
              aria-label="Find a chapter"
            />
            <button
              v-if="q"
              class="text-zinc-400 hover:text-zinc-600"
              aria-label="Clear the search"
              @click="q = ''"
            >
              <ClearIcon class="icon-sm" />
            </button>
          </div>
          <UiSelect
            v-if="multi"
            :model-value="undefined"
            :options="volumes.map((v) => ({ value: v.id, label: v.name.split('·')[0].trim() }))"
            placeholder="Jump…"
            size="xs"
            class="w-24 shrink-0"
            @update:model-value="jump"
          />
        </div>
        <div
          class="flex shrink-0 flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800"
          role="group"
          aria-label="Filter chapters"
        >
          <button
            v-for="f in FILTER_KEYS"
            :key="f"
            class="chip"
            :class="[
              filter === f && !kind && 'chip-on',
              f === 'suggested' &&
                filterCounts[f] &&
                filter !== f &&
                'border-amber-400 text-amber-600 dark:text-amber-400',
              f === 'review' &&
                filterCounts[f] &&
                filter !== f &&
                'border-violet-400 text-violet-600 dark:text-violet-400',
            ]"
            :aria-pressed="filter === f && !kind"
            :disabled="f !== 'all' && !filterCounts[f]"
            @click="setFilter(f)"
          >
            {{ FILTER_LABEL[f] }} <span class="font-mono opacity-60">{{ filterCounts[f] }}</span>
          </button>
          <button v-if="kind" class="chip chip-on" :aria-pressed="true" @click="kind = null">
            {{ kindLabel }} <ClearIcon class="icon-sm" />
          </button>
        </div>

        <ContentsList
          ref="list"
          :book-id="bookId"
          :rows="rows"
          :multi="multi"
          :total="summary.total"
          :opened="opened"
          :collapsed="collapsed"
          :text-of="textOf"
          :narrowed="narrowed"
          @open="open"
          @toggle="toggle"
          @toggle-volume="toggleVolume"
          @update:collapsed="(v) => (collapsed = v)"
          @next-undecided="nextUndecided"
          @search="search?.focus()"
        />
        <p v-if="!visible.length" class="px-3 py-8 text-center text-xs text-zinc-500">
          <template v-if="q">No chapter matches “{{ q }}”.</template>
          <template v-else-if="kind">No chapter with this note is left to show.</template>
          <template v-else>Nothing is {{ FILTER_LABEL[filter].toLowerCase() }}.</template>
          <button class="ml-1 underline" @click="showEverything">Show everything</button>
        </p>

        <div
          class="shrink-0 border-t border-zinc-200 px-3 py-1.5 text-[11px] leading-relaxed text-zinc-500 dark:border-zinc-800"
        >
          <template v-if="narrowed"
            >Showing {{ visible.length }} of {{ summary.total }} chapters ·
            <button class="underline" @click="showEverything">show everything</button>. Batch
            buttons act on the whole book; shift-click acts on what is shown.</template
          >
          <template v-else
            >shift-click ticks a range · <kbd class="font-mono">space</kbd> ticks ·
            <kbd class="font-mono">↵</kbd> reads · <kbd class="font-mono">n</kbd> next to decide ·
            <kbd class="font-mono">/</kbd> searches</template
          >
        </div>
      </div>

      <!-- the chapter being read (wide screens) -->
      <aside class="hidden min-h-0 lg:block" aria-label="Chapter">
        <ContentsPreview
          v-if="wide && openedChapter"
          :key="openedChapter.id"
          :chapter="openedChapter"
          :volume="libraryStore.volumeOf(bookId, openedChapter.id)"
          :multi="multi"
          :total="summary.total"
          :parts="openedParts"
          :undecided-left="undecidedAfter"
          @skip="libraryStore.skipChapters(bookId, [openedChapter.id], true, { quiet: true })"
          @include="libraryStore.skipChapters(bookId, [openedChapter.id], false, { quiet: true })"
          @keep="libraryStore.keepChapters(bookId, [openedChapter.id], { quiet: true })"
          @prev="step(-1)"
          @next="step(1)"
          @next-undecided="nextUndecided"
        />
        <div v-else class="grid h-full place-items-center p-8 text-center text-sm text-zinc-500">
          <div>
            <ReadIcon class="mx-auto mb-2 h-6 w-6 text-zinc-300 dark:text-zinc-600" />
            Open a chapter to read it in full.<br />
            <span class="text-xs"
              >Reading never changes a tick, and the list stays where it is.</span
            >
          </div>
        </div>
      </aside>
    </div>

    <!-- what will happen -->
    <div
      class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-200 bg-white px-4 py-2.5 text-xs sm:px-6 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div class="min-w-0 flex-1" aria-live="polite">
        <div>
          <b>{{ summary.included }}</b> of {{ summary.total }} in the audiobook
          <template v-if="summary.skipped">
            ·
            <button class="underline decoration-zinc-300" @click="setFilter('skipped')">
              {{ summary.skipped }} skipped
            </button></template
          >
          <template v-if="summary.suggested">
            ·
            <button
              class="text-amber-600 underline decoration-amber-300 dark:text-amber-400"
              @click="setFilter('suggested')"
            >
              {{ summary.suggested }} suggested, undecided
            </button></template
          >
          <template v-if="summary.review">
            ·
            <button
              class="text-violet-600 underline decoration-violet-300 dark:text-violet-400"
              @click="setFilter('review')"
            >
              {{ summary.review }} need review
            </button></template
          >
        </div>
        <div class="text-[11px] text-zinc-500">
          <template v-if="!summary.included"
            >Nothing would be included — tick at least one chapter.</template
          >
          <template v-else-if="summary.suggested && importing"
            >Undecided suggestions are included as they are; you can skip them later from this
            page.</template
          >
          <template v-else-if="importing"
            >Skipped chapters stay in the book and can be restored from this page later.</template
          >
          <template v-else
            >Changes apply now to scripting, narration and export. Skipped chapters can be restored
            any time.</template
          >
        </div>
      </div>
    </div>

    <!-- narrow screens: the chapter opens as a sheet over the list -->
    <DialogRoot v-if="!wide" :open="!!openedChapter" @update:open="(v) => !v && closeSheet()">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-40 bg-black/40" />
        <DialogContent
          class="fixed inset-x-0 bottom-0 z-50 flex h-[88dvh] flex-col rounded-t-2xl bg-white shadow-2xl focus:outline-none dark:bg-zinc-900"
          :aria-describedby="undefined"
        >
          <DialogTitle class="sr-only">{{ openedChapter?.title }}</DialogTitle>
          <ContentsPreview
            v-if="openedChapter"
            :key="openedChapter.id"
            :chapter="openedChapter"
            :volume="libraryStore.volumeOf(bookId, openedChapter.id)"
            :multi="multi"
            :total="summary.total"
            :parts="openedParts"
            :undecided-left="undecidedAfter"
            sheet
            @skip="libraryStore.skipChapters(bookId, [openedChapter.id], true, { quiet: true })"
            @include="libraryStore.skipChapters(bookId, [openedChapter.id], false, { quiet: true })"
            @keep="libraryStore.keepChapters(bookId, [openedChapter.id], { quiet: true })"
            @prev="step(-1)"
            @next="step(1)"
            @next-undecided="nextUndecided"
            @close="closeSheet"
          />
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
