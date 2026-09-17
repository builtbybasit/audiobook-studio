<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useNarrationStore } from "@/stores/narration";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// Narration stage: voices + routing on top, chapter picker + run estimate + job ledger below.
// Endpoints themselves are configured app-wide on /endpoints; the Routing tab only shows where
// this book's lines land.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isScripted } from "@/lib/scriptReview";
import { isNarrated } from "@/lib/scriptReview";
import { runActionLabel, runSummary, SCOPE_LABEL, skipSummary } from "@/lib/runPlan";
// fractions of a cent stay visible: a short run really can cost less than a cent, and rounding
// that to "$0.00" reads as free
import { money } from "@/lib/endpoints";
import type { NarrationScope } from "@/types";
import EmptyState from "@/components/EmptyState.vue";
import { UiToggleGroup } from "@/ui";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { ChevronUp as DetailsIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import { AudioLines as NarrationIcon } from "@lucide/vue";
import { ChevronDown as ChevronDownIcon, ChevronUp as ChevronUpIcon } from "@lucide/vue";
import ChapterPicker from "@/components/ChapterPicker.vue";
import VoiceTable from "@/views/narration/VoiceTable.vue";
import EndpointPanel from "@/views/narration/EndpointPanel.vue";
import LexiconPanel from "@/views/narration/LexiconPanel.vue";
import RunEstimate from "@/views/narration/RunEstimate.vue";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import JobLedger from "@/views/narration/JobLedger.vue";
import { useBookId } from "@/composables/useBookId";
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const narrationStore = useNarrationStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const route = useRoute();
const router = useRouter();
const bookId = useBookId();
const tab = ref("voices");
const lexicon = ref<InstanceType<typeof LexiconPanel> | null>(null);
/** the ledger's pronunciation flag hands a word straight to the dictionary */
async function toDictionary(word: string) {
  tab.value = "pronunciation";
  collapsed.value = false;
  await nextTick();
  lexicon.value?.prefill(word);
}
const setupKey = `audiobook-studio:narration-setup:${bookId}`;
function savedCollapsed(): boolean | null {
  try {
    const value = localStorage.getItem(setupKey);
    return value == null ? null : value === "closed";
  } catch {
    return null;
  }
}
const collapsed = ref(
  savedCollapsed() ??
    (!!route.query.filter || libraryStore.chaptersOf(bookId).some((c) => c.narration !== "none")),
);
watch(collapsed, (value) => {
  try {
    localStorage.setItem(setupKey, value ? "closed" : "open");
  } catch {
    // A blocked storage API should not stop the workspace from opening.
  }
});
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
const plan = computed(() =>
  narrationStore.narrationRunPlan(bookId, selected.value, scope.value, keepPending.value),
);
const est = computed(() =>
  narrationStore.estimate(bookId, selected.value, scope.value, keepPending.value),
);
/**
 * What stops this run starting, in the order worth fixing. It lives here rather than in the
 * estimate panel because the strip has to say how many there are while the panel is closed.
 */
const blockers = computed(() => {
  const b: string[] = [];
  const cast = castStore.charactersOf(bookId);
  if (!cast.find((c) => c.name === "Narrator")?.voice)
    b.push("Assign the Narrator’s voice to start.");
  if (!est.value.endpoints) b.push("Enable at least one endpoint.");
  const book = libraryStore.bookById(bookId);
  if (book?.budget?.paused) b.push("This book is paused (overview → resume).");
  // A cap is checked against the **undiscounted** price, and against what is already spent *and*
  // already held by work in flight. An off-peak window can close and a promotion can expire while a
  // run over a book is still going, so a cap that only holds while a discount lasts is not a cap —
  // the same rule the scripting estimate uses, and the same one the narration store enforces at
  // every entry point, this panel included.
  const worstCase = Math.max(est.value.cost, est.value.withoutPromotions);
  const spent = jobsStore.spent(bookId);
  const held = jobsStore.reserved(bookId);
  if (book?.budget?.cap && spent + held + worstCase > book.budget.cap)
    b.push(
      `Over the $${book.budget.cap} budget cap: $${spent.toFixed(2)} spent` +
        (held > 0 ? ` + $${held.toFixed(2)} held by work already running` : "") +
        ` + $${worstCase.toFixed(2)} for this run${
          worstCase > est.value.cost + 1e-9
            ? " without today’s discounts, which can end mid-run"
            : ""
        }.`,
    );
  const byReason: Record<string, string[]> = {};
  for (const i of castStore.routingIssues(bookId)) (byReason[i.reason] ??= []).push(i.name);
  for (const [reason, names] of Object.entries(byReason))
    b.push(
      `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}: ${reason}.`,
    );
  return b;
});
const scopes = (["fill", "failed", "all"] as NarrationScope[]).map((value) => ({
  value,
  // the strip is 300px wide: the scope's full name is in the panel, and in the run's own label
  label: SCOPE_LABEL[value]
    .replace("Missing & changed", "Missing")
    .replace("Failed only", "Failed"),
}));
const runNote = computed(() =>
  plan.value.chapters.length
    ? `${SCOPE_LABEL[scope.value]} · ${runSummary(plan.value).join(" · ")}` +
      (plan.value.replacing
        ? ` · ${plan.value.replacing} current clip${plan.value.replacing === 1 ? "" : "s"} stay playable until replaced`
        : "")
    : "",
);
const opened = ref(
  Number(route.query.ch) ||
    uiStore.chapterIn(bookId, libraryStore.chaptersOf(bookId)) ||
    (libraryStore.chaptersOf(bookId).find((c) => c.narration === "stale")?.id ??
      libraryStore.chaptersOf(bookId).find((c) => c.narration === "failed")?.id ??
      libraryStore.chaptersOf(bookId).find(isNarrated)?.id ??
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
const anyScripted = computed(() => libraryStore.chaptersOf(bookId).some(isScripted));
/** The tab carries the cast's progress, so the Voices panel needs no summary line of its own. */
const voices = computed(() => {
  const cast = castStore.charactersOf(bookId);
  return { assigned: cast.filter((c) => c.voice).length, total: cast.length };
});
const chapter = computed(() => libraryStore.chapter(bookId, opened.value));
const ready = computed(
  () => chapter.value && isScripted(chapter.value) && chapter.value.narration !== "none",
);
</script>

<template>
  <!-- the workspace takes whatever the window has: its two panels are the page, and a fixed height
       either leaves a band of nothing under them or spills them off the bottom -->
  <div class="flex flex-col gap-4 p-4 lg:h-full">
    <TabsRoot v-model="tab" class="card shrink-0" @update:model-value="collapsed = false">
      <TabsList class="flex items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
        <TabsTrigger
          value="voices"
          class="border-b-2 border-transparent px-3 py-2 text-sm text-zinc-500 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-100"
          >Voices
          <span class="text-zinc-400">{{ voices.assigned }}/{{ voices.total }}</span></TabsTrigger
        >
        <TabsTrigger
          value="routing"
          class="border-b-2 border-transparent px-3 py-2 text-sm text-zinc-500 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-100"
          >Routing
          <span class="text-zinc-400"
            >{{ endpointsStore.enabledEndpoints.length }}/{{
              endpointsStore.endpoints.length
            }}
            on</span
          ></TabsTrigger
        >
        <TabsTrigger
          value="pronunciation"
          class="border-b-2 border-transparent px-3 py-2 text-sm text-zinc-500 data-[state=active]:border-violet-500 data-[state=active]:font-semibold data-[state=active]:text-zinc-900 dark:data-[state=active]:text-zinc-100"
          >Pronunciation
          <span class="text-zinc-400">{{ castStore.lexiconOf(bookId).length }}</span></TabsTrigger
        >
        <button class="ml-auto px-3 py-2 text-xs text-zinc-500" @click="collapsed = !collapsed">
          <component :is="collapsed ? ChevronDownIcon : ChevronUpIcon" class="icon-sm" />
          {{ collapsed ? "expand" : "collapse" }}
        </button>
      </TabsList>
      <div v-show="!collapsed" class="max-h-[420px] overflow-auto">
        <TabsContent value="voices"><VoiceTable :book-id="bookId" /></TabsContent>
        <TabsContent value="routing"
          ><EndpointPanel :book-id="bookId" @voices="tab = 'voices'"
        /></TabsContent>
        <TabsContent value="pronunciation"
          ><LexiconPanel ref="lexicon" :book-id="bookId"
        /></TabsContent>
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
            :run-label="runActionLabel(plan)"
            :run-count="plan.chapters.length"
            :run-note="runNote"
            :run-skipped="skipSummary(plan)"
            :selectable="(c) => isScripted(c)"
            @open="openChapter"
            @run="
              (ids) =>
                narrationStore.runNarration(bookId, ids, {
                  scope,
                  keepPending,
                })
            "
          />
        </div>
        <!-- Scope is a choice and stays on screen; the estimate is a consequence of it and only
             has to be reachable. Fixed height whatever the run turns out to be, so the chapter
             list above never gives up rows to a longer answer. -->
        <div class="card shrink-0 p-2">
          <UiToggleGroup v-model="scope" :options="scopes" block size="xs" />
          <div class="mt-1.5 flex items-center gap-2 text-xs">
            <template v-if="blockers.length">
              <span class="min-w-0 flex-1 truncate text-amber-600" :title="blockers.join(' ')"
                ><WarnIcon class="icon-sm" /> {{ blockers[0] }}</span
              >
            </template>
            <template v-else>
              <span class="text-zinc-500"
                >{{ est.segments }} clip{{ est.segments === 1 ? "" : "s" }}</span
              >
              <span class="text-zinc-300 dark:text-zinc-600">·</span>
              <span class="font-mono font-semibold text-amber-600">{{ money(est.cost) }}</span>
            </template>
            <PopoverRoot>
              <PopoverTrigger
                class="ml-auto inline-flex shrink-0 items-center gap-0.5 text-zinc-500 hover:text-violet-500"
              >
                <span v-if="blockers.length > 1" class="text-amber-600"
                  >+{{ blockers.length - 1 }}</span
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
                    :selected="selected"
                    :blockers="blockers"
                    v-model:scope="scope"
                    v-model:keep-pending="keepPending"
                  />
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
          </div>
        </div>
      </div>
      <div class="min-h-0 min-w-0 max-lg:h-[70vh]">
        <JobLedger
          v-if="ready"
          :key="opened"
          :book-id="bookId"
          :chapter-id="opened"
          @pronounce="toDictionary"
        />
        <EmptyState
          v-else-if="!anyScripted"
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
          v-else
          :icon="NarrationIcon"
          :title="chapter?.title"
          :body="`${scriptsStore.segmentsOf(bookId, opened).length} segments ready. Each goes to the endpoint that owns its speaker’s voice; ${
            narrationStore
              .estimate(bookId, [opened])
              .per.map(
                (e) => `${e.endpoint.name}: ${e.requests} request${e.requests === 1 ? '' : 's'}`,
              )
              .join(', ') || 'no voices routed yet'
          }.`"
        >
          <button
            class="btn-primary"
            @click="narrationStore.runNarration(bookId, [opened], { scope: 'fill' })"
          >
            Narrate this chapter
          </button>
        </EmptyState>
      </div>
    </div>
  </div>
</template>
