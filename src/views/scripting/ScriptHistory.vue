<script setup lang="ts">
// The chapter's script history, in the reader where the script is.
//
// Three states, and which one you are in is said at the top of the panel every time: the **list**
// of versions with the current script at the head of it, a read-only **preview** of one version,
// and a **comparison** of one against the current script. Nothing here changes the script except
// Restore, which shows what it would do — in lines and in clips — before it is pressed, and can be
// taken back from its toast afterwards.
import { useHistoryStore } from "@/stores/history";
import { useJobsStore } from "@/stores/jobs";
import { useScriptsStore } from "@/stores/scripts";

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { relative } from "@/lib/endpoints";
import { originKindLabel, originLabel, originNote, restoreConsequences } from "@/lib/scriptHistory";
import { useReader } from "@/stores/reader";
import ExpressionText from "@/components/ExpressionText.vue";
import ScriptHistoryDiff from "@/views/scripting/ScriptHistoryDiff.vue";
import { useScript } from "@/views/scripting/shared";
import { useChapterHistory } from "@/queries";
import { secs } from "@/lib/speech";
import {
  ArrowLeft as BackIcon,
  BookmarkPlus as CheckpointIcon,
  Eye as PreviewIcon,
  GitCompare as CompareIcon,
  History as HistoryIcon,
  Pause as PauseIcon,
  TriangleAlert as WarnIcon,
  Undo2 as RestoreIcon,
  Users as CastIcon,
} from "@lucide/vue";
import type { ScriptVersion } from "@/types";

const props = defineProps<{ bookId: string; chapterId: number }>();
const emit = defineEmits<{ close: []; jump: [segId: number] }>();
const historyStore = useHistoryStore();
const jobsStore = useJobsStore();
const scriptsStore = useScriptsStore();
const reader = useReader();
const { colorOf } = useScript(props);

const body = ref<HTMLElement | null>(null);
const mode = ref<"list" | "preview" | "compare">("list");
const selectedId = ref<number | null>(null);
/** the version whose restore plan is open under it */
const planFor = ref<number | null>(null);
const checkpoint = ref("");
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval>;
onMounted(() => (clock = setInterval(() => (now.value = Date.now()), 15000)));
onUnmounted(() => clearInterval(clock));

// the chapter's history: read from the server when the panel opens, or the store's own
const { versions, head } = useChapterHistory(
  () => props.bookId,
  () => props.chapterId,
);
const current = computed(() => scriptsStore.segmentsOf(props.bookId, props.chapterId));
const selected = computed(() => versions.value.find((v) => v.id === selectedId.value) ?? null);
const comparison = computed(() =>
  selected.value
    ? historyStore.comparisonOf(props.bookId, props.chapterId, selected.value.id)
    : null,
);
const plan = computed(() =>
  planFor.value == null
    ? null
    : historyStore.restorePlanOf(props.bookId, props.chapterId, planFor.value),
);
const busy = computed(() => historyStore.busyJobs(props.bookId, props.chapterId));
const consequences = computed(() => (plan.value ? restoreConsequences(plan.value) : []));

/** How many lines this version differs from the current script by — the list's own summary. */
function differences(v: ScriptVersion): number | null {
  const c = historyStore.comparisonOf(props.bookId, props.chapterId, v.id);
  return c ? c.lines : null;
}
const when = (at: number): string =>
  at
    ? `${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${relative(at, now.value)}`
    : "before this session";

function preview(v: ScriptVersion) {
  selectedId.value = v.id;
  mode.value = "preview";
}
function compare(v: ScriptVersion) {
  selectedId.value = v.id;
  mode.value = "compare";
}
/** Open (or close) the plan under one version, which is where restoring is decided. */
function askRestore(v: ScriptVersion) {
  selectedId.value = v.id;
  planFor.value = planFor.value === v.id && mode.value === "list" ? null : v.id;
  mode.value = "list";
}
/** Cancelling a run cannot be undone, so it is asked for first — the rule the app holds to. */
const confirmCancel = ref(false);
function cancelRun() {
  const job = busy.value[0];
  if (!job) return;
  jobsStore.cancelJob(job.id);
  confirmCancel.value = false;
}
watch([() => planFor.value, () => busy.value.length], () => (confirmCancel.value = false));
function doRestore() {
  const id = planFor.value;
  if (id == null) return;
  if (historyStore.restore(props.bookId, props.chapterId, id)) {
    planFor.value = null;
    emit("close"); // the point of restoring is to be looking at the restored script
  }
}
async function save() {
  if (await historyStore.saveCheckpoint(props.bookId, props.chapterId, checkpoint.value))
    checkpoint.value = "";
}
function jump(segId: number) {
  emit("jump", segId);
}
/** One step back out of preview or compare; false when there is nowhere left to go. */
function back(): boolean {
  if (mode.value !== "list") {
    mode.value = "list";
    return true;
  }
  if (planFor.value != null) {
    planFor.value = null;
    return true;
  }
  return false;
}
defineExpose({ back });
// a preview or a comparison starts at its own beginning, not at the list's scroll position
watch([mode, selectedId], () => void nextTick(() => body.value?.scrollTo({ top: 0 })));
// a chapter change while the panel is open: nothing selected there is still selected here
watch(
  () => props.chapterId,
  () => {
    mode.value = "list";
    selectedId.value = null;
    planFor.value = null;
  },
);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- which of the three you are looking at, said the same way every time -->
    <div
      class="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs sm:px-6"
      :class="
        mode === 'list'
          ? 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/40'
          : 'border-amber-300 bg-amber-400/10 text-amber-800 dark:border-amber-500/40 dark:text-amber-200'
      "
    >
      <component
        :is="mode === 'list' ? HistoryIcon : mode === 'preview' ? PreviewIcon : CompareIcon"
        class="icon shrink-0"
      />
      <span v-if="mode === 'list'" class="min-w-0 flex-1">
        <b>Script history</b> · chapter {{ chapterId }} · {{ versions.length }} saved version{{
          versions.length === 1 ? "" : "s"
        }}. The current script is untouched while you are in here.
      </span>
      <span v-else-if="mode === 'preview'" class="min-w-0 flex-1">
        <b>Previewing v{{ selected?.id }}</b> — {{ originLabel(selected!.origin) }}, read-only. This
        is <b>not</b> the current script, and nothing you do here changes it.
      </span>
      <span v-else class="min-w-0 flex-1">
        <b>Comparing v{{ selected?.id }} with the current script</b> — what has changed since that
        version.
      </span>
      <div class="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
        <template v-if="mode !== 'list'">
          <button class="btn-ghost btn-xs" @click="mode = 'list'">
            <BackIcon class="icon-sm" /> All versions
          </button>
          <button v-if="mode === 'preview'" class="btn-ghost btn-xs" @click="compare(selected!)">
            <CompareIcon class="icon-sm" /> Compare with current
          </button>
          <button v-else class="btn-ghost btn-xs" @click="preview(selected!)">
            <PreviewIcon class="icon-sm" /> Preview it
          </button>
          <button class="btn-ghost btn-xs" @click="askRestore(selected!)">
            <RestoreIcon class="icon-sm" /> Restore…
          </button>
        </template>
        <button class="btn-ghost btn-xs" @click="emit('close')">
          <BackIcon class="icon-sm" /> Back to the script
        </button>
      </div>
    </div>

    <div ref="body" class="min-h-0 flex-1 overflow-auto px-4 py-4 sm:px-6">
      <!-- ---------- the list ---------- -->
      <div v-if="mode === 'list'" class="mx-auto max-w-3xl space-y-4">
        <!-- what you are working on now -->
        <div class="rounded-lg border-2 border-violet-400 p-3 dark:border-violet-500/60">
          <div class="flex flex-wrap items-baseline gap-2">
            <span
              class="rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white"
              >You are here</span
            >
            <span class="text-sm font-semibold">The current script</span>
            <span class="text-xs text-zinc-500">{{ current.length }} lines</span>
          </div>
          <div class="mt-1 text-xs">
            <b>{{ originLabel(head.origin) }}</b>
            <span class="text-zinc-500">
              · {{ originNote(head.origin) }} · {{ when(head.at) }}</span
            >
            <span
              v-if="head.open"
              class="ml-1.5 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300"
              >editing now — more edits join this one</span
            >
          </div>
          <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
            Edits less than ten seconds apart are kept as one entry, so an afternoon of corrections
            reads as one line rather than ninety. Re-scripting, a bulk correction and a restore each
            preserve the script they replace, so nothing on this list can be lost by what you do
            next.
          </p>
        </div>

        <!-- name this state -->
        <div class="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div class="label mb-1.5 flex items-center gap-1.5">
            <CheckpointIcon class="icon-sm" /> Save a checkpoint
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="checkpoint"
              class="input min-w-0 flex-1 text-xs"
              placeholder="e.g. Dialogue reviewed, or Before trying DeepSeek"
              maxlength="60"
              @keydown.enter="save"
            />
            <button class="btn-primary btn-xs" :disabled="!checkpoint.trim()" @click="save">
              Save checkpoint
            </button>
          </div>
          <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
            Keeps a copy of the script as it stands under a name you will recognise. The script
            itself is not changed, and the entry says how it got here.
          </p>
        </div>

        <!-- everything before it -->
        <div>
          <div class="label mb-2">Earlier versions · newest first</div>
          <p v-if="!versions.length" class="text-xs leading-relaxed text-zinc-500">
            Nothing has replaced this chapter's script yet, so there is nothing earlier to go back
            to. Save a checkpoint before you try something, or just start editing — the script as it
            stands is preserved the moment you do.
          </p>
          <ul class="space-y-2">
            <li
              v-for="v in versions"
              :key="v.id"
              class="rounded-lg border p-3"
              :class="
                planFor === v.id
                  ? 'border-violet-400 dark:border-violet-500'
                  : 'border-zinc-200 dark:border-zinc-800'
              "
            >
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span class="font-mono text-xs text-zinc-400">v{{ v.id }}</span>
                <span class="text-sm font-semibold">{{ originLabel(v.origin) }}</span>
                <span
                  class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  >{{ originKindLabel(v.origin) }}</span
                >
                <span class="text-xs text-zinc-500">{{ when(v.at) }}</span>
              </div>
              <div class="mt-0.5 text-xs text-zinc-500">
                {{ v.segments.length }} lines · {{ originNote(v.origin) }} ·
                <template v-if="differences(v) === 0"
                  ><b>identical to the current script</b></template
                ><template v-else
                  >{{ differences(v) }} line{{ differences(v) === 1 ? "" : "s" }} differ from the
                  current script</template
                >
              </div>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <button class="btn-ghost btn-xs" @click="preview(v)">
                  <PreviewIcon class="icon-sm" /> Preview
                </button>
                <button class="btn-ghost btn-xs" @click="compare(v)">
                  <CompareIcon class="icon-sm" /> Compare with current
                </button>
                <button
                  class="btn-ghost btn-xs"
                  :aria-expanded="planFor === v.id"
                  @click="askRestore(v)"
                >
                  <RestoreIcon class="icon-sm" /> Restore…
                </button>
              </div>

              <!-- what restoring this one would do, before it is pressed -->
              <div
                v-if="planFor === v.id && plan"
                class="mt-3 rounded-md border border-violet-300 bg-violet-50/60 p-3 text-xs dark:border-violet-500/40 dark:bg-violet-500/5"
              >
                <div class="mb-1.5 font-semibold">
                  Restoring v{{ v.id }} into chapter {{ chapterId }}
                </div>
                <p v-if="plan.comparison.identical" class="text-zinc-600 dark:text-zinc-300">
                  This version is identical to the current script, so there is nothing to restore.
                </p>
                <template v-else>
                  <ul class="space-y-1 text-zinc-700 dark:text-zinc-200">
                    <li v-for="line in consequences" :key="line" class="flex gap-2">
                      <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-violet-500"></span>
                      <span>{{ line }}</span>
                    </li>
                    <li class="flex gap-2">
                      <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-violet-500"></span>
                      <span
                        >the chapter's narration becomes <b>{{ plan.narration }}</b
                        >, and the export plan follows it</span
                      >
                    </li>
                  </ul>
                  <div
                    v-if="plan.missingSpeakers.length"
                    class="mt-2 flex gap-2 rounded border border-amber-300 bg-amber-400/10 p-2 text-amber-800 dark:border-amber-500/40 dark:text-amber-200"
                  >
                    <CastIcon class="icon mt-0.5 shrink-0" />
                    <span>
                      <b>{{ plan.missingSpeakers.map((m) => m.name).join(", ") }}</b>
                      {{ plan.missingSpeakers.length === 1 ? "is a speaker" : "are speakers" }} this
                      book's cast no longer has ({{
                        plan.missingSpeakers
                          .map((m) => `${m.lines} line${m.lines === 1 ? "" : "s"}`)
                          .join(", ")
                      }}). Restoring puts
                      {{ plan.missingSpeakers.length === 1 ? "it" : "them" }} back as unreviewed, so
                      the Cast page can merge or rename
                      {{ plan.missingSpeakers.length === 1 ? "it" : "them" }} again.
                    </span>
                  </div>
                  <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
                    A version holds this chapter's script and nothing else: the cast, the voices,
                    the pronunciation dictionary, the pacing and the endpoint settings stay exactly
                    as the book has them now. Restoring adds one more entry to this list — v{{
                      v.id
                    }}
                    and everything after it stay where they are.
                  </p>
                  <!-- a run in flight would write over what you restore, so it goes first -->
                  <div
                    v-if="busy.length"
                    class="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-400/10 p-2 text-amber-800 dark:border-amber-500/40 dark:text-amber-200"
                  >
                    <WarnIcon class="icon shrink-0" />
                    <span v-if="busy[0].cancelled" class="min-w-0 flex-1"
                      ><b>{{ busy[0].label }}</b> is stopping. The requests already sent are
                      finishing; restoring is ready as soon as the queue settles.</span
                    >
                    <span v-else class="min-w-0 flex-1"
                      ><b>{{ busy[0].label }}</b> is still running. Its result would land on the
                      script you restore, so it has to stop first — cancelling a run cannot be
                      undone.</span
                    >
                    <button
                      v-if="!busy[0].cancelled"
                      class="btn-ghost btn-xs shrink-0 border-amber-400"
                      @click="confirmCancel = !confirmCancel"
                    >
                      Cancel the run
                    </button>
                    <!-- the one step here that Undo cannot take back, so it is asked for -->
                    <div
                      v-if="confirmCancel && !busy[0].cancelled"
                      class="basis-full rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-zinc-200"
                      role="alertdialog"
                    >
                      <p>
                        <WarnIcon class="icon-sm text-red-500" />
                        Stop <b>{{ busy[0].label }}</b
                        >? Requests already sent are allowed to land and stay in the history with
                        their recorded cost. What has not been sent is dropped, and this chapter
                        keeps whatever the run had reached. Nothing already scripted or rendered is
                        deleted — but the run does not come back with Undo.
                      </p>
                      <div class="mt-2 flex gap-2">
                        <button class="btn-ghost btn-xs" @click="confirmCancel = false">
                          Keep running
                        </button>
                        <button
                          class="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
                          @click="cancelRun"
                        >
                          Cancel the run
                        </button>
                      </div>
                    </div>
                  </div>
                  <div class="mt-2 flex flex-wrap items-center gap-2">
                    <button class="btn-primary btn-xs" :disabled="!!busy.length" @click="doRestore">
                      <RestoreIcon class="icon-sm" /> Restore v{{ v.id }}
                    </button>
                    <button class="btn-ghost btn-xs" @click="planFor = null">Cancel</button>
                    <span class="text-[11px] text-zinc-500"
                      >Undo is on the toast afterwards (⌘Z), and puts the clips back too.</span
                    >
                  </div>
                </template>
              </div>
            </li>
          </ul>
        </div>
      </div>

      <!-- ---------- one version, read-only ---------- -->
      <div v-else-if="mode === 'preview' && selected" class="mx-auto" :class="reader.widthClass">
        <div
          class="mb-4 rounded-lg border border-dashed border-amber-400 bg-amber-400/5 px-3 py-2 text-xs"
        >
          <b>v{{ selected.id }}</b> · {{ originLabel(selected.origin) }} ·
          {{ originKindLabel(selected.origin) }} · {{ when(selected.at) }} ·
          {{ selected.segments.length }} lines. Read-only: this is how the chapter read then, with
          the book's cast and voices as they are now.
        </div>
        <div
          :class="reader.fontClass"
          :style="{ fontSize: reader.size + 'px', lineHeight: reader.lineHeight }"
        >
          <template v-for="s in selected.segments" :key="s.id">
            <p v-if="s.type === 'narration'" class="mb-3 text-zinc-700 dark:text-zinc-300">
              <ExpressionText :book-id="bookId" :segment="s" /><span
                v-if="s.direction"
                class="ml-2 font-sans text-[11px] leading-none text-violet-500/80"
                >[{{ s.direction }}]</span
              >
            </p>
            <div
              v-else
              class="mb-3 rounded-lg border-l-[3px] bg-zinc-50 px-4 py-2.5 dark:bg-zinc-800/50"
              :style="{ borderLeftColor: colorOf(s.speaker) }"
            >
              <div class="mb-1 flex flex-wrap items-center gap-2 font-sans text-xs leading-normal">
                <span
                  class="rounded-full px-2 py-0.5 font-medium"
                  :style="{ background: colorOf(s.speaker) + '33', color: colorOf(s.speaker) }"
                >
                  <span class="opacity-70">{{ s.type === "thought" ? "…" : "“" }}</span>
                  {{ s.speaker }}
                </span>
                <span v-if="s.direction" class="truncate italic text-zinc-500"
                  >— {{ s.direction }}</span
                >
              </div>
              <p :class="s.type === 'thought' ? 'italic text-zinc-600 dark:text-zinc-300' : ''">
                <template v-if="s.type === 'dialogue'"
                  >‘<ExpressionText :book-id="bookId" :segment="s" />’</template
                ><template v-else><ExpressionText :book-id="bookId" :segment="s" /></template>
              </p>
            </div>
            <div
              v-if="s.pause != null"
              class="-mt-1 mb-3 flex items-center gap-2 font-sans text-[10px] leading-none text-zinc-400"
            >
              <span class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800"></span>
              <span class="chip"
                ><PauseIcon class="icon-sm icon-fill" />
                {{ s.pause === 0 ? "runs straight on" : secs(s.pause) + " pause" }}</span
              >
              <span class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800"></span>
            </div>
          </template>
        </div>
      </div>

      <!-- ---------- one version against the current script ---------- -->
      <div v-else-if="mode === 'compare' && selected && comparison" class="mx-auto max-w-3xl">
        <ScriptHistoryDiff
          :comparison="comparison"
          :from-label="`v${selected.id} · ${originLabel(selected.origin)}`"
          to-label="the current script"
          jumpable
          @jump="jump"
        />
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <button class="btn-ghost btn-xs" @click="preview(selected)">
            <PreviewIcon class="icon-sm" /> Read v{{ selected.id }} in full
          </button>
          <button class="btn-ghost btn-xs" @click="askRestore(selected)">
            <RestoreIcon class="icon-sm" /> Restore v{{ selected.id }}…
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
