<script setup lang="ts">
// What the run would cost, as a receipt: the total first, then its lines, then the budget it comes
// out of. Also what the run touches that is not money: corrections it would replace, the prompt it
// sends, and the runs already going.
import { computed } from "vue";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import type { RunPlan, ScriptEstimate } from "@/types";
import { money } from "@/lib/pricing";
import { aboutDuration } from "@/lib/time";
import { useChapterScripts } from "@/queries";
import { useScriptActivity } from "@/queries/scriptActivity";
import BookPromptSummary from "@/views/scripting/BookPromptSummary.vue";
import CorrectionsNote from "@/views/scripting/CorrectionsNote.vue";
import { UiHint, UiNumber } from "@/ui";
import { ArrowRight as NextIcon } from "@lucide/vue";

const props = defineProps<{
  bookId: string;
  plan: RunPlan;
  est: ScriptEstimate & { reasoningTokens: number };
}>();
const endpointsStore = useEndpointsStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
// the "with cache" figure reads these from the query cache, so they must be loaded here
useScriptActivity();
// Read here: an unopened script is not one without corrections.
const replaced = computed(() =>
  props.plan.chapters.filter((row) => row.contribution === "replace").map((row) => row.id),
);
const { failed: unread, retry: readAgain } = useChapterScripts(() => props.bookId, replaced);
const edits = computed(() =>
  replaced.value.every((id) => scriptsStore.held(props.bookId, id))
    ? replaced.value.reduce(
        (n, id) => n + scriptsStore.segmentsOf(props.bookId, id).filter((seg) => seg.edited).length,
        0,
      )
    : null,
);
const ready = computed(() => props.plan.chapters.length > 0 && !props.est.reading);
const perChapter = computed(() => (props.est.chapters ? props.est.cost / props.est.chapters : 0));
const cached = computed(() => props.est.rates?.withObservedCache ?? null);
const cautions = computed(() => props.est.rates?.cautions ?? []);

const book = computed(() => libraryStore.bookById(props.bookId));
const spent = computed(() => jobsStore.scriptSpent(props.bookId));
const held = computed(() => jobsStore.scriptReserved(props.bookId) ?? 0);
const cap = computed(() => book.value?.scriptBudget ?? null);
/** the lower of the scripting budget and the book's cap, less spent and held */
const left = computed(() =>
  Number.isFinite(props.est.remaining) ? Math.max(0, props.est.remaining) : null,
);
const after = computed(() => (left.value === null ? null : left.value - props.est.cost));
/** the bar's whole: the cap, or everything there is when there is none */
const whole = computed(() =>
  Math.max(cap.value ?? 0, (spent.value ?? 0) + held.value + props.est.cost, 1e-9),
);
const share = (n: number) => `${Math.min(100, (n / whole.value) * 100)}%`;

const runs = computed(() =>
  jobsStore.jobs.filter((j) => j.bookId === props.bookId && !j.finishedAt && j.scriptRun),
);
</script>

<template>
  <div class="text-xs">
    <div class="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <template v-if="!plan.chapters.length">
        <div class="text-2xl font-semibold text-zinc-400">—</div>
        <p class="text-zinc-500">Tick chapters to see what a run would cost.</p>
      </template>
      <template v-else-if="!ready">
        <div class="text-2xl font-semibold text-zinc-400">…</div>
        <p class="text-zinc-500" role="status">
          Reading {{ est.reading }} chapters to count requests.
        </p>
      </template>
      <template v-else>
        <div class="flex items-baseline gap-2">
          <span class="font-mono text-2xl font-semibold">{{ money(est.cost) }}</span>
          <span v-if="cached" class="font-mono text-zinc-500"
            >≈ {{ money(cached.cost) }} with cache</span
          >
          <UiHint
            v-if="cautions.length"
            label="why this is an estimate"
            :text="
              cautions.join(' ') +
              ' Each request is priced when it comes back, not when the run starts.'
            "
          />
        </div>
        <p class="text-zinc-500">
          {{ aboutDuration(est.seconds) }} · {{ est.chapters }} chapters · {{ est.chunks }} requests
          · {{ money(perChapter) }} a chapter
        </p>
      </template>
    </div>

    <dl v-if="ready" class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 px-4 py-3">
      <dt class="text-zinc-500">Input · ~{{ est.inputTokens.toLocaleString() }} tokens</dt>
      <dd class="text-right font-mono">{{ money(est.inputCost) }}</dd>
      <dt class="text-zinc-500">
        Output · ~{{ est.outputTokens.toLocaleString() }} tokens<template
          v-if="est.reasoningTokens"
        >
          incl. thinking</template
        >
      </dt>
      <dd class="text-right font-mono">{{ money(est.outputCost) }}</dd>
      <template v-if="plan.replace">
        <dt class="text-zinc-500">Replacing a finished script</dt>
        <dd class="text-right font-mono">{{ plan.replace }}</dd>
      </template>
      <template v-if="est.rates && est.rates.withoutPromotions > est.rates.cost + 1e-9">
        <dt class="text-zinc-500">Without today’s discounts</dt>
        <dd class="text-right font-mono text-zinc-500">{{ money(est.rates.withoutPromotions) }}</dd>
      </template>
    </dl>
    <div v-if="plan.replace" class="space-y-1 px-4 pb-3 text-[11px]">
      <CorrectionsNote
        :edits="edits"
        :unread="unread.length"
        scope="this selection"
        @retry="readAgain"
      />
      <p class="leading-snug text-zinc-500">
        Each replaced script is kept in its chapter’s history, and stays the chapter’s script if the
        new attempt fails or is cancelled.
      </p>
    </div>

    <div class="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="font-medium">Book budget</div>
          <p v-if="spent === undefined" class="text-zinc-500">Reading what this book has spent…</p>
          <p v-else class="text-zinc-500">
            {{ money(spent) }} spent<template v-if="held"> · {{ money(held) }} held</template
            ><template v-if="left !== null"> · {{ money(left) }} left</template>
          </p>
        </div>
        <UiNumber
          class="w-24 shrink-0"
          prefix="$"
          :model-value="cap"
          :min="0"
          :step="1"
          :empty="null"
          placeholder="No cap"
          label="Book scripting budget"
          @update:model-value="(v: number | null) => libraryStore.setScriptBudget(bookId, v)"
        />
      </div>
      <div class="mt-2 flex h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <span class="bg-zinc-500" :style="{ width: share(spent ?? 0) }" data-tip="spent"></span>
        <span
          class="bg-zinc-400"
          :style="{ width: share(held) }"
          data-tip="held by running jobs"
        ></span>
        <span
          class="bg-violet-500"
          :style="{ width: share(ready ? est.cost : 0) }"
          data-tip="this run"
        ></span>
      </div>
      <p
        v-if="after !== null && ready && est.cost"
        class="mt-1"
        :class="after < 0 ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500'"
      >
        {{
          after < 0
            ? `Short by ${money(-after)} — it does not fit.`
            : `Leaves ${money(after)} after this run.`
        }}
      </p>
    </div>

    <div class="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <BookPromptSummary :book-id="bookId" />
    </div>

    <div
      v-if="est.blockers.length && !est.reading"
      class="space-y-1 border-t border-amber-300 bg-amber-50 px-4 py-2 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
      role="status"
    >
      <p v-for="reason in est.blockers" :key="reason">{{ reason }}</p>
    </div>

    <div
      v-if="runs.length"
      class="space-y-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800"
    >
      <div
        v-for="job in runs.slice(0, 3)"
        :key="job.id"
        class="rounded-lg bg-violet-50 p-2.5 dark:bg-violet-500/10"
      >
        <div class="flex justify-between gap-2">
          <span class="truncate font-medium"
            >{{ job.scriptRun!.profile.name
            }}<template v-if="job.chapterId != null">
              · {{ libraryStore.chapterRef(job.bookId, job.chapterId) }}</template
            ></span
          ><button class="text-zinc-500 hover:underline" @click="jobsStore.cancelJob(job.id)">
            Cancel
          </button>
        </div>
        <p class="mt-1 text-[11px] text-zinc-500">
          {{ job.scriptRun!.completed }}/{{ job.scriptRun!.requests }} requests ·
          {{ job.scriptRun!.active }} active · {{ money(job.scriptRun!.cost)
          }}<span
            v-if="
              !job.scriptRun!.active &&
              !endpointsStore.profiles.find((p) => p.id === job.scriptRun!.profile.id)?.enabled
            "
          >
            · Endpoint paused</span
          >
        </p>
      </div>
      <RouterLink
        v-if="runs.length > 3"
        to="/queue"
        class="block text-violet-600 dark:text-violet-400"
        >{{ runs.length - 3 }} more queued chapters · Open queue <NextIcon class="icon-sm"
      /></RouterLink>
    </div>
  </div>
</template>
