<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";
import { useScriptsStore } from "@/stores/scripts";

import { computed } from "vue";

import { UiNumber, UiSelect, UiSwitch, UiTooltip } from "@/ui";
import {
  ArrowRight as NextIcon,
  CircleHelp as HintIcon,
  ExternalLink as ExternalIcon,
} from "@lucide/vue";
const props = defineProps<{ bookId: string; selected: number[] }>();
defineEmits<{ configure: [] }>();
const endpointsStore = useEndpointsStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();
const scriptsStore = useScriptsStore();
const est = computed(() => scriptingStore.scriptEstimate(props.bookId, props.selected));
const plan = computed(() => scriptingStore.scriptPlan(props.bookId, props.selected));
const edits = computed(() =>
  plan.value.chapters.reduce(
    (n, row) =>
      n + scriptsStore.segmentsOf(props.bookId, row.id).filter((seg) => seg.edited).length,
    0,
  ),
);
const book = computed(() => libraryStore.bookById(props.bookId)!);
const spent = computed(() => jobsStore.scriptSpent(props.bookId));
const reserved = computed(() => jobsStore.scriptReserved(props.bookId));
const remaining = computed(() =>
  book.value.scriptBudget == null
    ? null
    : Math.max(0, book.value.scriptBudget - spent.value - reserved.value),
);
const runs = computed(() =>
  jobsStore.jobs.filter((j) => j.bookId === props.bookId && !j.finishedAt && j.scriptRun),
);
const money = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
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
    <UiSelect
      v-model="scriptingStore.scriptSettings.profile"
      :options="
        endpointsStore.profiles.map((p) => ({
          value: p.id,
          label: p.name,
          hint: p.enabled ? p.model : 'Paused',
        }))
      "
      size="xs"
      block
      aria-label="Scripting endpoint"
    />
    <p v-if="est.profile" class="text-[11px] text-zinc-500">
      {{
        est.profile.maxChars
          ? est.profile.maxChars.toLocaleString() + " chars / chunk"
          : "Whole chapters"
      }}
      · {{ est.profile.concurrency.toLocaleString() }} concurrent
    </p>
    <UiSwitch
      v-model="scriptingStore.scriptSettings.stripWatermarks"
      label="Strip site boilerplate"
    />
    <!-- what a replacement keeps. Off is a deliberate choice, and it says what it costs. -->
    <div class="rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/60">
      <UiSwitch
        v-model="scriptingStore.scriptSettings.keepEdits"
        label="Preserve manual corrections"
      />
      <p class="mt-1 text-[11px] leading-snug text-zinc-500">
        <template v-if="scriptingStore.scriptSettings.keepEdits"
          >Speaker, type, direction and expression annotations you set by hand are re-applied to the
          new script wherever it wrote the same line. A correction whose line the new run rewrote,
          split or dropped cannot be carried across — the reader lists those afterwards rather than
          claiming they survived.</template
        >
        <template v-else
          >Every manual correction in the chapters below is discarded; the new run wins
          outright.</template
        >
        <span v-if="edits" class="text-zinc-400">
          {{ edits }} corrected line{{ edits === 1 ? "" : "s" }} in this selection.</span
        >
      </p>
    </div>
    <p v-if="plan.replace" class="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
      {{ plan.replace }} of these chapters already {{ plan.replace === 1 ? "has" : "have" }} a
      finished script. Each one is kept in its chapter's history before it is replaced, and stays
      the chapter's script if the new attempt fails or is cancelled.
    </p>
    <dl class="grid grid-cols-2 gap-y-1.5">
      <dt class="text-zinc-500">Chapters / requests</dt>
      <dd class="text-right font-mono">{{ est.chapters }} / {{ est.chunks }}</dd>
      <dt v-if="plan.fresh || plan.replace" class="text-zinc-500">New / replacing</dt>
      <dd v-if="plan.fresh || plan.replace" class="text-right font-mono">
        {{ plan.fresh }} / {{ plan.replace }}
      </dd>
      <dt class="text-zinc-500">Input · ~{{ est.inputTokens.toLocaleString() }} tokens</dt>
      <dd class="text-right font-mono">{{ money(est.inputCost) }}</dd>
      <dt class="text-zinc-500">Output · ~{{ est.outputTokens.toLocaleString() }} tokens</dt>
      <dd class="text-right font-mono">{{ money(est.outputCost) }}</dd>
      <dt class="font-medium">Estimated total</dt>
      <dd class="text-right font-mono font-semibold">{{ money(est.cost) }}</dd>
      <!-- The conservative figure is the one with the weight. The cheaper ones sit under it,
           labelled, and neither is what the budget is checked against. -->
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
      <dt class="text-zinc-500">Estimated time</dt>
      <dd class="text-right font-mono">
        {{
          est.chapters
            ? est.seconds < 60
              ? "~" + Math.ceil(est.seconds) + "s"
              : "~" + Math.ceil(est.seconds / 60) + " min"
            : "—"
        }}
      </dd>
    </dl>
    <!-- what could move the figure between the first request and the last -->
    <details
      v-if="est.rates?.cautions.length"
      class="rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/60"
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
          <p class="text-[11px] leading-snug text-zinc-500">
            {{ money(spent) }} spent<span v-if="reserved"> · {{ money(reserved) }} reserved</span
            ><span v-if="remaining !== null"> · {{ money(remaining) }} available</span>
          </p>
          <p
            v-if="remaining !== null && est.cost"
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
          :model-value="book.scriptBudget ?? null"
          :min="0"
          :step="1"
          :empty="null"
          placeholder="No cap"
          label="Book scripting budget"
          @update:model-value="(v: number | null) => libraryStore.setScriptBudget(bookId, v)"
        />
      </div>
    </div>
    <div
      v-if="est.blockers.length"
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
          >{{ job.scriptRun!.profile.name }} · ch {{ job.chapterId }}</span
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
      <!-- what the cache is actually doing, as the run goes -->
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
