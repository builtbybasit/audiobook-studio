<script setup lang="ts">
import { useDemoStore } from "@/stores/demo";
import { useExportsStore } from "@/stores/exports";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useUiStore } from "@/stores/ui";

// Export: turn narrated chapters into an audiobook, and keep it up to date afterwards.
//
// Two tabs, because they are two jobs. **Build** is the selection on the left and everything the
// build will be on the right; **Audiobooks** is what this book has already produced, what is in each
// one, and whether it still matches the book. The tab label carries the count and a dot when
// something needs an update, so the second job never has to be remembered.
//
// The selection is the contract: whatever is ticked on the left is exactly what goes in the files.
// Chapters that cannot be exported can still be ticked — they are shown as problems with something
// to do about them, and "leave them out" untick them, so nothing is ever dropped behind your back.
//
// That contract is why Update and Retry can land here too. When one of them would have had to trim
// the selection or accept stale clips on your behalf, it stages the build instead: the form and the
// ticks arrive filled in, and the same review asks the same questions before anything is built.
import { computed, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { useBookId } from "@/composables/useBookId";
import { useBookExports } from "@/queries";
import { DEFAULT_EXPORT_SETTINGS, usable } from "@/lib/exports";
import { queryIds } from "@/lib/query";
import { plural } from "@/views/export/shared";
import EmptyState from "@/components/EmptyState.vue";
import ExportChapterList from "@/views/export/ExportChapterList.vue";
import ExportOutput from "@/views/export/ExportOutput.vue";
import ExportPlan from "@/views/export/ExportPlan.vue";
import ExportLibrary from "@/views/export/ExportLibrary.vue";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import { Download as ExportIcon } from "@lucide/vue";
import type { ExportSettings } from "@/types";

const demoStore = useDemoStore();
const exportsStore = useExportsStore();
const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();
const uiStore = useUiStore();
const route = useRoute();
const router = useRouter();
const bookId = useBookId();
// the router only reaches this view with a real book id
const book = computed(() => libraryStore.bookById(bookId)!);
const tab = ref(route.query.tab === "library" ? "library" : "build");
// the finished audiobooks: read from the server when the page opens, or the seeded world's
useBookExports(bookId);

const anyNarrated = computed(() => libraryStore.chaptersOf(bookId).some(isNarrated));
const selected = ref<number[]>([]);
const issueIds = ref<number[]>(queryIds(route.query.issue));
const settings = reactive<ExportSettings>({ ...DEFAULT_EXPORT_SETTINGS });
/** The finished export a staged build would become the next version of. */
const updates = ref<number | null>(null);

/** Opening a book fills the form from it and ticks everything that is ready to go. */
function reset() {
  const b = book.value;
  Object.assign(settings, DEFAULT_EXPORT_SETTINGS, {
    title: b.title,
    series: b.title,
    author: b.author,
    narrator: "Multi-voice · Audiobook Studio",
    filename: b.title,
    grouping: b.volumes.length > 1 ? "volume" : "single",
  });
  // everything that has audio, stale and partly narrated included: a chapter left out on your
  // behalf is exactly the omission this page is meant not to make. It opens as a decision — the
  // review names it as a blocker — not as a silent gap. `usable` is the one definition of "carries
  // audio a build can use", and the exports store reads the same one to decide whether a build
  // covers the whole book, so ticking a narrower set quietly filed the build as a chosen subset.
  selected.value = libraryStore
    .chaptersOf(bookId)
    .filter(usable)
    .map((c) => c.id);
  updates.value = null;
}
watch(() => bookId, reset, { immediate: true });
// Update and Retry hand a build back here rather than answering for you. Take it whole — the ticks,
// the settings it was built with, and which audiobook it is the next version of.
watch(
  () => exportsStore._exportDraft,
  (d) => {
    if (!d || d.bookId !== bookId) return;
    Object.assign(settings, d.settings);
    selected.value = [...d.ids];
    updates.value = d.updates;
    tab.value = "build";
    exportsStore._exportDraft = null;
  },
  { immediate: true },
);
watch(tab, (value) => {
  if (route.query.tab === (value === "library" ? "library" : undefined)) return;
  void router.replace({
    query: { ...route.query, tab: value === "library" ? "library" : undefined },
  });
});
watch(
  () => route.query.tab,
  (value) => {
    tab.value = value === "library" ? "library" : "build";
  },
);
watch(
  () => route.query.issue,
  (value) => {
    issueIds.value = queryIds(value);
  },
);

function showIssues(ids: number[]) {
  issueIds.value = [...new Set(ids)];
  void router.replace({
    query: { ...route.query, issue: issueIds.value.length ? issueIds.value.join(",") : undefined },
  });
}
function clearIssues() {
  showIssues([]);
}
// a demo scenario replaces the world under the page; the form and the selection follow it
watch(
  () => demoStore._epoch,
  () => reset(),
);

const exportsHere = computed(() => exportsStore.exportsOf(bookId));
const needUpdate = computed(
  () =>
    exportsHere.value.filter((e) => e.status === "done" && exportsStore.exportUpdateFor(e).needed)
      .length,
);
const building = computed(() => exportsHere.value.some((e) => e.status === "building"));
const failedBuilds = computed(() => exportsHere.value.filter((e) => e.status === "failed").length);

// ---- resolving problems. Each of these changes the selection or the settings and nothing else, so
// what the chapter list shows stays exactly what will be built.
function drop(ids: number[]) {
  const gone = new Set(ids);
  selected.value = selected.value.filter((id) => !gone.has(id));
  issueIds.value = [];
  uiStore.toast(`${plural(ids.length, "chapter")} left out of this build`, {
    kind: "info",
    description: "They are unticked in the list — nothing was deleted, and nothing was narrated.",
    timeout: 5000,
  });
}
function narrate(ids: number[]) {
  const chapters = libraryStore.chaptersOf(bookId).filter((c) => ids.includes(c.id));
  const scripted = chapters.filter(isScripted);
  const unscripted = chapters.filter((c) => !scripted.includes(c));
  if (!scripted.length) {
    uiStore.toast(
      `${plural(unscripted.length, "chapter")} ${unscripted.length === 1 ? "has" : "have"} no script yet`,
      {
        kind: "warn",
        description: "Narration reads a script, so these have to be scripted first.",
        action: { label: "Go to Scripting", run: () => router.push(`/book/${bookId}/scripting`) },
      },
    );
    return;
  }
  // One run, and the plan decides what each chapter contributes. Splitting it on the chapter's
  // *label* sent a chapter whose clips are fine but whose retake failed down the "everything" path,
  // re-rendering lines that had already succeeded and displacing good clips; "missing & changed" is
  // what this button is for — the lines with no usable clip and the ones the script has moved past.
  narrationStore.runNarration(
    bookId,
    scripted.map((c) => c.id),
    { scope: "fill" },
  );
  // say what was queued *and* what was not: a chapter left behind here is one the build still wants
  uiStore.toast(`Narrating ${plural(scripted.length, "chapter")}`, {
    kind: "info",
    description: unscripted.length
      ? `${plural(unscripted.length, "chapter")} in the selection ${unscripted.length === 1 ? "has" : "have"} no script yet and could not be queued.`
      : "They stay selected, so the build picks them up when the run finishes.",
    timeout: 6000,
    ...(unscripted.length
      ? {
          action: {
            label: "Script them",
            run: () => router.push(`/book/${bookId}/scripting`),
          },
        }
      : {}),
  });
}
function useStale() {
  settings.useStale = !settings.useStale;
}
async function build() {
  // with a server answering the build is a request, so the tab only moves once it has started
  const item = await exportsStore.buildExport(bookId, selected.value, settings, {
    updates: updates.value ?? undefined,
  });
  if (item) {
    updates.value = null;
    tab.value = "library";
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <TabsRoot v-model="tab" class="flex min-h-0 flex-1 flex-col">
      <div
        class="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 sm:px-4 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <TabsList class="flex items-center gap-1" aria-label="Export views">
          <TabsTrigger
            value="build"
            class="border-b-2 border-transparent px-3 py-2.5 text-sm text-zinc-500 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-100"
            >Build</TabsTrigger
          >
          <TabsTrigger
            value="library"
            class="flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-sm text-zinc-500 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-100"
            >Audiobooks
            <span class="text-zinc-400">{{ exportsHere.length }}</span>
            <span
              v-if="building"
              class="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500"
              title="a build is running"
            ></span>
            <span
              v-else-if="failedBuilds"
              class="h-1.5 w-1.5 rounded-full bg-red-500"
              :title="`${failedBuilds} failed`"
            ></span>
            <span
              v-else-if="needUpdate"
              class="h-1.5 w-1.5 rounded-full bg-violet-500"
              :title="`${needUpdate} need updating`"
            ></span
          ></TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="build" class="min-h-0 flex-1 overflow-auto p-3 focus:outline-none sm:p-4">
        <EmptyState
          v-if="!anyNarrated"
          :icon="ExportIcon"
          title="Nothing narrated yet"
          body="An audiobook is built from narrated chapters. Narrate at least one, then come back and choose what goes in."
          :steps="[
            'Script chapters',
            'Assign voices and narrate',
            'Build — and update it later as more chapters finish',
          ]"
        >
          <RouterLink :to="`/book/${bookId}/narration`" class="btn-primary"
            >Go to Narration</RouterLink
          >
        </EmptyState>
        <div
          v-else
          class="grid min-h-0 gap-4 lg:h-full lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]"
        >
          <div class="h-[55vh] min-h-0 lg:h-auto">
            <ExportChapterList
              :book-id="bookId"
              v-model="selected"
              :focus-ids="issueIds"
              @clear-focus="clearIssues"
            />
          </div>
          <div class="min-w-0 space-y-4 lg:min-h-0 lg:overflow-auto lg:pr-1">
            <ExportPlan
              :book-id="bookId"
              :settings="settings"
              :selected="selected"
              @build="build"
              @drop="drop"
              @narrate="narrate"
              @use-stale="useStale"
              @show="showIssues"
            />
            <ExportOutput :book-id="bookId" :settings="settings" :selected="selected" />
          </div>
        </div>
      </TabsContent>

      <TabsContent
        value="library"
        class="min-h-0 flex-1 overflow-auto p-3 focus:outline-none sm:p-4"
      >
        <div class="mx-auto max-w-4xl"><ExportLibrary :book-id="bookId" /></div>
      </TabsContent>
    </TabsRoot>
  </div>
</template>
