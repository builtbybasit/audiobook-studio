<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
// fractions of a cent stay visible: a short run really can cost less than a cent, and rounding
// that to "$0.00" reads as free
import { money } from "@/lib/pricing";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";

// Narration stage: voices + routing on top, chapter picker + run estimate + job ledger below.
// Endpoints themselves are configured app-wide on /endpoints; the Routing tab only shows where
// this book's lines land.
import { useStorage } from "@vueuse/core";
import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { plural } from "@/lib/contents";
import { speechReadiness } from "@/lib/endpoints";
import { runActionLabel, runSummary, SCOPE_LABEL, skipSummary } from "@/lib/runPlan";
import type { Endpoint, NarrationScope } from "@/types";
import EmptyState from "@/components/EmptyState.vue";
import { UiTabs, UiToggleGroup } from "@/ui";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import {
  AudioLines as NarrationIcon,
  ChevronDown as ChevronDownIcon,
  ChevronUp as ChevronUpIcon,
  ChevronUp as DetailsIcon,
  LoaderCircle as BusyIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import ChapterPicker from "@/components/ChapterPicker.vue";
import VoiceTable from "@/views/narration/VoiceTable.vue";
import EndpointPanel from "@/views/narration/EndpointPanel.vue";
import LexiconPanel from "@/views/narration/LexiconPanel.vue";
import RunEstimate from "@/views/narration/RunEstimate.vue";
import { TabsContent, TabsRoot } from "reka-ui";
import JobLedger from "@/views/narration/JobLedger.vue";
import { useNarrationData } from "@/views/narration/useNarrationData";
import { useBookId } from "@/composables/useBookId";
import { useOpenedChapter } from "@/composables/useOpenedChapter";
const castStore = useCastStore();
const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();
const scriptsStore = useScriptsStore();
const route = useRoute();
const bookId = useBookId();
const TABS = [
  { value: "voices", label: "Voices" },
  { value: "routing", label: "Routing" },
  { value: "pronunciation", label: "Pronunciation" },
] as const;
const tab = ref("voices");
const lexicon = ref<InstanceType<typeof LexiconPanel> | null>(null);
/** the ledger's pronunciation flag hands a word straight to the dictionary */
async function toDictionary(word: string) {
  tab.value = "pronunciation";
  collapsed.value = false;
  await nextTick();
  lexicon.value?.prefill(word);
}
// Whether the setup panel is folded away, remembered per book and per browser. First time round
// it is open for a book nothing has narrated yet and closed otherwise; the saved word is
// "open"/"closed" rather than a boolean's spelling, so what earlier visits saved still reads.
const collapsed = useStorage<boolean>(
  `audiobook-studio:narration-setup:${bookId}`,
  !!route.query.filter || libraryStore.chaptersOf(bookId).some((c) => c.narration !== "none"),
  undefined,
  { serializer: { read: (v) => v === "closed", write: (v) => (v ? "closed" : "open") } },
);
watch(
  () => route.query.filter,
  (value) => {
    if (value) collapsed.value = true;
  },
);
const selected = ref<number[]>([]);
// What the run is for, and whether it may take over a comparison somebody started. Both live here
// so the picker's button, the estimate and the run itself are talking about the same thing.
const scope = ref<NarrationScope>("fill");
const keepPending = ref(true);
const { opened, open: openChapter } = useOpenedChapter(
  bookId,
  (chapters) =>
    chapters.find((c) => c.narration === "stale")?.id ??
    chapters.find((c) => c.narration === "failed")?.id ??
    chapters.find(isNarrated)?.id,
);
// Nothing below is drawn from the stores until they hold what it reads: an empty cast or a script
// not read yet would otherwise pass for a book with no voices and a run with nothing in it.
const { ready: loaded, error: loadError, retry } = useNarrationData(bookId, opened);
/**
 * The run as the picker, the strip and the estimate panel all describe it: one plan, the one
 * estimate of that plan, and what stops it starting, in the order worth fixing — worked out once
 * per change rather than once per place that shows it.
 *
 * What the *run* refuses is asked of the store: `narrationStore.blockers` is built on the same
 * figure the server reserves against the cap — a per-endpoint sum of undiscounted prices — so the
 * strip cannot green-light a press the server then turns down, and a retry from the Queue is held
 * to the same list. They are worked out here rather than in the estimate panel because the strip
 * has to say how many there are while it is closed.
 */
const run = computed(() => {
  const plan = narrationStore.narrationRunPlan(
    bookId,
    selected.value,
    scope.value,
    keepPending.value,
  );
  const est = narrationStore.estimateOf(bookId, plan, keepPending.value);
  return { plan, est, blockers: narrationStore.blockers(bookId, est) };
});
const scopes = (["fill", "failed", "all"] as NarrationScope[]).map((value) => ({
  value,
  // the strip is 300px wide: the scope's full name is in the panel, and in the run's own label
  label: SCOPE_LABEL[value]
    .replace("Missing & changed", "Missing")
    .replace("Failed only", "Failed"),
}));
const runNote = computed(() => {
  const plan = run.value.plan;
  if (!loaded.value || !plan.chapters.length) return "";
  return (
    `${SCOPE_LABEL[scope.value]} · ${runSummary(plan).join(" · ")}` +
    (plan.replacing
      ? ` · ${plural(plan.replacing, "current clip")} stay playable until replaced`
      : "")
  );
});
const anyScripted = computed(() => libraryStore.chaptersOf(bookId).some(isScripted));
/** The tab carries the cast's progress, so the Voices panel needs no summary line of its own. */
const voices = computed(() => {
  const cast = castStore.charactersOf(bookId);
  return { assigned: cast.filter((c) => c.voice).length, total: cast.length };
});
/**
 * The endpoints this book's speakers resolve to, and how many of them can take its lines — the
 * pool beyond them is the Endpoints page's business, and pausing one of those changes nothing here.
 */
const routes = computed(() => {
  const reached = new Map<string, Endpoint>();
  for (const c of castStore.charactersOf(bookId)) {
    const ep = castStore.effectiveVoice(bookId, c.name).endpoint;
    if (ep) reached.set(ep.id, ep);
  }
  const now = Date.now();
  const usable = [...reached.values()].filter(
    (e) => !["paused", "nokey"].includes(speechReadiness(e, now).state),
  );
  return { total: reached.size, usable: usable.length };
});
const chapter = computed(() => libraryStore.chapter(bookId, opened.value));
/** the open chapter has been narrated at all, so its ledger has rows to show */
const begun = computed(
  () => chapter.value && isScripted(chapter.value) && chapter.value.narration !== "none",
);
/** What "Narrate this chapter" would send — at the scope it runs, not the store's default. */
const openedRequests = computed(() =>
  narrationStore
    .estimate(bookId, [opened.value], "fill")
    .per.map((e) => `${e.endpoint.name}: ${plural(e.requests, "request")}`)
    .join(", "),
);
</script>

<template>
  <!-- the workspace takes whatever the window has: its two panels are the page, and a fixed height
       either leaves a band of nothing under them or spills them off the bottom -->
  <div class="flex flex-col gap-4 p-4 lg:h-full">
    <TabsRoot v-model="tab" class="card shrink-0" @update:model-value="collapsed = false">
      <UiTabs :tabs="TABS" class="border-b border-zinc-200 px-2 dark:border-zinc-800">
        <template #tab="{ tab: t }">
          <template v-if="loaded">
            <span v-if="t.value === 'voices'" class="text-zinc-400"
              >{{ voices.assigned }}/{{ voices.total }}</span
            >
            <span
              v-else-if="t.value === 'routing' && routes.total"
              :class="routes.usable < routes.total ? 'text-amber-600' : 'text-zinc-400'"
              :title="`${routes.usable} of the ${plural(routes.total, 'endpoint')} this book’s voices are on can take its lines`"
              >{{ routes.usable }}/{{ routes.total }} ready</span
            >
            <span v-else-if="t.value === 'pronunciation'" class="text-zinc-400">{{
              castStore.lexiconOf(bookId).length
            }}</span>
          </template>
        </template>
        <button class="ml-auto px-3 py-2 text-xs text-zinc-500" @click="collapsed = !collapsed">
          <component :is="collapsed ? ChevronDownIcon : ChevronUpIcon" class="icon-sm" />
          {{ collapsed ? "expand" : "collapse" }}
        </button>
      </UiTabs>
      <div v-show="!collapsed" class="max-h-[420px] overflow-auto">
        <template v-if="loaded">
          <TabsContent value="voices"><VoiceTable :book-id="bookId" /></TabsContent>
          <TabsContent value="routing"
            ><EndpointPanel :book-id="bookId" @voices="tab = 'voices'"
          /></TabsContent>
          <TabsContent value="pronunciation"
            ><LexiconPanel ref="lexicon" :book-id="bookId"
          /></TabsContent>
        </template>
        <p v-else-if="loadError" class="flex items-center gap-2 p-4 text-sm text-red-600">
          <WarnIcon class="icon shrink-0" /> {{ loadError }}
          <button class="btn-ghost btn-xs" @click="retry()">Retry</button>
        </p>
        <p v-else class="flex items-center gap-2 p-4 text-sm text-zinc-500">
          <BusyIcon class="icon animate-spin" /> Reading the cast and the scripts…
        </p>
      </div>
    </TabsRoot>

    <div
      class="grid min-h-0 gap-4 lg:min-h-[26rem] lg:flex-1 lg:grid-cols-[300px_1fr] lg:grid-rows-1"
    >
      <div class="flex min-h-0 flex-col gap-2">
        <div class="h-[50vh] min-h-0 lg:h-auto lg:flex-1">
          <ChapterPicker
            :book-id="bookId"
            stage="narration"
            v-model="selected"
            :opened-id="opened"
            :run-label="runActionLabel(run.plan)"
            :run-count="run.plan.chapters.length"
            :run-disabled="!loaded"
            :run-note="runNote"
            :run-skipped="loaded ? skipSummary(run.plan) : ''"
            :selectable="(c) => isScripted(c)"
            @open="openChapter"
            @run="(ids) => narrationStore.startRun(bookId, ids, { scope })"
          />
        </div>
        <!-- Scope is a choice and stays on screen; the estimate is a consequence of it and only
             has to be reachable. Fixed height whatever the run turns out to be, so the chapter
             list above never gives up rows to a longer answer. -->
        <div class="card shrink-0 p-2">
          <UiToggleGroup v-model="scope" :options="scopes" block size="xs" />
          <div class="mt-1.5 flex items-center gap-2 text-xs">
            <template v-if="!loaded">
              <span v-if="loadError" class="min-w-0 flex-1 truncate text-red-600" :title="loadError"
                ><WarnIcon class="icon-sm" /> {{ loadError }}</span
              >
              <span v-else class="min-w-0 flex-1 truncate text-zinc-500"
                ><BusyIcon class="icon-sm animate-spin" /> Reading the scripts…</span
              >
              <button
                v-if="loadError"
                class="ml-auto shrink-0 text-zinc-500 hover:text-violet-500"
                @click="retry()"
              >
                Retry
              </button>
            </template>
            <template v-else>
              <template v-if="run.blockers.length">
                <span class="min-w-0 flex-1 truncate text-amber-600" :title="run.blockers.join(' ')"
                  ><WarnIcon class="icon-sm" /> {{ run.blockers[0] }}</span
                >
              </template>
              <template v-else>
                <span class="text-zinc-500">{{ plural(run.est.segments, "clip") }}</span>
                <span class="text-zinc-300 dark:text-zinc-600">·</span>
                <span class="font-mono font-semibold text-amber-600">{{
                  money(run.est.cost)
                }}</span>
              </template>
              <PopoverRoot>
                <PopoverTrigger
                  class="ml-auto inline-flex shrink-0 items-center gap-0.5 text-zinc-500 hover:text-violet-500"
                >
                  <span v-if="run.blockers.length > 1" class="text-amber-600"
                    >+{{ run.blockers.length - 1 }}</span
                  >
                  Details <DetailsIcon class="icon-sm" />
                </PopoverTrigger>
                <PopoverPortal>
                  <PopoverContent
                    side="top"
                    align="end"
                    :side-offset="6"
                    class="card z-50 max-h-[70vh] w-80 overflow-y-auto p-3 shadow-xl"
                  >
                    <RunEstimate
                      :book-id="bookId"
                      :plan="run.plan"
                      :est="run.est"
                      :blockers="run.blockers"
                      v-model:scope="scope"
                      v-model:keep-pending="keepPending"
                    />
                  </PopoverContent>
                </PopoverPortal>
              </PopoverRoot>
            </template>
          </div>
        </div>
      </div>
      <div class="min-h-0 min-w-0 max-lg:h-[70vh]">
        <EmptyState
          v-if="!anyScripted"
          :icon="NarrationIcon"
          title="Nothing to narrate yet"
          body="Narration needs a script. Script at least one chapter first, then assign voices here."
          :steps="[
            'Script chapters in stage 1',
            'Assign a voice to the Narrator and the main cast above',
            'Enable an endpoint and press Narrate',
          ]"
        >
          <RouterLink :to="`/book/${bookId}/scripting`" class="btn-primary"
            >Go to Scripting</RouterLink
          >
        </EmptyState>
        <EmptyState
          v-else-if="chapter && !isScripted(chapter)"
          :icon="NarrationIcon"
          :title="chapter.title"
          body="This chapter has no script yet. Script it first, then narrate."
        >
          <RouterLink :to="`/book/${bookId}/scripting`" class="btn-ghost"
            >Go to Scripting</RouterLink
          >
        </EmptyState>
        <EmptyState
          v-else-if="loadError"
          :icon="WarnIcon"
          :title="chapter?.title"
          :body="`${loadError} Nothing here is shown until it is, so no count reads as zero that is not.`"
        >
          <button class="btn-primary" @click="retry()">Retry</button>
        </EmptyState>
        <EmptyState
          v-else-if="!loaded"
          :icon="BusyIcon"
          :title="chapter?.title"
          body="Reading the script, the cast and the endpoints…"
        />
        <JobLedger
          v-else-if="begun"
          :key="opened"
          :book-id="bookId"
          :chapter-id="opened"
          @pronounce="toDictionary"
        />
        <EmptyState
          v-else
          :icon="NarrationIcon"
          :title="chapter?.title"
          :body="`${plural(scriptsStore.segmentsOf(bookId, opened).length, 'line')} ready. Each goes to the endpoint that owns its speaker’s voice; ${openedRequests || 'no voices routed yet'}.`"
        >
          <button
            class="btn-primary"
            @click="narrationStore.startRun(bookId, [opened], { scope: 'fill' })"
          >
            Narrate this chapter
          </button>
        </EmptyState>
      </div>
    </div>
  </div>
</template>
