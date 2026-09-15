<script setup lang="ts">
import { useJobsStore } from "@/stores/jobs";
import { useUiStore } from "@/stores/ui";

import { computed } from "vue";

import type { Profile } from "@/types";
const props = defineProps<{ profile: Profile; now: number }>();
const jobsStore = useJobsStore();
const uiStore = useUiStore();
const stats = computed(() => jobsStore.scriptTelemetry[props.profile.id]);
const error = computed(() => stats.value?.lastError);
const recovered = computed(() => !!error.value && (stats.value?.lastSuccess ?? 0) > error.value.at);
const cooldown = computed(() =>
  Math.max(0, Math.ceil(((stats.value?.backoffUntil ?? 0) - props.now) / 1000)),
);
const requests = computed(() =>
  jobsStore.jobs.filter((j) => j.scriptRun?.profile.id === props.profile.id && !j.finishedAt),
);
const active = computed(() => requests.value.reduce((n, j) => n + j.scriptRun!.active, 0));
const queued = computed(() =>
  requests.value.reduce(
    (n, j) => n + j.scriptRun!.requests - j.scriptRun!.completed - j.scriptRun!.active,
    0,
  ),
);
const usage = computed(() =>
  jobsStore.scriptUsage
    .filter((x) => x.profileId === props.profile.id)
    .reduce(
      (n, x) => ({
        input: n.input + x.inputTokens,
        output: n.output + x.outputTokens,
        cost: n.cost + x.cost,
      }),
      { input: 0, output: 0, cost: 0 },
    ),
);
const history = computed(() => stats.value?.history.filter((x) => x.ok) ?? []);
const latency = computed(() =>
  history.value.length ? history.value.reduce((n, x) => n + x.ms, 0) / history.value.length : null,
);
const success = computed(() =>
  stats.value && stats.value.completed + stats.value.failures
    ? Math.round((stats.value.completed / (stats.value.completed + stats.value.failures)) * 100) +
      "%"
    : "—",
);
const points = computed(() => {
  const rows = history.value.slice(-16);
  const max = Math.max(1, ...rows.map((x) => x.ms));
  const min = Math.min(...rows.map((x) => x.ms));
  return rows
    .map(
      (x, i) =>
        `${(i * 64) / Math.max(1, rows.length - 1)},${20 - ((x.ms - min) / Math.max(1, max - min)) * 16}`,
    )
    .join(" ");
});
const number = (n: number) => n.toLocaleString();
const cost = computed(
  () =>
    "$" +
    usage.value.cost.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 5,
    }),
);
async function copyError() {
  if (!error.value) return;
  try {
    await navigator.clipboard.writeText(
      JSON.stringify(
        {
          ...error.value,
          endpoint: error.value.baseUrl.replace(/\/$/, "") + "/chat/completions",
          simulated: true,
        },
        null,
        2,
      ),
    );
    uiStore.toast("Error details copied", { kind: "success" });
  } catch {
    uiStore.toast("Could not copy error details", { kind: "error" });
  }
}
</script>
<template>
  <div class="mt-3 space-y-2">
    <dl
      class="grid grid-cols-3 gap-x-3 gap-y-3 rounded-lg bg-zinc-50 px-3 py-2.5 text-xs dark:bg-zinc-800/50 xl:grid-cols-6"
      aria-label="Endpoint activity this session"
    >
      <div>
        <dt class="text-[10px] text-zinc-500 dark:text-zinc-400">Active / limit</dt>
        <dd class="mt-0.5 font-mono">{{ number(active) }} / {{ number(profile.concurrency) }}</dd>
        <dd class="text-[10px] text-zinc-500">{{ number(queued) }} waiting</dd>
      </div>
      <div>
        <dt class="text-[10px] text-zinc-500 dark:text-zinc-400">Avg. latency</dt>
        <dd class="mt-0.5 flex items-center gap-1 font-mono">
          {{ latency === null ? "—" : (latency / 1000).toFixed(1) + "s"
          }}<svg
            v-if="history.length > 1"
            width="48"
            height="20"
            viewBox="0 0 64 24"
            aria-hidden="true"
            class="text-violet-500"
          >
            <polyline :points="points" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </dd>
      </div>
      <div>
        <dt class="text-[10px] text-zinc-500 dark:text-zinc-400">Success / 429s</dt>
        <dd class="mt-0.5 font-mono">{{ success }} / {{ stats?.rateLimits ?? 0 }}</dd>
        <dd class="text-[10px] text-zinc-500">{{ number(stats?.completed ?? 0) }} completed</dd>
      </div>
      <div>
        <dt class="text-[10px] text-zinc-500 dark:text-zinc-400">Input tokens</dt>
        <dd class="mt-0.5 font-mono">{{ number(usage.input) }}</dd>
      </div>
      <div>
        <dt class="text-[10px] text-zinc-500 dark:text-zinc-400">Output tokens</dt>
        <dd class="mt-0.5 font-mono">{{ number(usage.output) }}</dd>
      </div>
      <div>
        <dt class="text-[10px] text-zinc-500 dark:text-zinc-400">Spend</dt>
        <dd class="mt-0.5 font-mono">{{ cost }}</dd>
        <dd class="text-[10px] text-zinc-500">all books · demo</dd>
      </div>
    </dl>
    <details
      v-if="error"
      class="rounded-md border px-3 py-2 text-xs"
      :class="
        recovered
          ? 'border-zinc-200 dark:border-zinc-700'
          : 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10'
      "
    >
      <summary class="cursor-pointer text-zinc-600 dark:text-zinc-300">
        {{ recovered ? "Recovered" : "Rate limited" }} · HTTP {{ error.code
        }}<span class="text-zinc-500">
          · {{ Math.max(0, Math.floor((now - error.at) / 1000)) }}s ago</span
        ><span v-if="cooldown"> · retry in {{ cooldown }}s</span>
      </summary>
      <p class="mt-2 text-zinc-500">
        {{
          recovered
            ? "Requests have succeeded since this error."
            : !profile.enabled
              ? "Endpoint paused. Enable it to resume queued requests."
              : cooldown
                ? "Queued requests retry automatically after the cooldown."
                : "Waiting for the next queued request to retry."
        }}
        Chapter {{ error.chapterId }} · {{ error.model }} · simulated response.
      </p>
      <pre
        class="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-white/60 p-2 font-mono text-[11px] dark:bg-zinc-950/50"
        >{{ error.body }}</pre>
      <button class="mt-2 text-violet-600 hover:underline dark:text-violet-400" @click="copyError">
        Copy error details
      </button>
    </details>
  </div>
</template>
