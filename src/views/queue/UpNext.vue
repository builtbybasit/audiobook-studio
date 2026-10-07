<script setup lang="ts">
// Up next: the waiting jobs in the order they will run, a bulk run's jobs folded into one row that
// opens to list them. "Run next" moves a row ahead of everything else waiting.
import { computed, ref } from "vue";
import type { Component } from "vue";
import {
  ArrowUpToLine as RunNextIcon,
  AudioLines as NarrationIcon,
  ChevronRight as ChevronIcon,
  Download as ExportIcon,
  PencilLine as ScriptingIcon,
  Ear as CheckIcon,
  X as CancelIcon,
} from "@lucide/vue";

import { numberSpan } from "@/lib/chapterNumber";
import { plural } from "@/lib/contents";
import { upNextGroups } from "@/lib/queue";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import type { Job, JobKind } from "@/types";

const props = defineProps<{ queued: Job[] }>();
const emit = defineEmits<{ open: [id: number] }>();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();

const icon: Record<JobKind, Component> = {
  scripting: ScriptingIcon,
  narration: NarrationIcon,
  export: ExportIcon,
  check: CheckIcon,
};
// Where a job's chapter sits, named by book and volume, and by its reading number only: the titles
// of chapters still to come would give the plot away.
const bookTitle = (j: Job) => libraryStore.bookById(j.bookId)?.title;
const volumeOf = (j: Job) =>
  j.chapterId == null ? undefined : libraryStore.volumeOf(j.bookId, j.chapterId)?.name;
const where = (j: Job) => [bookTitle(j), volumeOf(j)].filter(Boolean).join(" · ");
// A run's head line: its book, its volume once when the chapters share one, and the reading
// numbers it spans, "ch 14–16".
const span = (jobs: Job[]) => {
  const vols = new Set(jobs.map(volumeOf));
  const ids = jobs.flatMap((j) => (j.chapterId == null ? [] : [j.chapterId]));
  return [
    bookTitle(jobs[0]),
    vols.size === 1 ? [...vols][0] : "",
    numberSpan(ids, libraryStore.chapterNumbers[jobs[0].bookId]),
  ]
    .filter(Boolean)
    .join(" · ");
};

// The runs opened, by bulk id: a run split by "Run next" opens and closes as one.
const expanded = ref(new Set<number>());
function toggle(run: number) {
  if (!expanded.value.delete(run)) expanded.value.add(run);
}

// One line per row on screen: a lone job, a run's head (`run` set), or a job of an opened run.
interface Row {
  key: string;
  position: number;
  jobs: Job[];
  run?: number;
  nested?: boolean;
}
const rows = computed(() =>
  upNextGroups(props.queued).flatMap((g): Row[] => {
    const [first] = g.jobs;
    if (g.jobs.length === 1) return [{ key: `j${first.id}`, position: g.position, jobs: g.jobs }];
    const run = first.bulk!.id;
    const head: Row = { key: `g${first.id}`, position: g.position, jobs: g.jobs, run };
    if (!expanded.value.has(run)) return [head];
    return [
      head,
      ...g.jobs.map((j, k) => ({
        key: `j${j.id}`,
        position: g.position + k,
        jobs: [j],
        nested: true,
      })),
    ];
  }),
);
function onRow(event: MouseEvent, row: Row) {
  if ((event.target as HTMLElement).closest("button")) return;
  if (row.run != null) toggle(row.run);
  else emit("open", row.jobs[0].id);
}
const name = (row: Row) =>
  (row.run != null ? row.jobs[0].bulk!.op : "") || jobsStore.labelOf(row.jobs[0]);
</script>

<template>
  <section class="card overflow-hidden">
    <div class="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
      <span class="label">Up next</span
      ><span class="text-xs text-zinc-400">{{ queued.length }}</span>
      <button
        v-if="queued.length"
        class="ml-auto whitespace-nowrap text-xs text-zinc-400 hover:text-red-500"
        @click="jobsStore.cancelJobs(queued.map((j) => j.id))"
      >
        cancel queued
      </button>
    </div>
    <div v-if="!queued.length" class="px-4 py-4 text-sm text-zinc-500">Nothing waiting.</div>
    <div class="max-h-80 overflow-y-auto">
      <div
        v-for="r in rows"
        :key="r.key"
        class="group flex cursor-pointer items-center gap-3 border-b border-zinc-100 px-4 py-2 text-sm last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-900"
        @click="onRow($event, r)"
      >
        <span class="w-5 shrink-0 font-mono text-xs text-zinc-400">{{
          r.run != null && expanded.has(r.run) ? "" : r.position
        }}</span>
        <component
          :is="icon[r.jobs[0].kind]"
          class="icon-sm shrink-0 text-zinc-400"
          :class="r.nested && 'ml-5'"
        />
        <button
          v-if="r.run != null"
          class="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-violet-500"
          :aria-expanded="expanded.has(r.run)"
          @click="toggle(r.run)"
        >
          <ChevronIcon
            class="icon-sm shrink-0 text-zinc-400 transition-transform"
            :class="expanded.has(r.run) && 'rotate-90'"
          />
          <span class="min-w-0">
            <span class="block truncate"
              >{{ name(r) }}
              <span class="text-xs text-zinc-400"
                >· {{ plural(r.jobs.length, "chapter") }} waiting</span
              ></span
            >
            <span class="block truncate text-xs text-zinc-500">{{ span(r.jobs) }}</span>
          </span>
        </button>
        <button
          v-else
          class="min-w-0 flex-1 truncate text-left hover:text-violet-500 hover:underline"
          :aria-label="`View activity for ${jobsStore.labelOf(r.jobs[0])}`"
          @click="emit('open', r.jobs[0].id)"
        >
          <span class="block truncate"
            >{{ jobsStore.labelOf(r.jobs[0]) }}
            <span v-if="r.jobs[0].bulk" class="ml-1 text-[10px] text-zinc-400"
              >{{ r.jobs[0].bulk.index }}/{{ r.jobs[0].bulk.total }}</span
            ></span
          ><span class="block truncate text-xs text-zinc-500">{{
            r.nested ? volumeOf(r.jobs[0]) : where(r.jobs[0])
          }}</span>
        </button>
        <div
          class="flex shrink-0 gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <button
            class="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-violet-500 dark:hover:bg-zinc-800"
            :class="r.position === 1 && 'invisible'"
            :aria-label="`Run ${name(r)} next`"
            title="Run next"
            @click="jobsStore.runNext(r.jobs.map((j) => j.id))"
          >
            <RunNextIcon class="icon-sm" />
          </button>
          <button
            class="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-red-500 dark:hover:bg-zinc-800"
            :aria-label="
              r.run != null ? `Cancel ${r.jobs.length} jobs of ${name(r)}` : `Cancel ${name(r)}`
            "
            title="Cancel"
            @click="jobsStore.cancelJobs(r.jobs.map((j) => j.id))"
          >
            <CancelIcon class="icon-sm" />
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
