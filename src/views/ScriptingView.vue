<script setup lang="ts">
import { chapterName } from "@/lib/chapterNumber";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";

// Scripting stage: chapter picker + run settings on the left, script reader on the right.
import { computed, nextTick, ref } from "vue";
import { isScripted } from "@/lib/scriptReview";
import { runActionLabel, runSummary, skipSummary } from "@/lib/runPlan";
import ChapterPicker from "@/components/ChapterPicker.vue";
import EmptyState from "@/components/EmptyState.vue";
import { PencilLine as ScriptingIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import ScriptReader from "@/views/scripting/ScriptReader.vue";
import ScriptSettings from "@/views/scripting/ScriptSettings.vue";
import ScriptEndpoints from "@/views/scripting/ScriptEndpoints.vue";
import { useBookId } from "@/composables/useBookId";
import { useOpenedChapter } from "@/composables/useOpenedChapter";
import { plural } from "@/lib/contents";
import { useCast, useChapterScript, useChapterTexts } from "@/queries";
import { scriptExportUrl } from "@/services/library";

const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();
const bookId = useBookId();
useCast(bookId);
const selected = ref<number[]>([]);
const showEndpoints = ref(false);
const focusReader = ref(false);
const endpointPanel = ref<HTMLElement | null>(null);
async function configure() {
  showEndpoints.value = true;
  await nextTick();
  endpointPanel.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}
const { opened, open: openChapter } = useOpenedChapter(
  bookId,
  (chapters) =>
    chapters.find((c) => c.scripting === "fallback")?.id ?? chapters.find(isScripted)?.id,
);
// The opened chapter's script, read when the chapter is opened and again when the queue says a
// run landed on it. The reader itself reads the scripts store, which is where the read lands.
const { loaded, status: scriptStatus, refetch: readScript } = useChapterScript(bookId, opened);
// The plain text of every chapter a run here could start on — the ticked ones and the one open —
// which the plan cuts into requests and the estimate prices. Until it is read the estimate says
// so and no run starts.
const { unread } = useChapterTexts(
  bookId,
  () => [...new Set([...selected.value, opened.value])],
  "plain",
);
// One plan behind the button's label, the line under it and the work the run queues.
const plan = computed(() => scriptingStore.scriptPlan(bookId, selected.value));
const estimate = computed(() => scriptingStore.scriptEstimateOf(bookId, plan.value));
const runNote = computed(() => {
  if (!plan.value.chapters.length) return "";
  // the request count comes last, and is not a count until every chapter's text is in
  const summary = runSummary(plan.value);
  if (estimate.value.reading) summary.splice(-1, 1, "counting requests…");
  return (
    summary.join(" · ") +
    (plan.value.replace ? " · each replaced script is kept in its chapter's history" : "")
  );
});
const chapter = computed(() => libraryStore.chapter(bookId, opened.value));
const openedName = computed(() => chapterName(libraryStore.numberOf(bookId, opened.value)));
const hasScript = computed(() => chapter.value && isScripted(chapter.value));
/** the chapters' scripts and texts still on their way, which the reader and the buttons wait for */
const waiting = computed(() => (hasScript.value && !loaded.value) || unread.value > 0);
const anyScripted = computed(() => libraryStore.chaptersOf(bookId).some(isScripted));
function scriptFirst() {
  const ids = libraryStore
    .chaptersOf(bookId)
    .filter((c) => !c.excluded)
    .slice(0, 3)
    .map((c) => c.id);
  selected.value = ids;
  void scriptingStore.startRun(bookId, ids);
}
</script>

<template>
  <div class="space-y-4 p-4">
    <section v-if="!focusReader" ref="endpointPanel" class="card overflow-hidden">
      <button
        class="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-left"
        :aria-expanded="showEndpoints"
        aria-controls="script-endpoints"
        @click="showEndpoints = !showEndpoints"
      >
        <span
          ><span class="text-sm font-semibold">Scripting endpoints</span
          ><span class="ml-3 text-xs text-zinc-500"
            >{{ plural(endpointsStore.profiles.length, "endpoint") }} ·
            {{ scriptingStore.runProfile?.name ?? "none can run" }}</span
          ></span
        >
        <span class="text-xs text-violet-600 dark:text-violet-400">{{
          showEndpoints ? "Hide settings ↑" : "Configure endpoints ↓"
        }}</span>
      </button>
      <div
        v-show="showEndpoints"
        id="script-endpoints"
        class="max-h-[65vh] overflow-y-auto border-t border-zinc-200 md:max-h-[min(440px,55vh)] dark:border-zinc-800"
      >
        <ScriptEndpoints :book-id="bookId" :selected="selected" />
      </div>
    </section>
    <div
      class="grid grid-cols-1 gap-4"
      :class="!focusReader && 'lg:grid-cols-[320px_minmax(0,1fr)]'"
    >
      <div v-if="!focusReader" class="flex min-h-0 flex-col gap-3">
        <div class="h-[420px] min-h-0">
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
            :selectable="(c) => !['running', 'queued'].includes(c.scripting)"
            @open="openChapter"
            @run="(ids) => scriptingStore.startRun(bookId, ids)"
          />
        </div>
        <div class="card shrink-0 p-3">
          <ScriptSettings :book-id="bookId" :plan="plan" :est="estimate" @configure="configure" />
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

      <div
        class="min-h-0 min-w-0 lg:sticky lg:top-4"
        :class="focusReader ? 'h-[calc(100dvh-88px)]' : 'lg:h-[calc(100vh-140px)]'"
      >
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
            'Configure an endpoint, model, and token rates above',
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
          body="Scripting failed: after retries the model's output still didn't reconstruct the chapter text, so nothing was kept. This usually means a chunk boundary split a quote or the chapter has unusual formatting. Try a smaller chunk size, then re-run."
        >
          <button
            class="btn-primary"
            :disabled="waiting"
            @click="scriptingStore.startRun(bookId, [opened])"
          >
            Re-run this chapter
          </button>
          <button
            class="btn-ghost"
            :disabled="waiting || !scriptingStore.runProfile"
            :title="
              scriptingStore.runProfile
                ? `Cuts ${scriptingStore.runProfile.name}'s chunks by 2,000 characters — for every book it scripts`
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
          body="Not scripted yet. Tick it on the left and run scripting, or script just this one."
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
