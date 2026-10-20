<script setup lang="ts">
import { useExportsStore } from "@/stores/exports";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

// The audiobooks this book has produced. Each records its chapters' state when built, so "needs an
// update" compares against the book as it stands, not a timestamp. While a build runs, nothing
// offers a second one: both would claim the same version number.
import { computed, ref } from "vue";

import { usePlayer } from "@/composables/usePlayer";
import { formatOf } from "@/lib/exports";
import { exportFileUrl } from "@/services/jobs";
import { numberSpan } from "@/lib/chapterNumber";
import { plural } from "@/lib/contents";
import { diskPath, hms, mb } from "@/views/export/shared";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Download as DownloadIcon,
  FileAudio as FileIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  RotateCcw as RetryIcon,
  TriangleAlert as WarnIcon,
  X as CloseIcon,
} from "@lucide/vue";
import type { ExportItem, ExportUpdate } from "@/types";
import type { Queue } from "@/composables/usePlayer";

const props = defineProps<{ bookId: string }>();
const exportsStore = useExportsStore();
const jobsStore = useJobsStore();
const uiStore = useUiStore();
const libraryStore = useLibraryStore();
/** "ch 3–17": the reading numbers an export's chapters span today; null once all are skipped. */
const builtFrom = (ids: number[]) => numberSpan(ids, libraryStore.chapterNumbers[props.bookId]);
const { p: player, playQueue } = usePlayer();

const items = computed(() =>
  exportsStore
    .exportsOf(props.bookId)
    .slice()
    .sort((a, b) => (b.status === "building" ? 1 : 0) - (a.status === "building" ? 1 : 0)),
);
/** Delete asks for a second click: nothing puts an audiobook back. */
const confirming = ref<number | null>(null);
const deleteTitle = "Delete this audiobook. This cannot be undone.";
function remove(id: number) {
  if (confirming.value !== id) {
    confirming.value = id;
    return;
  }
  confirming.value = null;
  void exportsStore.deleteExport(id);
}
const expanded = ref(new Set<number>());
function toggle(id: number) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}
const rows = computed(() =>
  items.value.map((e) => ({
    e,
    u: exportsStore.exportUpdateFor(e),
    past: exportsStore.exportVersionsOf(e),
    job: jobsStore.jobs.find((j) => j.id === e.jobId),
    busy: items.value.some((x) => x.key === e.key && x.status === "building"),
  })),
);

/**
 * Plays the export as built, from its recorded timeline, not the book as it stands now. No gap
 * across a file boundary. An entry without a timeline plays one clip per file.
 */
function listen(e: ExportItem) {
  const built = new Map((e.timeline ?? []).map((t) => [t.id, t]));
  const clips: Queue["clips"] = [];
  for (const f of e.files) {
    const ids = f.chapterIds.filter((cid) => built.has(cid));
    if (!ids.length) {
      if (f.duration > 0)
        clips.push({ id: `e${e.id}-${f.name}`, duration: f.duration, gap: 0, label: f.name });
      continue;
    }
    ids.forEach((cid, i) => {
      const t = built.get(cid)!;
      clips.push({
        id: `e${e.id}-${cid}`,
        duration: t.duration,
        gap: i === ids.length - 1 ? 0 : e.chapterGap,
        label: t.title,
      });
    });
  }
  if (!clips.length) {
    uiStore.toast("Nothing to play", {
      kind: "warn",
      description: "This export kept no timeline, so there is nothing to run the playhead along.",
    });
    return;
  }
  playQueue({
    id: `export:${e.id}`,
    title: e.filename,
    subtitle: `v${e.version} · ${plural(e.chapters, "chapter")} · as built ${e.createdAt} · timed, not heard`,
    href: `/book/${props.bookId}/export`,
    clips,
  });
}
function copyPath(path: string) {
  navigator.clipboard?.writeText(path);
  uiStore.toast("Path copied", { kind: "success", timeout: 2500 });
}
/** One download per file (the server serves one at a time), each saved under its name on disk. */
function download(e: ExportItem) {
  for (let i = 0; i < e.files.length; i++) {
    const a = document.createElement("a");
    a.href = exportFileUrl(props.bookId, e.id, i);
    document.body.append(a);
    a.click();
    a.remove();
  }
  if (e.files.length > 1)
    uiStore.toast(`Downloading ${plural(e.files.length, "file")}`, {
      kind: "info",
      description: `${e.filename} is ${e.files.length} files, so your browser is saving each of them.`,
      timeout: 5000,
    });
}
const summary = (u: ExportUpdate) => {
  const parts = [];
  if (u.added.length) parts.push(`${plural(u.added.length, "chapter")} narrated since`);
  if (u.changed.length) parts.push(`${u.changed.length} changed`);
  if (u.missing.length)
    parts.push(`${u.missing.length} no longer ${u.missing.length === 1 ? "has" : "have"} audio`);
  if (u.settings.length) parts.push(`settings changed: ${u.settings.join(", ").toLowerCase()}`);
  return parts.join(" · ");
};
</script>

<template>
  <div class="space-y-3">
    <p v-if="!items.length" class="card p-6 text-center text-sm text-zinc-500">
      No audiobooks built from this book yet. Build one and it will be listed here, with everything
      it took to make it.
    </p>

    <article
      v-for="{ e, u, past, job, busy } in rows"
      :key="e.id"
      class="card overflow-hidden"
      :class="e.status === 'failed' && 'border-red-300 dark:border-red-500/40'"
    >
      <div class="p-4">
        <div class="flex flex-wrap items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="min-w-0 break-all font-mono text-sm font-medium">{{ e.filename }}</h3>
              <span
                class="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 dark:bg-zinc-800"
                >v{{ e.version }}</span
              >
              <span
                v-if="e.status === 'building'"
                class="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-300"
                >building</span
              >
              <span
                v-else-if="e.status === 'failed'"
                class="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400"
                >failed</span
              >
            </div>
            <p class="mt-1 text-xs text-zinc-500">
              {{ formatOf(e.format).label }} · {{ plural(e.files.length, "file") }} ·
              {{ plural(e.chapters, "chapter") }} · {{ hms(e.duration) }} ·
              {{ e.bitrate }} kbps<span v-if="e.status !== 'building'"> · {{ mb(e.size) }}</span> ·
              {{ e.createdAt }}
            </p>
          </div>
        </div>

        <!-- building -->
        <template v-if="e.status === 'building'">
          <div class="mt-3 h-1.5 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
            <div
              class="h-1.5 rounded bg-violet-500 transition-all"
              :style="{ width: (e.progress ?? 0) + '%' }"
            ></div>
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span class="font-mono">{{ Math.round(e.progress ?? 0) }}%</span>
            <span v-if="job?.exportRun"
              >{{ job.exportRun.stage }} {{ job.exportRun.done }} of {{ e.chapters }} · file
              {{ job.exportRun.file }} of {{ job.exportRun.files }}</span
            >
            <RouterLink to="/queue" class="underline">Activity</RouterLink>
            <button
              v-if="job"
              class="ml-auto text-red-500 hover:underline"
              :disabled="job.cancelled"
              @click="jobsStore.cancelJob(job!.id)"
            >
              {{ job.cancelled ? "Cancelling…" : "Cancel" }}
            </button>
          </div>
        </template>

        <!-- failed -->
        <div
          v-else-if="e.status === 'failed'"
          class="mt-3 rounded-lg border-l-2 border-red-400 bg-red-500/10 p-3"
        >
          <div class="flex items-start gap-2">
            <WarnIcon class="icon mt-0.5 shrink-0 text-red-500" />
            <div class="min-w-0 flex-1">
              <p class="text-sm">{{ e.error ?? "The build did not finish." }}</p>
              <p class="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                <template v-if="e.replaces"
                  >Nothing was overwritten: v{{ e.version - 1 }} is untouched and still the
                  audiobook on disk.</template
                >
                <template v-else>No file was written.</template>
                Retrying builds the same chapters with the same settings.
              </p>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <button
                  class="btn-ghost btn-xs"
                  :disabled="busy"
                  @click="exportsStore.retryExport(e.id)"
                >
                  <RetryIcon class="icon-sm" />
                  {{ busy ? "A build is running" : "Retry the build" }}
                </button>
                <RouterLink to="/queue" class="btn-ghost btn-xs">See the activity log</RouterLink>
                <button
                  class="btn-ghost btn-xs text-red-500"
                  :data-tip="deleteTitle"
                  @click="remove(e.id)"
                >
                  {{ confirming === e.id ? "Discard for good?" : "Discard" }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- done -->
        <template v-else>
          <div v-if="u.needed" class="mt-3 rounded-lg bg-violet-50 p-3 dark:bg-violet-500/10">
            <div class="flex flex-wrap items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-violet-700 dark:text-violet-200">
                  This export is behind the book
                </p>
                <p
                  class="mt-0.5 text-xs leading-relaxed text-violet-700/90 dark:text-violet-200/90"
                >
                  {{ summary(u) }}.
                </p>
                <p v-if="u.stale.length" class="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  <WarnIcon class="icon-sm" /> {{ plural(u.stale.length, "chapter") }} in it now
                  read an older script. Updating takes you to Build to say whether to use those
                  clips as they are — it is not decided for you.
                </p>
              </div>
              <button
                class="btn-primary btn-xs shrink-0 whitespace-nowrap"
                :disabled="busy"
                @click="exportsStore.updateExport(e.id, u.added)"
              >
                {{ busy ? "Building…" : `Update to v${e.version + 1}` }}
              </button>
            </div>
          </div>
          <p v-else class="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
            Up to date with every chapter it contains.
          </p>

          <!-- narrated chapters this export never contained: not missing from it -->
          <div
            v-if="u.outside.length"
            class="mt-2 flex flex-wrap items-start gap-2 rounded-lg border border-dashed border-zinc-300 p-2.5 dark:border-zinc-700"
          >
            <p class="min-w-0 flex-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
              {{ plural(u.outside.length, "other chapter") }} of this book
              {{ u.outside.length === 1 ? "is" : "are" }} narrated and not in this audiobook — it
              was built from the chapters you chose, so
              {{ u.outside.length === 1 ? "it is" : "they are" }} not missing from it.
            </p>
            <button
              class="btn-ghost btn-xs shrink-0 whitespace-nowrap"
              :disabled="busy"
              @click="exportsStore.updateExport(e.id, u.outside)"
            >
              Add {{ u.outside.length === 1 ? "it" : "them" }}
            </button>
          </div>

          <div
            v-if="diskPath(e)"
            class="mt-3 flex items-center gap-1 rounded bg-zinc-50 px-2 py-1 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800/60"
          >
            <span class="min-w-0 flex-1 truncate" :data-tip="diskPath(e)!">{{ diskPath(e) }}</span
            ><button
              class="shrink-0 text-violet-500 hover:underline"
              @click="copyPath(diskPath(e)!)"
            >
              copy
            </button>
          </div>

          <div class="mt-2 flex flex-wrap items-center gap-1">
            <button
              class="btn-ghost btn-xs"
              data-tip="Run the playhead along this version's own timeline — the chapters and the gaps as they were when it was built, not as the book stands now. No audio is rendered in this prototype, so it runs silent."
              @click="listen(e)"
            >
              <component
                :is="player.id === `export:${e.id}` && player.playing ? PauseIcon : PlayIcon"
                class="icon-sm icon-fill"
              />
              {{ player.id === `export:${e.id}` && player.playing ? "Pause" : "Listen as built" }}
            </button>
            <button class="btn-ghost btn-xs" @click="toggle(e.id)">
              <component
                :is="expanded.has(e.id) ? ChevronDownIcon : ChevronRightIcon"
                class="icon-sm"
              />
              {{ e.files.length === 1 ? "What is in it" : `${e.files.length} files` }}
            </button>
            <button class="btn-ghost btn-xs" @click="download(e)">
              <DownloadIcon class="icon-sm" /> Download
            </button>
            <button v-if="past.length" class="btn-ghost btn-xs" @click="toggle(-e.id)">
              {{ past.length }} older
            </button>
            <button
              class="btn-ghost btn-xs ml-auto text-red-500"
              :aria-label="`Delete ${e.filename}`"
              :data-tip="deleteTitle"
              @click="remove(e.id)"
            >
              <span v-if="confirming === e.id" class="text-xs">Delete for good?</span>
              <CloseIcon v-else class="icon-sm" />
            </button>
          </div>

          <div
            v-if="player.id === `export:${e.id}`"
            class="mt-2 h-1 rounded bg-zinc-200 dark:bg-zinc-800"
          >
            <div
              class="h-1 rounded bg-violet-500"
              :style="{ width: (player.len ? (player.pos / player.len) * 100 : 0) + '%' }"
            ></div>
          </div>

          <!-- contents -->
          <ul
            v-if="expanded.has(e.id)"
            class="mt-2 space-y-1 border-t border-dashed border-zinc-200 pt-2 dark:border-zinc-800"
          >
            <li v-for="f in e.files" :key="f.name" class="flex items-center gap-2 text-xs">
              <FileIcon class="icon-sm shrink-0 text-zinc-400" />
              <span class="min-w-0 flex-1 truncate font-mono" :data-tip="f.name">{{ f.name }}</span>
              <span class="shrink-0 font-mono text-[11px] text-zinc-400"
                >{{ f.chapterIds.length }} ch · {{ hms(f.duration) }} · {{ mb(f.size) }}</span
              >
            </li>
            <li class="pt-1 text-[11px] leading-relaxed text-zinc-500">
              <template v-if="builtFrom(e.chapterIds)"
                >Built from {{ builtFrom(e.chapterIds) }} ·
              </template>
              {{ e.markers ? plural(e.markers, "chapter mark") : "no chapter marks" }} ·
              {{ e.normalize ? `levels matched to ${e.loudness} LUFS` : "levels left as rendered"
              }}<span v-if="e.stale"> · {{ e.stale }} chapters used stale audio</span>
            </li>
          </ul>

          <!-- earlier versions -->
          <ul
            v-if="expanded.has(-e.id)"
            class="mt-2 space-y-1 border-t border-dashed border-zinc-200 pt-2 dark:border-zinc-800"
          >
            <li
              v-for="o in past"
              :key="o.id"
              class="flex items-center gap-2 text-[11px] text-zinc-400"
            >
              <span class="rounded bg-zinc-100 px-1 dark:bg-zinc-800">v{{ o.version }}</span>
              <span class="min-w-0 flex-1 truncate"
                >{{ o.chapters }} ch · {{ mb(o.size) }} · {{ o.createdAt }}</span
              >
              <span>{{ o.status }}</span>
              <button
                class="hover:text-red-500"
                :aria-label="deleteTitle"
                :data-tip="deleteTitle"
                @click="remove(o.id)"
              >
                <span v-if="confirming === o.id" class="text-xs">Delete for good?</span>
                <CloseIcon v-else class="icon-sm" />
              </button>
            </li>
          </ul>
        </template>
      </div>
    </article>
  </div>
</template>
