<script setup>
// Scripting stage: chapter picker + run settings on the left, script reader on the right.
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useApp, isScripted } from "../stores/app";
import ChapterPicker from "../components/ChapterPicker.vue";
import EmptyState from "../components/EmptyState.vue";
import ScriptReader from "./scripting/ScriptReader.vue";
import ScriptSettings from "./scripting/ScriptSettings.vue";

const app = useApp();
const route = useRoute();
const bookId = route.params.bookId;
const selected = ref([]);
const opened = ref(
  Number(route.query.ch) ||
    (app.chaptersOf(bookId).find((c) => c.scripting === "fallback")?.id ??
      app.chaptersOf(bookId).find(isScripted)?.id ??
      1),
);
watch(
  () => route.query.ch,
  (ch) => {
    if (ch) opened.value = Number(ch);
  },
); // ?ch= from the command palette
const chapter = computed(() => app.chapter(bookId, opened.value));
const hasScript = computed(() => chapter.value && isScripted(chapter.value));
const anyScripted = computed(() => app.chaptersOf(bookId).some(isScripted));
function scriptFirst() {
  const ids = app
    .chaptersOf(bookId)
    .filter((c) => !c.excluded)
    .slice(0, 3)
    .map((c) => c.id);
  selected.value = ids;
  app.runScripting(bookId, ids);
}
</script>

<template>
  <div class="grid gap-4 p-4 lg:h-full lg:grid-cols-[300px_1fr] lg:grid-rows-[minmax(0,1fr)]">
    <div class="flex min-h-0 flex-col gap-3">
      <div class="h-[50vh] min-h-0 lg:h-auto lg:flex-1">
        <ChapterPicker
          :book-id="bookId"
          stage="scripting"
          v-model="selected"
          :opened-id="opened"
          run-label="Run scripting"
          @open="(id) => (opened = id)"
          @run="(ids) => app.runScripting(bookId, ids)"
        />
      </div>
      <div class="card shrink-0 p-3"><ScriptSettings :book-id="bookId" :selected="selected" /></div>
    </div>

    <div class="min-h-0 min-w-0 lg:h-full">
      <ScriptReader v-if="hasScript" :book-id="bookId" :chapter-id="opened" :key="opened" />
      <EmptyState
        v-else-if="!anyScripted && chapter?.scripting === 'none'"
        icon="✎"
        title="Nothing scripted yet"
        body="Scripting reads each chapter with the LLM, splits it into speaker runs, and verifies nothing was dropped. Start with the first few chapters to discover the cast."
        :steps="[
          'Pick a profile and chunk size below the chapter list',
          'Tick chapters (or use Pending) and run',
          'Review the cast and merge aliases before narrating',
        ]"
      >
        <button class="btn-primary" @click="scriptFirst">Script the first 3 chapters</button>
      </EmptyState>
      <EmptyState
        v-else-if="chapter?.scripting === 'running' || chapter?.scripting === 'queued'"
        icon="✎"
        :title="chapter.title"
        :body="
          chapter.scripting === 'queued'
            ? 'Queued — waiting for the previous chapter so context carries forward.'
            : `Extracting segments… ${Math.round(chapter.scriptingProgress)}%`
        "
      />
      <EmptyState
        v-else-if="chapter?.scripting === 'failed'"
        icon="⚠"
        :title="chapter.title"
        body="Scripting failed: after retries the model's output still didn't reconstruct the chapter text, so nothing was kept. This usually means a chunk boundary split a quote or the chapter has unusual formatting. Try a smaller chunk size, then re-run."
      >
        <button class="btn-primary" @click="app.runScripting(bookId, [opened])">
          Re-run this chapter
        </button>
        <button
          class="btn-ghost"
          @click="
            app.scriptSettings.chunkChars = Math.max(2000, app.scriptSettings.chunkChars - 2000);
            app.runScripting(bookId, [opened]);
          "
        >
          Smaller chunks + re-run
        </button>
      </EmptyState>
      <EmptyState
        v-else
        icon="✎"
        :title="chapter?.title"
        body="Not scripted yet. Tick it on the left and run scripting, or script just this one."
      >
        <button class="btn-primary" @click="app.runScripting(bookId, [opened])">
          Script this chapter
        </button>
      </EmptyState>
    </div>
  </div>
</template>
