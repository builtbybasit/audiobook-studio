<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// Scripting stage: chapter picker + run settings on the left, script reader on the right.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isScripted } from "@/lib/scriptReview";
import { runActionLabel, runSummary, skipSummary } from "@/lib/runPlan";
import ChapterPicker from "@/components/ChapterPicker.vue";
import EmptyState from "@/components/EmptyState.vue";
import { PencilLine as ScriptingIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import ScriptReader from "@/views/scripting/ScriptReader.vue";
import ScriptSettings from "@/views/scripting/ScriptSettings.vue";
import ScriptEndpoints from "@/views/scripting/ScriptEndpoints.vue";
import { useBookId } from "@/composables/useBookId";

const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const route = useRoute();
const router = useRouter();
const bookId = useBookId();
const selected = ref<number[]>([]);
const showEndpoints = ref(false);
const focusReader = ref(false);
const endpointPanel = ref<HTMLElement | null>(null);
const currentEndpoint = computed(() =>
  endpointsStore.profiles.find((p) => p.id === scriptingStore.scriptSettings.profile),
);
async function configure() {
  showEndpoints.value = true;
  await nextTick();
  endpointPanel.value?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function smallerChunks() {
  if (currentEndpoint.value)
    currentEndpoint.value.maxChars = Math.max(100, (currentEndpoint.value.maxChars || 6000) - 2000);
  scriptingStore.runScripting(bookId, [opened.value]);
}
const opened = ref(
  Number(route.query.ch) ||
    uiStore.chapterIn(bookId, libraryStore.chaptersOf(bookId)) ||
    (libraryStore.chaptersOf(bookId).find((c) => c.scripting === "fallback")?.id ??
      libraryStore.chaptersOf(bookId).find(isScripted)?.id ??
      1),
);
watch(
  () => route.query.ch,
  (ch) => {
    if (ch) opened.value = Number(ch);
  },
); // ?ch= from the command palette
function openChapter(id: number) {
  opened.value = id;
}
// The chapter follows you between stages: whichever way it changed here — the picker, ?ch=, the
// palette, or the book's own memory — record it and keep the URL saying which one you are on.
function remember(id: number) {
  uiStore.openChapter(bookId, id);
  if (Number(route.query.ch) !== id)
    void router.replace({ query: { ...route.query, ch: String(id), seg: undefined } });
}
watch(opened, remember);
onMounted(() => remember(opened.value));
// With a server answering, the opened chapter's script is read when it is opened; the seeded
// world is already holding every script, and the store does nothing there.
watch(opened, (id) => void scriptsStore.loadScript(bookId, id), { immediate: true });
// One plan behind the button's label, the line under it and the work the run queues.
const plan = computed(() => scriptingStore.scriptPlan(bookId, selected.value));
const runNote = computed(() => {
  if (!plan.value.chapters.length) return "";
  const keep = scriptingStore.scriptSettings.keepEdits;
  return (
    runSummary(plan.value).join(" · ") +
    (plan.value.replace
      ? ` · each replaced script is kept in its chapter's history${keep ? ", manual corrections re-applied where the line still matches" : ""}`
      : "")
  );
});
const chapter = computed(() => libraryStore.chapter(bookId, opened.value));
const hasScript = computed(() => chapter.value && isScripted(chapter.value));
const anyScripted = computed(() => libraryStore.chaptersOf(bookId).some(isScripted));
function scriptFirst() {
  const ids = libraryStore
    .chaptersOf(bookId)
    .filter((c) => !c.excluded)
    .slice(0, 3)
    .map((c) => c.id);
  selected.value = ids;
  scriptingStore.runScripting(bookId, ids);
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
            >{{ endpointsStore.profiles.length }} saved ·
            {{ currentEndpoint?.name ?? "Choose an endpoint" }}</span
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
            :run-disabled="!!scriptingStore.scriptEstimate(bookId, selected).blockers.length"
            :selectable="(c) => !['running', 'queued'].includes(c.scripting)"
            @open="openChapter"
            @run="
              (ids) =>
                scriptingStore.runScripting(bookId, ids, {
                  keepEdits: scriptingStore.scriptSettings.keepEdits,
                })
            "
          />
        </div>
        <div class="card shrink-0 p-3">
          <ScriptSettings :book-id="bookId" :selected="selected" @configure="configure" />
        </div>
      </div>

      <div
        class="min-h-0 min-w-0 lg:sticky lg:top-4"
        :class="focusReader ? 'h-[calc(100dvh-88px)]' : 'lg:h-[calc(100vh-140px)]'"
      >
        <ScriptReader
          v-if="hasScript"
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
          <button class="btn-primary" @click="scriptingStore.runScripting(bookId, [opened])">
            Re-run this chapter
          </button>
          <button class="btn-ghost" @click="smallerChunks">Smaller chunks + re-run</button>
        </EmptyState>
        <EmptyState
          v-else
          :icon="ScriptingIcon"
          :title="chapter?.title"
          body="Not scripted yet. Tick it on the left and run scripting, or script just this one."
        >
          <button class="btn-primary" @click="scriptingStore.runScripting(bookId, [opened])">
            Script this chapter
          </button>
        </EmptyState>
      </div>
    </div>
  </div>
</template>
