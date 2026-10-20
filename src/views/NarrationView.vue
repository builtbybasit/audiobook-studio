<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
// keeps fractions of a cent: rounding a short run to "$0.00" reads as free
import { money } from "@/lib/pricing";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";

// Narration stage: voices + routing on top, chapter picker + run estimate + job ledger below.
// The Routing tab only shows where this book's lines land; endpoints are set on /endpoints.
import { useStorage } from "@vueuse/core";
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isNarrated, isScripted } from "@/lib/scriptReview";
import { plural } from "@/lib/contents";
import { voiced } from "@/lib/cast";
import { isSpoken } from "@/lib/siteText";
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
const router = useRouter();
const bookId = useBookId();
const TABS = [
  { value: "voices", label: "Voices" },
  { value: "routing", label: "Routing" },
  { value: "pronunciation", label: "Pronunciation" },
] as const;
const tab = ref("voices");
const lexicon = ref<InstanceType<typeof LexiconPanel> | null>(null);
async function toDictionary(word: string) {
  tab.value = "pronunciation";
  collapsed.value = false;
  await nextTick();
  lexicon.value?.prefill(word);
}
// the Listen page's flag sends `?pronounce=word`, taken out of the address once the panel has it
watch(
  () => route.query.pronounce,
  (w) => {
    if (typeof w !== "string" || !w) return;
    void toDictionary(w);
    const { pronounce: _, ...rest } = route.query;
    void router.replace({ query: rest });
  },
  { immediate: true },
);
// Whether the setup panel is folded, per book and browser. Saved as "open"/"closed", not a
// boolean's spelling, so what earlier visits saved still reads.
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
// Shared by the picker's button, the estimate and the run, so all three describe the same run.
const scope = ref<NarrationScope>("fill");
const keepPending = ref(true);
const { opened, open: openChapter } = useOpenedChapter(
  bookId,
  (chapters) =>
    chapters.find((c) => c.narration === "stale")?.id ??
    chapters.find((c) => c.narration === "failed")?.id ??
    chapters.find(isNarrated)?.id,
);
// Nothing is drawn until the stores are loaded: an empty cast or unread script would pass for a
// book with no voices.
const { ready: loaded, error: loadError, retry } = useNarrationData(bookId, opened);
/**
 * The run as the picker, strip and estimate panel describe it, worked out once. `blockers` uses
 * the figure the server reserves against the cap, so the strip cannot green-light a run the server
 * refuses. Nothing is planned until every script is in, or each landing script re-prices it all.
 */
const run = computed(() => {
  const plan = narrationStore.narrationRunPlan(
    bookId,
    loaded.value ? selected.value : [],
    scope.value,
    keepPending.value,
  );
  const est = narrationStore.estimateOf(bookId, plan, keepPending.value);
  return { plan, est, blockers: narrationStore.blockers(bookId, est) };
});
const scopes = (["fill", "failed", "all"] as NarrationScope[]).map((value) => ({
  value,
  // the strip is 300px wide; the full name is in the panel
  label: SCOPE_LABEL[value]
    .replace("Missing & changed", "Missing")
    .replace("Failed only", "Failed"),
}));
const runNote = computed(() => {
  const plan = run.value.plan;
  if (!loaded.value || !plan.chapters.length) return "";
  const unread = narrationStore.unreadNote(bookId, plan);
  return (
    `${SCOPE_LABEL[scope.value]} · ${runSummary(plan).join(" · ")}` +
    (plan.replacing
      ? ` · ${plural(plan.replacing, "current clip")} stay playable until replaced`
      : "") +
    (unread ? ` · ${unread}` : "")
  );
});
const anyScripted = computed(() => libraryStore.chaptersOf(bookId).some(isScripted));
const voices = computed(() => {
  const cast = castStore.charactersOf(bookId);
  const byName = castStore.byName[bookId] ?? new Map();
  return { assigned: cast.filter((c) => voiced(c, byName)).length, total: cast.length };
});
/** Only the endpoints this book's speakers resolve to: pausing any other changes nothing here. */
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
const begun = computed(
  () => chapter.value && isScripted(chapter.value) && chapter.value.narration !== "none",
);
/** Counts the site text and notes it skips, so a line marked by mistake is not simply absent. */
const openedLines = computed(() => {
  const book = libraryStore.bookById(bookId);
  const segs = scriptsStore.segmentsOf(bookId, opened.value);
  const spoken = segs.filter((s) => isSpoken(s, book)).length;
  const unread = segs.length - spoken;
  return (
    `${plural(spoken, "line")} ready` +
    (unread ? ` (${plural(unread, "line")} of site text or notes not read)` : "")
  );
});
/** At the scope "Narrate this chapter" runs, not the store's default. */
const openedRequests = computed(() =>
  narrationStore
    .estimate(bookId, [opened.value], "fill")
    .per.map((e) => `${e.endpoint.name}: ${plural(e.requests, "request")}`)
    .join(", "),
);
</script>

<template>
  <!-- takes the window's height: a fixed one leaves a gap or spills off the bottom -->
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
              :data-tip="`${routes.usable} of the ${plural(routes.total, 'endpoint')} this book’s voices are on can take its lines`"
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
            :selectable="isScripted"
            @open="openChapter"
            @run="(ids) => narrationStore.startRun(bookId, ids, { scope })"
          />
        </div>
        <!-- fixed height, so the chapter list above never gives up rows to a longer estimate -->
        <div class="card shrink-0 p-2">
          <UiToggleGroup v-model="scope" :options="scopes" block size="xs" />
          <div class="mt-1.5 flex items-center gap-2 text-xs">
            <template v-if="!loaded">
              <span
                v-if="loadError"
                class="min-w-0 flex-1 truncate text-red-600"
                :data-tip="loadError"
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
                <span
                  class="min-w-0 flex-1 truncate text-amber-600"
                  :data-tip="run.blockers.join(' ')"
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
          :body="`${openedLines}. Each goes to the endpoint that owns its speaker’s voice; ${openedRequests || 'no voices routed yet'}.`"
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
