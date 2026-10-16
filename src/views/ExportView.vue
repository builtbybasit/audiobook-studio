<script setup lang="ts">
import { useExportsStore } from "@/stores/exports";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// Export: build an audiobook from narrated chapters (Build), and keep built ones up to date
// (Audiobooks). The selection is the contract: what is ticked is exactly what goes in the files, so
// unexportable chapters stay ticked as problems, and Update/Retry stage a build here instead of
// trimming the selection for you.
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { useBookId } from "@/composables/useBookId";
import { enumParam, useQueryParam } from "@/composables/useQueryParam";
import { useBookScripts } from "@/queries";
import { useBookExportsKeptUp } from "@/views/export/shared";
import { DEFAULT_EXPORT_SETTINGS, usable } from "@/lib/exports";
import { queryIds } from "@/lib/query";
import { plural } from "@/lib/contents";
import EmptyState from "@/components/EmptyState.vue";
import ExportChapterList from "@/views/export/ExportChapterList.vue";
import ExportOutput from "@/views/export/ExportOutput.vue";
import ExportPlan from "@/views/export/ExportPlan.vue";
import ExportLibrary from "@/views/export/ExportLibrary.vue";
import { UiTabs } from "@/ui";
import { TabsContent, TabsRoot } from "reka-ui";
import { Download as ExportIcon } from "@lucide/vue";
import type { ExportSettings } from "@/types";

const exportsStore = useExportsStore();
const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const router = useRouter();
const bookId = useBookId();
const book = computed(() => libraryStore.bookById(bookId)!);
const TABS = [
  { value: "build", label: "Build" },
  { value: "library", label: "Audiobooks" },
] as const;
const tab = useQueryParam("tab", enumParam(["build", "library"], "build"));
useBookExportsKeptUp(bookId);
// the review and the preview read every scripted chapter's lines
const scripts = useBookScripts(bookId);

const anyNarrated = computed(() => libraryStore.chaptersOf(bookId).some(isNarrated));
const selected = ref<number[]>([]);
/** Selected chapters whose script failed to read, and whether any is still on its way. */
const unread = computed(() => selected.value.filter((id) => scripts.failed.value.includes(id)));
const reading = computed(() =>
  selected.value.some((id) => {
    const c = libraryStore.chapter(bookId, id);
    return (
      !!c && isScripted(c) && !scriptsStore.held(bookId, id) && !scripts.failed.value.includes(id)
    );
  }),
);
const issueIds = useQueryParam<number[]>("issue", {
  parse: queryIds,
  serialize: (ids) => ids.join(",") || undefined,
  default: () => [],
});
const settings = reactive<ExportSettings>({ ...DEFAULT_EXPORT_SETTINGS });
/** The finished export a staged build would become the next version of. */
const updates = ref<number | null>(null);

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
  // everything with audio, stale and partly narrated included: a chapter left out for you is the
  // omission this page exists to prevent. `usable` is the same test the exports store uses to
  // decide a build covers the whole book.
  selected.value = libraryStore
    .chaptersOf(bookId)
    .filter(usable)
    .map((c) => c.id);
  updates.value = null;
}
watch(() => bookId, reset, { immediate: true });
// Update and Retry hand a build back here: take the ticks, the settings and the version it updates.
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

function showIssues(ids: number[]) {
  issueIds.value = [...new Set(ids)];
}
function clearIssues() {
  showIssues([]);
}

const exportsHere = computed(() => exportsStore.exportsOf(bookId));
const needUpdate = computed(
  () =>
    exportsHere.value.filter((e) => e.status === "done" && exportsStore.exportUpdateFor(e).needed)
      .length,
);
const building = computed(() => exportsHere.value.some((e) => e.status === "building"));
const failedBuilds = computed(() => exportsHere.value.filter((e) => e.status === "failed").length);

// Resolving problems: each changes only the selection or settings, so the list stays what is built.
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
  // One run: the plan decides what each chapter contributes. Splitting on the chapter's label
  // sent a chapter with a failed retake down the "everything" path and re-rendered good clips.
  void narrationStore.startRun(
    bookId,
    scripted.map((c) => c.id),
    { scope: "fill" },
  );
  // say what was not queued too: the build still wants it
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
  // the build is a request, so the tab only moves once it has started
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
        <UiTabs :tabs="TABS" aria-label="Export views">
          <template #tab="{ tab: t }">
            <template v-if="t.value === 'library'">
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
              ></span>
            </template>
          </template>
        </UiTabs>
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
              :reading="reading"
              :unread="unread"
              @read-again="scripts.retry"
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
