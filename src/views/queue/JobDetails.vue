<script setup lang="ts">
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";

import { computed, ref, watch } from "vue";
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "reka-ui";
import { X as CloseIcon, Copy as CopyIcon, ArrowUpRight as OpenIcon } from "@lucide/vue";

import { duration } from "@/lib/endpoints";
import { jobDiagnostics } from "@/lib/jobActivity";
import type { Job } from "@/types";

const props = defineProps<{ job: Job | null; now: number }>();
const emit = defineEmits<{ close: [] }>();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const tab = ref("activity");
const search = ref("");
const issuesOnly = ref(false);
const limit = ref(100);
const copyStatus = ref("");
watch(
  () => props.job?.id,
  () => {
    search.value = "";
    issuesOnly.value = false;
    limit.value = 100;
    copyStatus.value = "";
    tab.value = "activity";
  },
);
const events = computed(() => props.job?.activity ?? []);
/** The other chapters of the same bulk run, so the panel can act on the run rather than one row. */
const siblings = computed(() => (props.job?.bulk ? jobsStore.runJobs(props.job.bulk.id) : []));
const runDone = computed(() => siblings.value.filter((j) => j.status === "done").length);
const runFailed = computed(() => siblings.value.filter((j) => j.status === "failed").length);
const runLeft = computed(() => siblings.value.filter((j) => !j.finishedAt).length);
const runRunning = computed(() => siblings.value.filter((j) => j.status === "running").length);
// stopping the rest of a run cannot be undone, so it is the one control here that asks first. The
// question closes when it stops being answerable — another job, or nothing left to stop — and not
// merely because a chapter finished while it was on screen, which happens the whole time a run is
// live and would take the question away mid-read.
const confirmCancel = ref(false);
watch([() => props.job?.id, () => runLeft.value === 0], () => (confirmCancel.value = false));
/** What stopping this run would actually stop, said in chapters rather than in job rows. */
const stopNote = computed(() => {
  const waiting = runLeft.value - runRunning.value;
  const parts: string[] = [];
  if (waiting)
    parts.push(
      `${waiting} chapter${waiting === 1 ? "" : "s"} waiting never start${waiting === 1 ? "s" : ""}`,
    );
  if (runRunning.value)
    parts.push(
      `${runRunning.value} still running stop${runRunning.value === 1 ? "s" : ""} after the requests already sent land`,
    );
  return parts.join(", and ");
});
function cancelRest() {
  if (props.job?.bulk) jobsStore.cancelRun(props.job.bulk.id);
  confirmCancel.value = false;
}
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  return events.value
    .filter(
      (e) =>
        (!issuesOnly.value || e.level !== "info") &&
        (!query || `${e.message} ${JSON.stringify(e.detail ?? {})}`.toLowerCase().includes(query)),
    )
    .slice()
    .reverse();
});
const issues = computed(() => events.value.filter((e) => e.level !== "info").length);
const stage = computed(() => {
  if (!props.job) return "/queue";
  return {
    path: `/book/${props.job.bookId}/${props.job.kind}`,
    query:
      props.job.chapterId == null
        ? undefined
        : {
            ch: String(props.job.chapterId),
            ...(props.job.kind === "narration" && props.job.status === "failed"
              ? { filter: "failed" }
              : {}),
          },
  };
});
const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const stamp = (at: number | null) => (at === null ? "—" : new Date(at).toLocaleString());
async function copy() {
  if (!props.job) return;
  try {
    await navigator.clipboard.writeText(jobDiagnostics(props.job));
    copyStatus.value = "Diagnostics copied";
  } catch {
    copyStatus.value = "Could not copy. Select the log text to copy it manually.";
  }
}
</script>

<template>
  <DialogRoot
    :open="!!job"
    @update:open="
      (open) => {
        if (!open) emit('close');
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/35" />
      <DialogContent
        class="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-zinc-200 bg-white shadow-2xl focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
      >
        <template v-if="job">
          <header class="shrink-0 border-b border-zinc-200 p-4 sm:p-5 dark:border-zinc-800">
            <div class="mb-2 flex items-center gap-2 text-xs">
              <span class="label">Job #{{ job.id }}</span>
              <span
                class="rounded bg-zinc-100 px-2 py-0.5 capitalize dark:bg-zinc-800"
                :class="
                  job.status === 'failed'
                    ? 'text-red-500'
                    : job.status === 'done'
                      ? 'text-emerald-600'
                      : 'text-violet-500'
                "
                >{{ job.cancelled && !job.finishedAt ? "Cancelling" : job.status }}</span
              >
              <DialogClose class="btn-ghost btn-xs ml-auto" aria-label="Close job details"
                ><CloseIcon class="icon"
              /></DialogClose>
            </div>
            <DialogTitle class="break-words text-lg font-semibold">{{ job.label }}</DialogTitle>
            <DialogDescription class="mt-1 text-sm text-zinc-500"
              >{{ libraryStore.bookById(job.bookId)?.title ?? job.bookId
              }}<span v-if="job.chapterId !== null">
                · Chapter {{ job.chapterId }}</span
              ></DialogDescription
            >
            <!-- the run this chapter belongs to: what was asked for, where this one sits in it,
                 and the one control that acts on the rest of it -->
            <div
              v-if="job.bulk"
              class="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-zinc-50 p-2 text-xs dark:bg-zinc-800/60"
            >
              <span class="font-medium">{{ job.bulk.op }}</span>
              <span class="text-zinc-500"
                >chapter {{ job.bulk.index }} of {{ job.bulk.total
                }}<span v-if="job.bulk.scope"> · {{ job.bulk.scope }}</span></span
              >
              <span class="text-zinc-400"
                >{{ runDone }} done · {{ runFailed }} failed · {{ runLeft }} to go</span
              >
              <button
                v-if="runLeft"
                class="btn-ghost btn-xs ml-auto"
                title="stop the chapters this run has not started; chapters it already finished keep their results"
                @click="confirmCancel = !confirmCancel"
              >
                Cancel the rest ({{ runLeft }})
              </button>
              <button
                v-else-if="runFailed"
                class="btn-ghost btn-xs ml-auto"
                title="run only the chapters of this run that failed, as one run again"
                @click="jobsStore.retryRunFailures(job.bulk!.id)"
              >
                Retry {{ runFailed }} failed
              </button>
              <!-- the one step in this panel Undo cannot take back, so it is asked for -->
              <div
                v-if="confirmCancel && runLeft"
                class="basis-full rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-zinc-200"
                role="alertdialog"
              >
                <p>
                  Stop the rest of <b>{{ job.bulk!.op }}</b
                  >? {{ stopNote }}.
                  <span v-if="runDone"
                    >The {{ runDone }} chapter{{ runDone === 1 ? "" : "s" }} this run already
                    finished {{ runDone === 1 ? "keeps its" : "keep their" }} results, and every
                    chapter it never reached keeps the script and audio it has now.</span
                  ><span v-else
                    >Every chapter it never reached keeps the script and audio it has now.</span
                  >
                  The run does not come back with Undo.
                </p>
                <div class="mt-2 flex gap-2">
                  <button class="btn-ghost btn-xs" @click="confirmCancel = false">
                    Keep running
                  </button>
                  <button
                    class="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
                    @click="cancelRest"
                  >
                    Cancel {{ runLeft }} chapter{{ runLeft === 1 ? "" : "s" }}
                  </button>
                </div>
              </div>
            </div>
            <div class="mt-4 grid grid-cols-3 gap-3 text-xs">
              <div>
                <div class="label">Progress</div>
                <div class="mt-1 font-mono text-sm">{{ Math.round(job.progress) }}%</div>
              </div>
              <div>
                <div class="label">Queue time</div>
                <div class="mt-1 font-mono text-sm">
                  {{ duration((job.startedAt ?? job.finishedAt ?? now) - job.queuedAt) }}
                </div>
              </div>
              <div>
                <div class="label">Run time</div>
                <div class="mt-1 font-mono text-sm">
                  {{
                    job.startedAt === null
                      ? "Not started"
                      : duration((job.finishedAt ?? now) - job.startedAt)
                  }}
                </div>
              </div>
            </div>
            <p
              v-if="job.waitingReason && !job.cancelled"
              class="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
            >
              {{ job.waitingReason }}. Active requests can still finish.
            </p>
            <p class="mt-3 text-xs text-zinc-500">
              Simulated · session only · no provider calls or charges
            </p>
          </header>

          <TabsRoot v-model="tab" class="flex min-h-0 flex-1 flex-col">
            <TabsList
              class="flex shrink-0 gap-5 border-b border-zinc-200 px-5 dark:border-zinc-800"
              aria-label="Job detail views"
            >
              <TabsTrigger
                v-for="item in [
                  { id: 'activity', label: 'Activity log' },
                  { id: 'details', label: 'Run details' },
                ]"
                :key="item.id"
                :value="item.id"
                class="border-b-2 border-transparent py-3 text-sm text-zinc-500 data-[state=active]:border-violet-500 data-[state=active]:text-violet-600"
                >{{ item.label }}</TabsTrigger
              >
            </TabsList>
            <TabsContent value="activity" class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              <div class="mb-4 flex flex-wrap items-center gap-2">
                <input
                  v-model="search"
                  class="input min-w-0 flex-1 text-xs"
                  placeholder="Search events, endpoint, segment…"
                  aria-label="Search job activity"
                  @input="limit = 100"
                />
                <button
                  class="btn-ghost btn-xs"
                  :aria-pressed="issuesOnly"
                  :class="issuesOnly ? 'border-amber-400 text-amber-700 dark:text-amber-300' : ''"
                  @click="
                    issuesOnly = !issuesOnly;
                    limit = 100;
                  "
                >
                  Warnings & errors ({{ issues }})
                </button>
              </div>
              <div class="mb-3 flex items-center justify-between text-xs text-zinc-500">
                <span
                  >{{ filtered.length }} {{ filtered.length === 1 ? "event" : "events" }} · newest
                  first</span
                ><span v-if="!job.finishedAt" class="text-violet-500">Live</span>
              </div>
              <p
                v-if="!job.activity"
                class="rounded-lg border border-dashed border-zinc-300 p-5 text-sm text-zinc-500 dark:border-zinc-700"
              >
                Detailed activity was not recorded for this older sample job. New jobs record their
                activity here.
              </p>
              <p v-else-if="!filtered.length" class="py-8 text-center text-sm text-zinc-500">
                No events match these filters.
              </p>
              <ol class="space-y-3">
                <li
                  v-for="event in filtered.slice(0, limit)"
                  :key="event.id"
                  class="flex gap-3 text-sm"
                >
                  <span
                    class="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    :class="
                      event.level === 'error'
                        ? 'bg-red-500'
                        : event.level === 'warning'
                          ? 'bg-amber-500'
                          : 'bg-zinc-300 dark:bg-zinc-600'
                    "
                  ></span>
                  <div class="min-w-0 flex-1 border-b border-zinc-100 pb-3 dark:border-zinc-800">
                    <div class="mb-1 flex flex-wrap gap-x-2 text-[11px] text-zinc-500">
                      <time :datetime="new Date(event.at).toISOString()">{{ clock(event.at) }}</time
                      ><span>+{{ duration(event.at - job.queuedAt) }}</span
                      ><span
                        v-if="event.level !== 'info'"
                        class="capitalize"
                        :class="event.level === 'error' ? 'text-red-500' : 'text-amber-600'"
                        >{{ event.level }}</span
                      >
                    </div>
                    <div class="break-words">{{ event.message }}</div>
                    <details v-if="event.detail" class="mt-1 text-xs text-zinc-500">
                      <summary class="w-fit cursor-pointer py-1 hover:text-violet-500">
                        Event details
                      </summary>
                      <dl
                        class="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1 rounded bg-zinc-50 p-2 dark:bg-zinc-900"
                      >
                        <template v-for="(value, name) in event.detail" :key="name"
                          ><dt class="break-words">{{ name }}</dt>
                          <dd class="break-all font-mono text-zinc-700 dark:text-zinc-300">
                            {{ value }}
                          </dd></template
                        >
                      </dl>
                    </details>
                  </div>
                </li>
              </ol>
              <button
                v-if="filtered.length > limit"
                class="btn-ghost btn-xs mt-4 w-full justify-center"
                @click="limit += 100"
              >
                Show 100 more events
              </button>
              <p v-if="job.droppedEvents" class="mt-3 text-xs text-zinc-500">
                {{ job.droppedEvents }} earlier events were discarded. The latest 1,000 are retained
                per job.
              </p>
            </TabsContent>
            <TabsContent value="details" class="min-h-0 flex-1 overflow-y-auto p-5 text-sm">
              <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3">
                <dt class="text-zinc-500">Queued</dt>
                <dd>{{ stamp(job.queuedAt) }}</dd>
                <dt class="text-zinc-500">Started</dt>
                <dd>{{ stamp(job.startedAt) }}</dd>
                <dt class="text-zinc-500">Finished</dt>
                <dd>{{ stamp(job.finishedAt) }}</dd>
                <template v-if="job.exportRun"
                  ><dt class="text-zinc-500">Output</dt>
                  <dd class="break-words">
                    {{ job.exportRun.settings.format.toUpperCase() }} ·
                    {{ job.exportRun.files }} file{{ job.exportRun.files === 1 ? "" : "s" }} ·
                    {{ job.exportRun.settings.bitrate }} kbps
                  </dd>
                  <dt class="text-zinc-500">Writing</dt>
                  <dd class="break-all font-mono text-xs">{{ job.exportRun.fileName }}</dd>
                  <dt class="text-zinc-500">Chapters</dt>
                  <dd>
                    {{ job.exportRun.done }}/{{ job.exportRun.chapterIds.length }} ·
                    {{ job.exportRun.encode }} encoded, {{ job.exportRun.reuse }} carried over
                  </dd>
                  <dt class="text-zinc-500">Loudness</dt>
                  <dd>
                    {{
                      job.exportRun.settings.normalize
                        ? `matched to ${job.exportRun.settings.loudness} LUFS (simulated)`
                        : "left as rendered"
                    }}
                  </dd>
                  <dt class="text-zinc-500">Updates</dt>
                  <dd>
                    {{
                      job.exportRun.updates === null
                        ? "a new audiobook"
                        : "an existing audiobook — the version on disk is kept until this one lands"
                    }}
                  </dd></template
                >
                <template v-if="job.scriptRun"
                  ><dt class="text-zinc-500">Endpoint</dt>
                  <dd class="break-words">{{ job.scriptRun.profile.name }}</dd>
                  <dt class="text-zinc-500">Model</dt>
                  <dd class="break-all">{{ job.scriptRun.profile.model }}</dd>
                  <dt class="text-zinc-500">Requests</dt>
                  <dd>
                    {{ job.scriptRun.completed }}/{{ job.scriptRun.requests }} completed ·
                    {{ job.scriptRun.active }} active
                  </dd>
                  <dt class="text-zinc-500">Input / output</dt>
                  <dd>
                    {{ job.scriptRun.inputTokens.toLocaleString() }} /
                    {{ job.scriptRun.outputTokens.toLocaleString() }} tokens
                    <span class="text-xs text-zinc-500"
                      >— input is the total, cached tokens included</span
                    >
                  </dd>
                  <dt class="text-zinc-500">Cached input</dt>
                  <dd>
                    <template v-if="job.scriptRun.inputTokens">
                      {{ (job.scriptRun.cachedInput ?? 0).toLocaleString() }} tokens ({{
                        Math.round(
                          ((job.scriptRun.cachedInput ?? 0) / job.scriptRun.inputTokens) * 100,
                        )
                      }}% of the input), charged at the cached rate
                    </template>
                    <template v-else>not reported yet</template>
                    <span
                      v-if="job.scriptRun.cacheUnreported"
                      class="block text-xs text-amber-600 dark:text-amber-400"
                      >{{ job.scriptRun.cacheUnreported }} of {{ job.scriptRun.requests }} requests
                      reported no cache detail. Their cost is an upper bound, not a reported
                      miss.</span
                    >
                  </dd>
                  <dt class="text-zinc-500">Estimated</dt>
                  <dd>
                    <template v-if="job.scriptRun.estimated != null"
                      >${{ job.scriptRun.estimated.toFixed(6) }}
                      <span class="text-xs text-zinc-500"
                        >— conservative: no cache savings, at the rates when this run was
                        planned</span
                      ></template
                    >
                    <template v-else>not recorded</template>
                  </dd>
                  <dt class="text-zinc-500">Charged</dt>
                  <dd>
                    ${{ job.scriptRun.cost.toFixed(6) }}
                    <span
                      v-if="job.scriptRun.estimated != null && job.scriptRun.completed"
                      class="text-xs text-zinc-500"
                      >— {{ job.scriptRun.cost <= job.scriptRun.estimated ? "under" : "over" }} the
                      estimate by ${{
                        Math.abs(job.scriptRun.cost - job.scriptRun.estimated).toFixed(6)
                      }}</span
                    >
                  </dd>
                  <dt class="text-zinc-500">Reserved</dt>
                  <dd>
                    ${{ job.scriptRun.reserved.toFixed(6) }}
                    <span class="text-xs text-zinc-500"
                      >— at undiscounted rates, so a promotion ending mid-run can’t overshoot a
                      cap</span
                    >
                  </dd>
                  <dt class="text-zinc-500">Pricing</dt>
                  <dd>
                    Each request is priced when it completes, from the rates in force at that
                    moment. A run that crosses an off-peak boundary or a promotion expiry charges
                    its requests differently either side of it, and the activity log records the
                    rates each one used.
                  </dd></template
                >
                <!-- narration: the same three figures, plus the input/audio split where anything
                     in this chapter bills on the audio it returns -->
                <template v-if="job.narrationRun"
                  ><dt class="text-zinc-500">Clips queued</dt>
                  <dd>{{ job.narrationRun.clips }}</dd>
                  <dt class="text-zinc-500">Estimated</dt>
                  <dd>
                    <template v-if="job.narrationRun.estimated != null"
                      >${{ job.narrationRun.estimated.toFixed(6) }}
                      <span
                        v-if="job.narrationRun.estimatedAudio != null"
                        class="block text-xs text-zinc-500"
                        >input text ${{ (job.narrationRun.estimatedInput ?? 0).toFixed(6) }} +
                        output audio ${{ job.narrationRun.estimatedAudio.toFixed(6) }}. The audio
                        half rests on this app’s reading-speed estimate and the endpoint’s
                        audio-token setting, so it is the half most likely to move.</span
                      ></template
                    >
                    <template v-else>not recorded</template>
                  </dd>
                  <dt class="text-zinc-500">Reserved</dt>
                  <dd>
                    ${{ job.narrationRun.reserved.toFixed(6) }}
                    <span class="text-xs text-zinc-500"
                      >— at undiscounted rates, so a promotion ending mid-run can’t overshoot a
                      cap</span
                    >
                  </dd>
                  <dt class="text-zinc-500">Pricing</dt>
                  <dd>
                    Every clip is priced when it <b>lands</b>, in whatever unit its endpoint bills
                    in — characters, UTF-8 bytes, text and audio tokens, audio minutes or requests.
                    A request that failed is still charged for what it sent by a provider that bills
                    on the text, so the reconciliation below counts billable attempts rather than
                    finished clips. Silence stitched between clips is not rendered and is never
                    billed.
                  </dd></template
                >
              </dl>
              <p class="mt-5 text-xs leading-relaxed text-zinc-500">
                Event details describe this run at the time they were recorded. Endpoint settings
                and chapter contents may have changed since then. Removing this job or refreshing
                the prototype also removes its log.
              </p>
            </TabsContent>
          </TabsRoot>
          <footer class="shrink-0 border-t border-zinc-200 p-4 dark:border-zinc-800">
            <div class="flex flex-wrap gap-2">
              <button class="btn-ghost btn-xs" @click="copy">
                <CopyIcon class="icon-sm" /> Copy diagnostics</button
              ><RouterLink :to="stage" class="btn-ghost btn-xs" @click="emit('close')"
                >Open {{ job.kind
                }}<template v-if="job.chapterId !== null"> · chapter {{ job.chapterId }}</template
                ><OpenIcon class="icon-sm" /></RouterLink
              ><button
                v-if="!job.finishedAt"
                class="btn-ghost btn-xs ml-auto text-red-500"
                :disabled="job.cancelled"
                @click="jobsStore.cancelJob(job.id)"
              >
                {{ job.cancelled ? "Cancelling…" : "Cancel job" }}
              </button>
            </div>
            <p role="status" class="mt-1 text-xs text-zinc-500">{{ copyStatus }}</p>
          </footer>
        </template>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
