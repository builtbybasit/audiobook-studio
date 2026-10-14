<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";

import { computed } from "vue";
import type { RunPlan, ScriptEstimate } from "@/types";
import { money } from "@/lib/pricing";
import { plural } from "@/lib/contents";
import { useChapterScripts } from "@/queries";
import { useScriptActivity } from "@/queries/scriptActivity";
import BookPromptSummary from "@/views/scripting/BookPromptSummary.vue";
import CorrectionsNote from "@/views/scripting/CorrectionsNote.vue";
import ScriptProfileSelect from "@/views/scripting/ScriptProfileSelect.vue";

import { UiHint, UiNumber, UiTooltip } from "@/ui";
import {
  ArrowRight as NextIcon,
  ChevronRight as ChevronIcon,
  CircleHelp as HintIcon,
  ExternalLink as ExternalIcon,
} from "@lucide/vue";
// worked out once on the page, for the run button too
const props = defineProps<{
  bookId: string;
  plan: RunPlan;
  est: ScriptEstimate & { reasoningTokens: number };
}>();
defineEmits<{ configure: [] }>();
const endpointsStore = useEndpointsStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
// the "if cache holds" figure reads these from the query cache, so they must be loaded here
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
const book = computed(() => libraryStore.bookById(props.bookId));
const spent = computed(() => jobsStore.scriptSpent(props.bookId));
const reserved = computed(() => jobsStore.scriptReserved(props.bookId));
/** the lower of the scripting budget and the book's cap */
const remaining = computed(() =>
  Number.isFinite(props.est.remaining) ? Math.max(0, props.est.remaining) : null,
);
const time = computed(() =>
  props.est.seconds < 60
    ? "~" + Math.ceil(props.est.seconds) + "s"
    : "~" + Math.ceil(props.est.seconds / 60) + " min",
);
const runs = computed(() =>
  jobsStore.jobs.filter((j) => j.bookId === props.bookId && !j.finishedAt && j.scriptRun),
);
</script>
<template>
  <div class="space-y-3 text-xs">
    <div class="flex items-center justify-between">
      <span class="label">This run</span
      ><button
        class="text-violet-600 hover:underline dark:text-violet-400"
        @click="$emit('configure')"
      >
        Manage endpoints <ExternalIcon class="icon-sm" />
      </button>
    </div>
    <ScriptProfileSelect />
    <p v-if="est.profile" class="text-[11px] text-zinc-500">
      {{
        est.profile.maxChars
          ? est.profile.maxChars.toLocaleString() + " chars / chunk"
          : "Whole chapters"
      }}
      · {{ est.profile.concurrency.toLocaleString() }} concurrent
    </p>
    <CorrectionsNote
      :edits="edits"
      :unread="unread.length"
      scope="this selection"
      @retry="readAgain"
    />
    <p v-if="plan.replace" class="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
      {{ plan.replace }} of these chapters already {{ plan.replace === 1 ? "has" : "have" }} a
      finished script. Each one is kept in its chapter's history before it is replaced, and stays
      the chapter's script if the new attempt fails or is cancelled.
    </p>
    <p v-if="est.reading" class="text-[11px] text-zinc-500" role="status">
      Reading the text of {{ plural(est.reading, "chapter") }} to price the run…
    </p>
    <details v-else class="group">
      <summary
        class="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden"
      >
        <ChevronIcon class="icon-sm text-zinc-400 transition-transform group-open:rotate-90" />
        <span class="text-zinc-500"
          >{{ plural(est.chapters, "chapter") }}<span v-if="est.chapters"> · {{ time }}</span></span
        >
        <span class="ml-auto font-mono font-semibold">{{ money(est.cost) }}</span>
      </summary>
      <dl class="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
        <dt class="text-zinc-500">Chapters / requests</dt>
        <dd class="text-right font-mono">{{ est.chapters }} / {{ est.chunks }}</dd>
        <dt v-if="plan.fresh || plan.replace" class="text-zinc-500">New / replacing</dt>
        <dd v-if="plan.fresh || plan.replace" class="text-right font-mono">
          {{ plan.fresh }} / {{ plan.replace }}
        </dd>
        <dt class="text-zinc-500">Input · ~{{ est.inputTokens.toLocaleString() }} tokens</dt>
        <dd class="text-right font-mono">{{ money(est.inputCost) }}</dd>
        <dt class="text-zinc-500">
          Output · ~{{ est.outputTokens.toLocaleString() }} tokens
          <!-- a reasoning model bills its thinking as output -->
          <UiHint
            v-if="est.reasoningTokens"
            label="thinking tokens"
            :text="`Includes ~${est.reasoningTokens.toLocaleString()} thinking tokens, going by ${est.profile?.name ?? 'this endpoint'}'s recent requests.`"
          />
        </dt>
        <dd class="text-right font-mono">{{ money(est.outputCost) }}</dd>
        <dt class="font-medium">Estimated total</dt>
        <dd class="text-right font-mono font-semibold">{{ money(est.cost) }}</dd>
        <!-- the budget is checked against the conservative figure only -->
        <template v-if="est.rates && est.rates.withObservedCache">
          <dt class="text-zinc-500">
            If cache holds at {{ Math.round(est.rates.withObservedCache.hitRate * 100) }}%
          </dt>
          <dd class="text-right font-mono text-zinc-500">
            {{ money(est.rates.withObservedCache.cost) }}
          </dd>
        </template>
        <template v-if="est.rates && est.rates.withoutPromotions > est.rates.cost + 1e-9">
          <dt class="text-zinc-500">Without today’s discounts</dt>
          <dd class="text-right font-mono text-zinc-500">
            {{ money(est.rates.withoutPromotions) }}
          </dd>
        </template>
      </dl>
      <details
        v-if="est.rates?.cautions.length"
        class="mt-2 rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/60"
      >
        <summary class="cursor-pointer select-none text-[11px] text-zinc-600 dark:text-zinc-300">
          Why this is an estimate<span
            v-if="est.rates.withObservedCache || est.rates.withoutPromotions > est.rates.cost"
          >
            and not a price</span
          >
        </summary>
        <ul class="mt-1.5 space-y-1 text-[11px] leading-snug text-zinc-500">
          <li v-for="why in est.rates.cautions" :key="why">{{ why }}</li>
          <li>
            Each request is priced when it comes back, not when the run starts, so a batch that
            crosses one of these boundaries charges its requests differently either side of it.
          </li>
        </ul>
      </details>
    </details>
    <div class="border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <span class="flex items-center gap-1 font-medium"
            >Book scripting budget<UiTooltip
              text="Covers every scripting run for this book. Blank = no cap; 0 = stop paid requests. Output limits reserve budget before dispatch."
              ><button
                type="button"
                class="text-zinc-400 hover:text-violet-500"
                aria-label="What this budget covers"
              >
                <HintIcon class="icon" /></button></UiTooltip
          ></span>
          <p v-if="spent === undefined" class="text-[11px] leading-snug text-zinc-500">
            Reading what this book has spent…
          </p>
          <p v-else class="text-[11px] leading-snug text-zinc-500">
            {{ money(spent) }} spent<span v-if="reserved"> · {{ money(reserved) }} reserved</span
            ><span
              v-if="remaining !== null"
              title="The lower of this budget and the book's overall cap, less what is spent and held"
            >
              · {{ money(remaining) }} available</span
            >
          </p>
          <p
            v-if="remaining !== null && est.cost && !est.reading"
            class="text-[11px] leading-snug"
            :class="est.cost > remaining ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500'"
          >
            This run would leave {{ money(Math.max(0, remaining - est.cost)) }}
            {{ est.cost > remaining ? "— it does not fit" : "of it" }}.
          </p>
        </div>
        <UiNumber
          class="w-28 shrink-0"
          prefix="$"
          :model-value="book?.scriptBudget ?? null"
          :min="0"
          :step="1"
          :empty="null"
          placeholder="No cap"
          label="Book scripting budget"
          @update:model-value="(v: number | null) => libraryStore.setScriptBudget(bookId, v)"
        />
      </div>
    </div>
    <!-- book notes: edited on the Overview -->
    <div class="border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <BookPromptSummary :book-id="bookId" />
    </div>
    <div
      v-if="est.blockers.length && !est.reading"
      class="space-y-1 rounded-lg bg-amber-50 p-2.5 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
      role="status"
    >
      <p v-for="reason in est.blockers" :key="reason">{{ reason }}</p>
    </div>
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
      <p v-if="job.scriptRun!.inputTokens" class="text-[11px] text-zinc-500">
        {{
          job.scriptRun!.cachedInput
            ? `${Math.round((job.scriptRun!.cachedInput / job.scriptRun!.inputTokens) * 100)}% of input cached so far`
            : "no cached input reported so far"
        }}<span v-if="job.scriptRun!.cacheUnreported">
          · {{ job.scriptRun!.cacheUnreported }} request{{
            job.scriptRun!.cacheUnreported === 1 ? "" : "s"
          }}
          reported no cache detail</span
        >
      </p>
    </div>
    <RouterLink
      v-if="runs.length > 3"
      to="/queue"
      class="block text-xs text-violet-600 dark:text-violet-400"
      >{{ runs.length - 3 }} more queued chapters · Open queue <NextIcon class="icon-sm"
    /></RouterLink>
  </div>
</template>
