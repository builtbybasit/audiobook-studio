<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { retriable, useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// Queue: every job across every book. Running now, the pending queue, endpoint utilisation, and
// history with retry. A clock tick keeps elapsed times moving.
import { computed, ref } from "vue";
import { useNow } from "@vueuse/core";

import StatusDot from "@/components/StatusDot.vue";
import JobDetails from "@/views/queue/JobDetails.vue";
import UpNext from "@/views/queue/UpNext.vue";
import { KIND_LABEL, stageLink } from "@/views/queue/stage";
import type { Job, JobKind } from "@/types";
import type { Component } from "vue";
import {
  AudioLines as NarrationIcon,
  Download as ExportIcon,
  PencilLine as ScriptingIcon,
  Captions as TranscribeIcon,
  AudioWaveform as EffectsIcon,
  NotebookPen as FactsIcon,
  IdCard as ProfilesIcon,
  RotateCcw as RetryIcon,
  X as CloseIcon,
} from "@lucide/vue";
import { plural } from "@/lib/contents";
import { pricingLabel, unifyEndpoint } from "@/lib/endpoints";
import { useBookJobs, useBooks, useEndpointLive } from "@/queries";
import { hhmm } from "@/lib/format";

const endpointsStore = useEndpointsStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const selectedId = ref<number | null>(null);
const selectedJob = computed(() => jobsStore.jobs.find((j) => j.id === selectedId.value) ?? null);
function openRow(event: MouseEvent, job: Job) {
  if ((event.target as HTMLElement).closest("button, a, input")) return;
  selectedId.value = job.id;
}
const clock = useNow({ interval: 500 });
const now = computed(() => clock.value.getTime());
useEndpointLive();
// the Queue can be the first page opened, before any of the books it names has loaded
useBooks(() => jobsStore.jobs.map((j) => j.bookId));

const icon: Record<JobKind, Component> = {
  scripting: ScriptingIcon,
  narration: NarrationIcon,
  export: ExportIcon,
  transcribe: TranscribeIcon,
  effects: EffectsIcon,
  facts: FactsIcon,
  profiles: ProfilesIcon,
};
const running = computed(() => jobsStore.jobs.filter((j) => j.status === "running"));
const queued = computed(() => jobsStore.jobs.filter((j) => j.status === "queued"));
const history = computed(() =>
  jobsStore.jobs
    .filter((j) => j.finishedAt)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)),
);
const counts = computed(() => ({
  running: running.value.length,
  queued: queued.value.length,
  done: jobsStore.jobs.filter((j) => j.status === "done").length,
  failed: jobsStore.jobs.filter((j) => j.status === "failed").length,
}));
const filter = ref("all");
// Asked of the store: a chapter's label cannot answer it (a failed re-script puts the status back,
// a failed narration replacement still reads as narrated).
const retryable = computed(() => jobsStore.retryableFailures().length);
const filtered = computed(() =>
  filter.value === "all" ? history.value : history.value.filter((j) => j.status === filter.value),
);
// rows drawn, a page at a time; past the jobs read, the server is asked for older ones
const ROWS = 100;
const rows = ref(ROWS);
const { older, showOlder } = useBookJobs();
const shown = computed(() => filtered.value.slice(0, rows.value));
function showMore() {
  rows.value += ROWS;
  if (rows.value > filtered.value.length && older.value) showOlder();
}

const book = (j: Job) => libraryStore.bookById(j.bookId);
// by reading number only: a later title would give the plot away
const chapterRef = (j: Job) =>
  j.chapterId == null ? undefined : libraryStore.chapterRef(j.bookId, j.chapterId);
const castUsage = (j: Job) => j.factsRun?.usage ?? j.profilesRun?.usage;
const elapsed = (j: Job) =>
  fmtDur(((j.finishedAt ?? now.value) - (j.startedAt ?? now.value)) / 1000);
const fmtDur = (s: number) =>
  s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
// from the server's count or a loaded script: a chapter no page read is not 0 of 0
function segStats(j: Job) {
  const lines = j.chapterId == null ? undefined : scriptsStore.lineCountsOf(j.bookId, j.chapterId);
  return {
    total: lines?.total ?? 0,
    done: lines?.done ?? 0,
    gen: lines?.generating ?? 0,
    failed: lines?.failed ?? 0,
  };
}
// One count per running row: its four figures share it, and the row re-renders twice a second.
const segStatsOf = computed(() => {
  const by: Record<number, ReturnType<typeof segStats>> = {};
  for (const j of running.value) by[j.id] = segStats(j);
  return by;
});
// Uses the tick in the expression, not a spare `const _tick = now.value` that an unused-variable
// pass would delete, silently freezing the ETA.
const eta = computed(() => {
  const e = jobsStore.eta;
  return e && { ...e, at: now.value + e.seconds * 1000 };
});
const finishAt = computed(() => (eta.value ? hhmm(eta.value.at) : null));
const canNotify = "Notification" in window;
async function toggleNotify() {
  if (uiStore.notify) {
    uiStore.notify = false;
    return;
  }
  if (canNotify && Notification.permission !== "granted") {
    const r = await Notification.requestPermission();
    if (r !== "granted") {
      uiStore.toast("Browser notifications are blocked", {
        kind: "warn",
        description: "You will still get in-app toasts when a book finishes.",
      });
    }
  }
  uiStore.notify = true;
}
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Queue</h1>
        <p class="text-sm text-zinc-500">
          Every job across the library. Click a job to inspect its activity, timing, and errors.
        </p>
      </div>
      <div class="flex items-center gap-3 text-xs">
        <span
          v-if="eta"
          class="rounded-md bg-violet-50 px-2 py-1 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
          >≈ finishes at <b>{{ finishAt }}</b> · in {{ fmtDur(eta.seconds)
          }}<span v-if="eta.books > 1"> · {{ eta.books }} books in parallel</span></span
        >
        <button
          class="btn-ghost btn-xs"
          :class="uiStore.notify && 'border-violet-400 text-violet-600'"
          @click="toggleNotify"
        >
          {{
            uiStore.notify
              ? "🔔 notifying when a book finishes"
              : "🔕 notify me when a book finishes"
          }}
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="card p-4">
        <div class="label">Running</div>
        <div class="text-2xl font-semibold text-violet-500">{{ counts.running }}</div>
      </div>
      <div class="card p-4">
        <div class="label">Queued</div>
        <div class="text-2xl font-semibold">{{ counts.queued }}</div>
      </div>
      <div class="card p-4">
        <div class="label">Done</div>
        <div class="text-2xl font-semibold text-emerald-500">
          {{ counts.done }}<span v-if="older">+</span>
        </div>
      </div>
      <div class="card p-4">
        <div class="label">Failed</div>
        <div class="text-2xl font-semibold" :class="counts.failed ? 'text-red-500' : ''">
          {{ counts.failed }}<span v-if="older">+</span>
        </div>
      </div>
    </div>

    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div class="min-w-0 space-y-5">
        <section class="card overflow-hidden">
          <div
            class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"
          >
            <span class="label">Running now</span
            ><span class="text-xs text-zinc-400">{{ running.length }}</span>
            <button
              v-if="jobsStore.activeJobs.length"
              class="ml-auto whitespace-nowrap text-xs text-zinc-400 hover:text-red-500"
              @click="jobsStore.cancelAll()"
            >
              cancel all ({{ jobsStore.activeJobs.length }})
            </button>
          </div>
          <div v-if="!running.length" class="px-4 py-6 text-sm text-zinc-500">
            Idle. Start scripting, narration, or an export from a book.
          </div>
          <div class="max-h-80 overflow-y-auto">
            <div
              v-for="j in running"
              :key="j.id"
              class="cursor-pointer border-b border-zinc-100 px-4 py-3 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-900"
              @click="openRow($event, j)"
            >
              <div class="flex items-center gap-3">
                <span
                  class="grid h-8 w-8 place-items-center rounded-lg bg-violet-500/15 text-violet-500"
                  ><component :is="icon[j.kind]" class="icon"
                /></span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 text-sm">
                    <button
                      class="font-semibold hover:text-violet-500 hover:underline"
                      :aria-label="`View activity for ${jobsStore.labelOf(j)}`"
                      @click="selectedId = j.id"
                    >
                      {{ KIND_LABEL[j.kind] }}</button
                    ><span class="truncate text-zinc-500"
                      >· {{ book(j)?.title
                      }}<span v-if="chapterRef(j)"> · {{ chapterRef(j) }}</span></span
                    >
                    <span
                      v-if="j.bulk"
                      class="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800"
                      :data-tip="`${j.bulk.op}${j.bulk.scope ? ' · ' + j.bulk.scope : ''}`"
                      >{{ j.bulk.index }}/{{ j.bulk.total }}</span
                    >
                  </div>
                  <div class="mt-1.5 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800">
                    <div
                      class="h-1.5 rounded bg-violet-500 transition-all"
                      :style="{ width: j.progress + '%' }"
                    ></div>
                  </div>
                </div>
                <div class="w-24 text-right font-mono text-xs text-zinc-500">
                  {{ Math.round(j.progress) }}% · {{ elapsed(j) }}
                </div>
                <RouterLink :to="stageLink(j)" class="btn-ghost btn-xs">Open</RouterLink>
                <button class="btn-ghost btn-xs" @click="selectedId = j.id">Activity</button>
                <button class="btn-ghost btn-xs text-red-500" @click="jobsStore.cancelJob(j.id)">
                  Cancel
                </button>
              </div>
              <div v-if="j.exportRun" class="mt-2 flex flex-wrap gap-3 pl-11 text-xs text-zinc-500">
                <span
                  >{{ j.exportRun.stage }} <b>{{ j.exportRun.done }}</b> of
                  {{ j.exportRun.chapterIds.length }} chapters</span
                >
                <span
                  >file <b>{{ j.exportRun.file }}</b> of {{ j.exportRun.files }}</span
                >
                <span class="min-w-0 truncate font-mono">{{ j.exportRun.fileName }}</span>
              </div>
              <div
                v-else-if="j.kind === 'narration'"
                class="mt-2 flex gap-3 pl-11 text-xs text-zinc-500"
              >
                <span
                  ><b class="text-emerald-500">{{ segStatsOf[j.id].done }}</b> done</span
                >
                <span
                  ><b class="text-violet-500">{{ segStatsOf[j.id].gen }}</b> generating</span
                >
                <span
                  ><b :class="segStatsOf[j.id].failed ? 'text-red-500' : ''">{{
                    segStatsOf[j.id].failed
                  }}</b>
                  failed</span
                >
                <span>of {{ segStatsOf[j.id].total }} segments</span>
              </div>
              <div v-else-if="castUsage(j)" class="mt-2 flex gap-3 pl-11 text-xs text-zinc-500">
                <span v-if="j.profilesRun"
                  ><b class="text-emerald-500">{{ j.profilesRun.rewritten ?? 0 }}</b
                  >/{{ j.profilesRun.speakers }} profiles</span
                >
                <span>{{ plural(castUsage(j)!.requests, "request") }}</span>
                <span
                  >{{
                    (castUsage(j)!.inputTokens + castUsage(j)!.outputTokens).toLocaleString()
                  }}
                  tokens</span
                >
              </div>
              <div v-else-if="j.transcribeRun" class="mt-2 flex gap-3 pl-11 text-xs text-zinc-500">
                <span
                  ><b class="text-emerald-500">{{ j.transcribeRun.transcribed }}</b
                  >/{{ j.transcribeRun.lines }} lines heard</span
                >
                <span
                  ><b :class="j.transcribeRun.mismatched ? 'text-amber-600' : ''">{{
                    j.transcribeRun.mismatched
                  }}</b>
                  heard wrong</span
                >
                <span v-if="j.transcribeRun.failed"
                  ><b class="text-red-500">{{ j.transcribeRun.failed }}</b> failed</span
                >
              </div>
            </div>
          </div>
        </section>

        <UpNext :queued="queued" @open="selectedId = $event" />

        <section class="card overflow-hidden">
          <div
            class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800"
          >
            <span class="label">History</span>
            <div class="ml-3 flex gap-1">
              <button
                v-for="f in ['all', 'done', 'failed', 'cancelled']"
                :key="f"
                class="rounded px-2 py-0.5 text-xs capitalize"
                :class="
                  filter === f
                    ? 'bg-zinc-200 dark:bg-zinc-700'
                    : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                "
                @click="
                  filter = f;
                  rows = ROWS;
                "
              >
                {{ f }}
              </button>
            </div>
            <div class="ml-auto flex items-center gap-3 whitespace-nowrap text-xs">
              <button
                v-if="retryable"
                class="text-violet-500 hover:underline"
                @click="jobsStore.retryAllFailed()"
              >
                <RetryIcon class="icon-sm" /> retry failed ({{ retryable }})
              </button>
              <button
                v-if="history.length"
                class="text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
                @click="jobsStore.clearFinished()"
              >
                clear
              </button>
            </div>
          </div>
          <div v-if="!shown.length" class="px-4 py-4 text-sm text-zinc-500">
            No {{ filter === "all" ? "" : filter }} jobs yet.
          </div>
          <div v-else class="max-h-[28rem] overflow-y-auto">
            <table class="w-full text-sm">
              <tbody>
                <tr
                  v-for="j in shown"
                  :key="j.id"
                  class="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-900"
                  @click="openRow($event, j)"
                >
                  <td class="w-8 py-2 pl-4">
                    <StatusDot :status="j.status === 'cancelled' ? 'none' : j.status" />
                  </td>
                  <td class="w-6 text-zinc-400">
                    <component :is="icon[j.kind]" class="icon-sm" />
                  </td>
                  <td class="py-2">
                    <button
                      class="text-left hover:text-violet-500 hover:underline"
                      :aria-label="`View activity for ${jobsStore.labelOf(j)}`"
                      @click="selectedId = j.id"
                    >
                      {{ jobsStore.labelOf(j) }}
                    </button>
                    <div class="text-xs text-zinc-500">{{ book(j)?.title }}</div>
                  </td>
                  <td
                    class="w-24 text-xs capitalize"
                    :class="{
                      'text-emerald-500': j.status === 'done',
                      'text-red-500': j.status === 'failed',
                      'text-zinc-400': j.status === 'cancelled',
                    }"
                  >
                    {{ j.status }}
                  </td>
                  <td class="w-20 text-right font-mono text-xs text-zinc-500">{{ elapsed(j) }}</td>
                  <td class="w-24 text-right font-mono text-xs text-zinc-400">
                    {{ hhmm(j.finishedAt!) }}
                  </td>
                  <td class="w-28 pr-4 text-right">
                    <button
                      v-if="j.status !== 'done' && retriable(j)"
                      class="btn-ghost btn-xs"
                      @click="jobsStore.retryJob(j.id)"
                    >
                      <RetryIcon class="icon-sm" /> Retry
                    </button>
                    <button
                      class="ml-1 rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-red-500 dark:hover:bg-zinc-800"
                      data-tip="Remove from history"
                      aria-label="Remove from history"
                      @click="jobsStore.removeJob(j.id)"
                    >
                      <CloseIcon class="icon-sm" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <button
              v-if="filtered.length > rows || older"
              class="btn-ghost btn-xs m-2 justify-center"
              @click="showMore"
            >
              Show older
            </button>
          </div>
        </section>
      </div>

      <aside class="space-y-3">
        <div class="card p-4">
          <div class="label mb-3">Endpoint pool</div>
          <div v-for="e in endpointsStore.endpoints" :key="e.id" class="mb-3 last:mb-0">
            <div class="flex items-center gap-2 text-sm">
              <span
                class="h-2 w-2 rounded-full"
                :class="e.enabled ? 'bg-emerald-500' : 'bg-zinc-400'"
              ></span>
              <span class="min-w-0 flex-1 truncate" :class="!e.enabled && 'text-zinc-400'">{{
                e.name
              }}</span>
              <span v-if="e.backoffUntil > Date.now()" class="text-[10px] text-violet-500"
                >backing off</span
              >
              <span class="font-mono text-xs text-zinc-500"
                >{{ jobsStore.endpointLoad[e.id].active }}/{{ e.concurrency }}</span
              >
            </div>
            <div class="mt-1 flex gap-0.5">
              <div
                v-for="i in e.concurrency"
                :key="i"
                class="h-1.5 flex-1 rounded-sm"
                :class="
                  i <= jobsStore.endpointLoad[e.id].active
                    ? 'bg-violet-500 animate-pulse'
                    : 'bg-zinc-200 dark:bg-zinc-800'
                "
              ></div>
            </div>
            <div class="mt-1 text-[11px] text-zinc-500">
              {{ jobsStore.endpointLoad[e.id].done }} segments done ·
              {{ jobsStore.endpointLoad[e.id].failed }} failed ·
              {{ pricingLabel(unifyEndpoint(e)) }}
            </div>
          </div>
          <RouterLink
            to="/endpoints"
            class="btn-ghost btn-xs mt-2 w-full justify-center"
            data-tip="Health, keys, voices, spend and concurrency for every endpoint"
            >Manage endpoints</RouterLink
          >
        </div>
        <div class="card p-4 text-xs leading-relaxed text-zinc-500">
          <div class="label mb-1">Rules</div>
          One book's chapters run <b>sequentially</b> so roster and recap carry forward. Different
          books can run at the same time. Within a chapter, each segment goes to the endpoint that
          owns its speaker’s voice, up to that endpoint’s concurrency; segments over an endpoint’s
          character limit are sent in parts.
        </div>
      </aside>
    </div>
    <JobDetails :job="selectedJob" :now="now" @close="selectedId = null" />
  </div>
</template>
