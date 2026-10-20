<script setup lang="ts">
import { chapterName } from "@/lib/chapterNumber";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";

// Scripting stage: one bar — chapters, prev/next, the endpoint, the estimate, run — over the
// chapter rail and the script reader. The rail hides for reading; the reader's focus mode hides both.
import { computed, ref } from "vue";
import { useStorage } from "@vueuse/core";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { isScripted } from "@/lib/scriptReview";
import { runActionLabel, runSummary, skipSummary } from "@/lib/runPlan";
import { money } from "@/lib/pricing";
import { aboutDuration } from "@/lib/time";
import ChapterPicker from "@/components/ChapterPicker.vue";
import EmptyState from "@/components/EmptyState.vue";
import {
  ChevronDown as OpenIcon,
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
  ListChecks as ChaptersIcon,
  PencilLine as ScriptingIcon,
  Play as RunIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import ScriptReader from "@/views/scripting/ScriptReader.vue";
import ScriptEstimate from "@/views/scripting/ScriptEstimate.vue";
import ScriptEndpoints from "@/views/scripting/ScriptEndpoints.vue";
import { useBookId } from "@/composables/useBookId";
import { useOpenedChapter } from "@/composables/useOpenedChapter";
import { useCast, useChapterScript, useChapterTexts } from "@/queries";
import type { Chapter } from "@/types";
import { scriptExportUrl } from "@/services/library";

const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();
const bookId = useBookId();
useCast(bookId);
const selected = ref<number[]>([]);
const rail = useStorage("audiobook-ui.scripting-rail", true);
const focusReader = ref(false);
const { opened, open: openChapter } = useOpenedChapter(
  bookId,
  (chapters) =>
    chapters.find((c) => c.scripting === "fallback")?.id ?? chapters.find(isScripted)?.id,
);
const { loaded, status: scriptStatus, refetch: readScript } = useChapterScript(bookId, opened);
// Text of every chapter a run could start on; until it is read, the estimate says so and no run
// starts.
const { unread } = useChapterTexts(
  bookId,
  () => [...new Set([...selected.value, opened.value])],
  "plain",
);
// Stable for the picker's life: an inline function is a new prop each render, and each landing
// chapter text re-renders this page, re-running every picker row.
const notBusy = (c: Chapter) => !["running", "queued"].includes(c.scripting);
const plan = computed(() => scriptingStore.scriptPlan(bookId, selected.value));
const estimate = computed(() => scriptingStore.scriptEstimateOf(bookId, plan.value));
const runNote = computed(() => {
  if (!plan.value.chapters.length) return "";
  // the request count is not a count until every chapter's text is in
  const summary = runSummary(plan.value);
  if (estimate.value.reading) summary.splice(-1, 1, "counting requests…");
  return (
    summary.join(" · ") +
    (plan.value.replace ? " · each replaced script is kept in its chapter's history" : "")
  );
});
const runDisabled = computed(() => !plan.value.chapters.length || !!estimate.value.blockers.length);
const estimateLabel = computed(() =>
  !plan.value.chapters.length
    ? "Estimate"
    : estimate.value.reading
      ? "counting…"
      : `${money(estimate.value.cost)} · ${aboutDuration(estimate.value.seconds)}`,
);
const profile = computed(() => scriptingStore.runProfile);

const chapter = computed(() => libraryStore.chapter(bookId, opened.value));
const number = computed(() => libraryStore.numberOf(bookId, opened.value));
const openedName = computed(() => chapterName(number.value));
// Imported titles often start with their own number ("12: Chapter 12 …"); the bar already says it.
const title = computed(() => chapter.value?.title.replace(/^\d+:\s*/, "") ?? "");
const kept = computed(() => libraryStore.chaptersOf(bookId).filter((c) => !c.excluded));
const at = computed(() => kept.value.findIndex((c) => c.id === opened.value));
const prev = computed(() => kept.value[at.value - 1]);
const next = computed(() => kept.value[at.value + 1]);
const hasScript = computed(() => chapter.value && isScripted(chapter.value));
/** scripts and texts still on their way, which the reader and the buttons wait for */
const waiting = computed(() => (hasScript.value && !loaded.value) || unread.value > 0);
const anyScripted = computed(() => libraryStore.chaptersOf(bookId).some(isScripted));
/** Its last failed run: what the server said, and whether smaller chunks may help. */
const failure = computed(() => {
  // the queue lists oldest first
  const job = jobsStore.jobs
    .filter(
      (j) =>
        j.kind === "scripting" &&
        j.bookId === bookId &&
        j.chapterId === opened.value &&
        j.status === "failed",
    )
    .at(-1);
  const said = job?.activity?.filter((e) => e.detail?.error).at(-1)?.detail?.error;
  return {
    error: said == null ? "Scripting failed, so nothing was kept." : String(said),
    smaller: !!job?.activity?.some((e) => e.detail?.smallerChunks),
  };
});
function scriptFirst() {
  const ids = kept.value.slice(0, 3).map((c) => c.id);
  selected.value = ids;
  void scriptingStore.startRun(bookId, ids);
}
</script>

<template>
  <div class="flex h-[calc(100dvh-88px)] flex-col gap-3 p-4">
    <div v-if="!focusReader" class="card flex flex-wrap items-center gap-2 px-3 py-2">
      <button
        class="btn-ghost btn-xs"
        :class="rail && 'bg-zinc-200 dark:bg-zinc-800'"
        :aria-pressed="rail"
        :data-tip="rail ? 'Hide the chapter list' : 'Show the chapter list'"
        @click="rail = !rail"
      >
        <ChaptersIcon class="icon-sm" /> Chapters
        <span
          v-if="selected.length"
          class="rounded-full bg-violet-600 px-1.5 text-[10px] font-semibold text-white"
          >{{ selected.length }}</span
        >
      </button>
      <button
        class="btn-ghost btn-xs"
        :disabled="!prev"
        aria-label="Previous chapter"
        data-tip="Previous chapter"
        @click="prev && openChapter(prev.id)"
      >
        <PrevIcon class="icon-sm" />
      </button>
      <span class="min-w-0 flex-1 truncate text-sm">
        <span class="font-medium">{{ number ? `Chapter ${number}` : "Skipped chapter" }}</span>
        <span class="text-zinc-500"> · {{ title }}</span>
      </span>
      <button
        class="btn-ghost btn-xs"
        :disabled="!next"
        aria-label="Next chapter"
        data-tip="Next chapter"
        @click="next && openChapter(next.id)"
      >
        <NextIcon class="icon-sm" />
      </button>

      <PopoverRoot>
        <PopoverTrigger class="btn-ghost btn-xs" data-tip="The endpoint runs go to, and its health">
          <span
            class="h-1.5 w-1.5 rounded-full"
            :class="profile?.enabled ? 'bg-emerald-500' : 'bg-zinc-400'"
          ></span>
          {{ profile?.name ?? "No endpoint" }}
          <OpenIcon class="icon-sm opacity-60" />
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent align="end" :side-offset="6" class="ui-popup w-[660px] max-w-[95vw] p-0">
            <div class="max-h-[70vh] overflow-auto"><ScriptEndpoints /></div>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
      <PopoverRoot>
        <PopoverTrigger class="btn-ghost btn-xs font-mono" data-tip="What this run would cost">
          {{ estimateLabel }}
          <OpenIcon class="icon-sm opacity-60" />
        </PopoverTrigger>
        <PopoverPortal>
          <!-- focus stays on the trigger: the first field is the budget cap, and a stray key would edit it -->
          <PopoverContent
            align="end"
            :side-offset="6"
            class="ui-popup w-80 p-0"
            @open-auto-focus.prevent
          >
            <div class="max-h-[70vh] overflow-auto">
              <ScriptEstimate :book-id="bookId" :plan="plan" :est="estimate" />
            </div>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>
      <button
        class="btn-primary btn-xs"
        :disabled="runDisabled"
        :data-tip="runNote"
        @click="scriptingStore.startRun(bookId, selected)"
      >
        <RunIcon class="icon-sm icon-fill" /> {{ runActionLabel(plan) }} ({{
          plan.chapters.length
        }})
      </button>
    </div>

    <div
      class="grid min-h-0 flex-1 gap-3"
      :class="
        rail &&
        !focusReader &&
        'grid-rows-[420px_minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-1'
      "
    >
      <div v-if="rail && !focusReader" class="flex min-h-0 flex-col gap-2">
        <div class="min-h-0 flex-1">
          <ChapterPicker
            :book-id="bookId"
            stage="scripting"
            v-model="selected"
            :opened-id="opened"
            :run-label="runActionLabel(plan)"
            :run-count="plan.chapters.length"
            :run-note="runNote"
            :run-skipped="skipSummary(plan)"
            :run-disabled="!!estimate.blockers.length"
            :selectable="notBusy"
            @open="openChapter"
            @run="(ids) => scriptingStore.startRun(bookId, ids)"
          />
        </div>
        <div class="flex shrink-0 items-center gap-3 px-1 text-xs text-zinc-500">
          <span>Script file</span>
          <RouterLink
            :to="`/book/${bookId}/script-import`"
            class="text-violet-600 hover:underline dark:text-violet-400"
            >Import script…</RouterLink
          >
          <a
            :href="scriptExportUrl(bookId)"
            download
            class="text-violet-600 hover:underline dark:text-violet-400"
            >Export script</a
          >
        </div>
      </div>

      <div class="min-h-0 min-w-0">
        <div
          v-if="hasScript && !loaded"
          class="card grid h-full place-content-center p-8 text-sm text-zinc-500"
          role="status"
        >
          <template v-if="scriptStatus === 'error'"
            >The script of {{ openedName }} could not be read.
            <button
              class="mt-2 text-violet-600 hover:underline dark:text-violet-400"
              @click="readScript()"
            >
              Try again
            </button></template
          >
          <template v-else>Reading {{ openedName }}’s script…</template>
        </div>
        <ScriptReader
          v-else-if="hasScript"
          :book-id="bookId"
          :chapter-id="opened"
          :focus-mode="focusReader"
          :key="opened"
          @toggle-focus="focusReader = !focusReader"
        />
        <EmptyState
          v-else-if="!anyScripted && chapter?.scripting === 'none'"
          :icon="ScriptingIcon"
          title="Nothing scripted yet"
          body="Scripting reads each chapter with the LLM, splits it into speaker runs, and verifies nothing was dropped. Start with the first few chapters to discover the cast."
          :steps="[
            'Pick an endpoint in the bar above',
            'Tick chapters (or use Pending) and run',
            'Review the cast and merge aliases before narrating',
          ]"
        >
          <button class="btn-primary" @click="scriptFirst">Script the first 3 chapters</button>
        </EmptyState>
        <EmptyState
          v-else-if="chapter?.scripting === 'running' || chapter?.scripting === 'queued'"
          :icon="ScriptingIcon"
          :title="chapter.title"
          :body="
            chapter.scripting === 'queued'
              ? 'Queued — waiting for the previous chapter so context carries forward.'
              : `Extracting segments… ${Math.round(chapter.scriptingProgress)}%`
          "
        />
        <EmptyState
          v-else-if="chapter?.scripting === 'failed'"
          :icon="WarnIcon"
          :title="chapter.title"
          :body="failure.error"
        >
          <button
            class="btn-primary"
            :disabled="waiting"
            @click="scriptingStore.startRun(bookId, [opened])"
          >
            Re-run this chapter
          </button>
          <button
            v-if="failure.smaller"
            class="btn-ghost"
            :disabled="waiting || !scriptingStore.runProfile"
            :data-tip="
              scriptingStore.runProfile
                ? `Halves ${scriptingStore.runProfile.name}'s chunks — for every book it scripts`
                : 'No scripting endpoint can run'
            "
            @click="scriptingStore.smallerChunks(bookId, opened)"
          >
            Smaller chunks + re-run
          </button>
        </EmptyState>
        <EmptyState
          v-else
          :icon="ScriptingIcon"
          :title="chapter?.title"
          body="Not scripted yet. Tick it in the list and run scripting, or script just this one."
        >
          <button
            class="btn-primary"
            :disabled="waiting"
            @click="scriptingStore.startRun(bookId, [opened])"
          >
            Script this chapter
          </button>
        </EmptyState>
      </div>
    </div>
  </div>
</template>
