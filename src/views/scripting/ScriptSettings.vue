<script setup lang="ts">
import { computed } from "vue";
import { useApp } from "@/stores/app";
import { UiNumber, UiSelect, UiSwitch, UiTooltip } from "@/ui";
import {
  ArrowRight as NextIcon,
  CircleHelp as HintIcon,
  ExternalLink as ExternalIcon,
} from "@lucide/vue";
const props = defineProps<{ bookId: string; selected: number[] }>();
defineEmits<{ configure: [] }>();
const app = useApp();
const est = computed(() => app.scriptEstimate(props.bookId, props.selected));
const book = computed(() => app.bookById(props.bookId)!);
const spent = computed(() => app.scriptSpent(props.bookId));
const reserved = computed(() => app.scriptReserved(props.bookId));
const remaining = computed(() =>
  book.value.scriptBudget == null
    ? null
    : Math.max(0, book.value.scriptBudget - spent.value - reserved.value),
);
const runs = computed(() =>
  app.jobs.filter((j) => j.bookId === props.bookId && !j.finishedAt && j.scriptRun),
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
      v-model="app.scriptSettings.profile"
      :options="
        app.profiles.map((p) => ({
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
    <UiSwitch v-model="app.scriptSettings.stripWatermarks" label="Strip site boilerplate" />
    <dl class="grid grid-cols-2 gap-y-1.5">
      <dt class="text-zinc-500">Chapters / requests</dt>
      <dd class="text-right font-mono">{{ est.chapters }} / {{ est.chunks }}</dd>
      <dt class="text-zinc-500">Input · ~{{ est.inputTokens.toLocaleString() }} tokens</dt>
      <dd class="text-right font-mono">{{ money(est.inputCost) }}</dd>
      <dt class="text-zinc-500">Output · ~{{ est.outputTokens.toLocaleString() }} tokens</dt>
      <dd class="text-right font-mono">{{ money(est.outputCost) }}</dd>
      <dt class="font-medium">Estimated total</dt>
      <dd class="text-right font-mono font-semibold">{{ money(est.cost) }}</dd>
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
          @update:model-value="(v: number | null) => (book!.scriptBudget = v)"
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
        ><button class="text-zinc-500 hover:underline" @click="app.cancelJob(job.id)">
          Cancel
        </button>
      </div>
      <p class="mt-1 text-[11px] text-zinc-500">
        {{ job.scriptRun!.completed }}/{{ job.scriptRun!.requests }} requests ·
        {{ job.scriptRun!.active }} active · {{ money(job.scriptRun!.cost)
        }}<span
          v-if="
            !job.scriptRun!.active &&
            !app.profiles.find((p) => p.id === job.scriptRun!.profile.id)?.enabled
          "
        >
          · Endpoint paused</span
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
