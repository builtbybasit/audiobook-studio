<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useExportsStore } from "@/stores/exports";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";

// What pressing Build would produce, and what stands in the way. The plan is read off one structure
// (`planOf`), so the file count, the names, the order, the running time and the size can never
// disagree with each other or with the selection on the left.
//
// Problems are stated as things to do. Nothing is ever dropped quietly: "leave them out" is one of
// the offered actions and it *removes the chapters from the selection*, so what the list shows and
// what the build contains stay the same set.
import { computed, ref, watch } from "vue";

import { usePlayer } from "@/composables/usePlayer";
import { pauseAfter } from "@/lib/speech";
import { exportKey, formatOf, hash } from "@/lib/exports";
import { hms, mb, plural, secs } from "@/views/export/shared";
import ExportFiles from "@/views/export/ExportFiles.vue";
import {
  Download as BuildIcon,
  FileAudio as FileIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import type { ExportSettings } from "@/types";
import type { Queue } from "@/composables/usePlayer";

const props = defineProps<{ bookId: string; settings: ExportSettings; selected: number[] }>();
const emit = defineEmits<{
  build: [];
  narrate: [number[]];
  drop: [number[]];
  "use-stale": [];
  show: [number[]];
}>();
const castStore = useCastStore();
const exportsStore = useExportsStore();
const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const { p: player, playQueue } = usePlayer();

const plan = computed(() =>
  exportsStore.exportPlanFor(props.bookId, props.selected, props.settings),
);
const review = computed(() =>
  exportsStore.exportReviewFor(props.bookId, props.selected, props.settings),
);
const blocked = computed(() => review.value.blockers.length > 0);
const chapters = computed(() =>
  libraryStore.chaptersOf(props.bookId).filter((c) => props.selected.includes(c.id)),
);
const chapterNames = (ids: number[]) =>
  ids
    .map((id) => libraryStore.chapter(props.bookId, id))
    .filter(Boolean)
    .map((c) => `Ch ${c!.id} · ${c!.title}`);
/** A finished export this build would become the next version of. */
const replaces = computed(() =>
  exportsStore
    .exportsOf(props.bookId)
    .find((e) => e.key === exportKey(props.settings) && e.status === "done"),
);
// the store's own reuse rule, not a second opinion: change the bitrate and the estimate stops
// promising a carry-over the build would not honour
const reuse = computed(
  () => exportsStore.exportReuse(replaces.value, props.selected, props.settings).length,
);
/** A build of this audiobook that is already running. Two would both claim the same version. */
const running = computed(() =>
  exportsStore
    .exportsOf(props.bookId)
    .find((e) => e.key === exportKey(props.settings) && e.status === "building"),
);

/** Review work is separate from render readiness: a playable clip can still be flagged as wrong,
 * and a finished retake can still be waiting beside the clip in the book for a human verdict. */
const audioReview = computed(() => {
  const flagged: { chId: number; segId: number }[] = [];
  const retakes: { chId: number; segId: number }[] = [];
  for (const chId of props.selected)
    for (const segment of scriptsStore.segmentsOf(props.bookId, chId)) {
      if (segment.flag) flagged.push({ chId, segId: segment.id });
      if (segment.candidate) retakes.push({ chId, segId: segment.id });
    }
  return {
    flagged,
    retakes,
    chapterIds: [...new Set([...flagged, ...retakes].map((row) => row.chId))],
    total: flagged.length + retakes.length,
  };
});
const acceptUnreviewed = ref(false);
watch(
  () =>
    `${props.selected.join(",")}|${audioReview.value.flagged.map((x) => `${x.chId}:${x.segId}`).join(",")}|${audioReview.value.retakes.map((x) => `${x.chId}:${x.segId}`).join(",")}`,
  () => (acceptUnreviewed.value = false),
);
const reviewLink = (kind: "flagged" | "review") => {
  const row = kind === "flagged" ? audioReview.value.flagged[0] : audioReview.value.retakes[0];
  return {
    path: `/book/${props.bookId}/narration`,
    query: row ? { ch: row.chId, filter: kind, seg: row.segId } : {},
  };
};

/** Selected chapters that would contribute nothing but the gap around them. */
const silent = computed(() => chapters.value.filter((c) => c.duration <= 0).length);

const files = ref(false);
/**
 * One id per *timeline*, not one per page. Preview volume 1 and then volume 2, or change the
 * selection, the pacing or the chapter gap, and the player is being handed something new — it must
 * load it, not read the second press as pause/resume of the first.
 */
function previewId(ids: number[]): string {
  const state = exportsStore.exportStateFor(props.bookId, ids);
  const of = `${props.settings.chapterGap}|${ids.map((id) => `${id}=${state[id] ?? ""}`).join("|")}`;
  return `export-preview:${props.bookId}:${hash(of)}`;
}
const preview = computed(() => previewId(props.selected));
const playing = computed(() => player.id === preview.value && player.playing);

/**
 * The export as the player wants it: every clip in order with the silence that will be stitched
 * between them — the book's pacing inside a chapter, the export's own gap between two. The prototype
 * renders no files, so this is a *timed* run: same timeline, same gaps, silent.
 */
function previewQueue(ids: number[], title: string): Queue | null {
  const pacing = castStore.pacingOf(props.bookId);
  const clips: Queue["clips"] = [];
  const list = chapters.value.filter((c) => ids.includes(c.id));
  list.forEach((c, ci) => {
    const heard = scriptsStore.segmentsOf(props.bookId, c.id).filter((x) => x.audio.duration > 0);
    heard.forEach((seg, i) => {
      clips.push({
        id: `x${c.id}-${seg.id}`,
        duration: seg.audio.duration,
        gap:
          i === heard.length - 1
            ? ci === list.length - 1
              ? 0
              : props.settings.chapterGap
            : pauseAfter(seg, heard[i + 1], pacing),
        url: seg.audio.url,
        label: `${c.title} — ${seg.text.slice(0, 60)}`,
        speaker: seg.speaker,
      });
    });
  });
  if (!clips.length) return null;
  // Honest about what it is: the gaps and the running time are exactly what the file would have,
  // but this prototype has rendered no audio, so the run is timed rather than heard.
  const live = clips.filter((c) => c.url).length;
  return {
    id: previewId(ids),
    title,
    subtitle: `${plural(list.length, "chapter")} · ${live ? "stitched preview" : "timed preview — no audio is rendered"}`,
    href: `/book/${props.bookId}/export`,
    clips,
  };
}
function listen(ids: number[], title: string) {
  const q = previewQueue(ids, title);
  if (!q) {
    uiStore.toast("Nothing to preview yet", {
      kind: "warn",
      description: "None of the selected chapters have audio.",
    });
    return;
  }
  playQueue(q);
}

const buildLabel = computed(() => {
  if (running.value) return `Building v${running.value.version}…`;
  if (!props.selected.length) return "Nothing selected";
  if (blocked.value) {
    const n = review.value.blockers.length;
    return `Resolve ${n === 1 ? "the problem" : `${n} problems`} above first`;
  }
  if (audioReview.value.total && !acceptUnreviewed.value)
    return "Resolve or accept the audio review above";
  return replaces.value
    ? `Build v${replaces.value.version + 1}`
    : `Build ${plural(plan.value.files.length, "file")}`;
});
const ACTION_LABEL: Record<string, string> = {
  narrate: "Narrate them",
  drop: "Leave them out",
  stale: "Use the audio as it is",
};
</script>

<template>
  <div class="card">
    <!-- the expected output -->
    <div class="border-b border-zinc-200 p-4 dark:border-zinc-800">
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div class="label">What you will get</div>
        <button
          v-if="plan.files.length"
          class="chip"
          :class="playing && 'chip-on'"
          title="Play the export on its own timeline — the pauses and the running time are the ones the file would have. No audio is rendered in this prototype, so it runs silent."
          @click="listen(selected, plan.label)"
        >
          <component :is="playing ? PauseIcon : PlayIcon" class="icon-sm icon-fill" />
          {{ playing ? "Pause preview" : "Preview" }}
        </button>
      </div>

      <div v-if="!plan.files.length" class="text-sm text-zinc-500">
        Choose chapters on the left and this will describe the audiobook they make.
      </div>
      <template v-else>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <div>
            <dt class="text-[11px] uppercase tracking-wider text-zinc-400">Files</dt>
            <dd class="font-mono text-lg leading-tight">{{ plan.files.length }}</dd>
          </div>
          <div>
            <dt class="text-[11px] uppercase tracking-wider text-zinc-400">Chapters</dt>
            <dd class="font-mono text-lg leading-tight">{{ plan.chapters }}</dd>
          </div>
          <div>
            <dt class="text-[11px] uppercase tracking-wider text-zinc-400">Running time</dt>
            <dd class="font-mono text-lg leading-tight">{{ hms(plan.duration) }}</dd>
          </div>
          <div>
            <dt class="text-[11px] uppercase tracking-wider text-zinc-400">Size</dt>
            <dd class="font-mono text-lg leading-tight">~{{ mb(plan.size) }}</dd>
          </div>
        </dl>

        <ul class="mt-3 space-y-1">
          <li
            v-for="f in plan.files.slice(0, 3)"
            :key="f.name"
            class="flex items-center gap-2 text-sm"
          >
            <FileIcon class="icon shrink-0 text-zinc-400" />
            <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="f.name">{{
              f.name
            }}</span>
            <span
              v-if="f.volume"
              class="shrink-0 rounded bg-zinc-100 px-1.5 text-[10px] text-zinc-500 dark:bg-zinc-800"
              >vol {{ f.volume.number }}/{{ f.volume.of }}</span
            >
            <span class="shrink-0 font-mono text-[11px] text-zinc-500"
              >{{ f.chapterIds.length }} ch · {{ hms(f.duration) }} · ~{{ mb(f.size) }}</span
            >
          </li>
        </ul>
        <button
          v-if="plan.files.length > 3"
          class="mt-1 text-xs text-violet-600 hover:underline dark:text-violet-400"
          @click="files = true"
        >
          …and {{ plan.files.length - 3 }} more — see every file and the chapter order
        </button>
        <button
          v-else
          class="mt-1 text-xs text-violet-600 hover:underline dark:text-violet-400"
          @click="files = true"
        >
          See the chapter order
        </button>

        <p
          v-if="silent"
          class="mt-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400"
        >
          {{ plural(silent, "selected chapter") }} carry no audio yet, so the figures above count
          them as nothing. The build will not start until they are dealt with below.
        </p>
        <p class="mt-2 text-[11px] leading-relaxed text-zinc-400">
          {{ formatOf(settings.format).label }} · {{ settings.bitrate }} kbps ·
          {{ plan.markers ? plural(plan.markers, "chapter mark") : "no chapter marks" }} ·
          {{ settings.cover ? "your cover" : "EPUB cover" }} ·
          {{
            settings.normalize ? `matched to ${settings.loudness} LUFS` : "levels left as rendered"
          }}<template v-if="plan.gaps > 0">
            · {{ hms(plan.gaps) }} of it is the {{ secs(settings.chapterGap) }} between
            chapters</template
          >
        </p>
      </template>
    </div>

    <!-- problems, as things to do -->
    <div
      v-if="review.blockers.length"
      class="space-y-2 border-b border-zinc-200 p-4 dark:border-zinc-800"
    >
      <div
        v-for="b in review.blockers"
        :key="b.kind"
        class="rounded-lg border-l-2 p-3"
        :class="
          b.kind === 'stale'
            ? 'border-amber-400 bg-amber-400/10'
            : b.kind === 'empty'
              ? 'border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50'
              : 'border-red-400 bg-red-500/10'
        "
      >
        <div class="flex items-start gap-2">
          <WarnIcon
            v-if="b.kind !== 'empty'"
            class="icon mt-0.5 shrink-0"
            :class="b.kind === 'stale' ? 'text-amber-600' : 'text-red-500'"
          />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{{ b.title }}</div>
            <p class="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
              {{ b.detail }}
            </p>
            <p
              class="mt-1 line-clamp-2 text-[11px] text-zinc-500"
              :title="chapterNames(b.ids).join('\n')"
            >
              {{ chapterNames(b.ids).slice(0, 3).join(" · ")
              }}<template v-if="b.ids.length > 3"> · +{{ b.ids.length - 3 }} more</template>
            </p>
            <div v-if="b.actions.length" class="mt-2 flex flex-wrap gap-1.5">
              <button class="btn-ghost btn-xs" @click="emit('show', b.ids)">
                Show {{ b.ids.length === 1 ? "chapter" : `these ${b.ids.length} chapters` }}
              </button>
              <button
                v-for="a in b.actions"
                :key="a"
                class="btn-ghost btn-xs"
                :class="a === 'stale' && 'border-amber-400'"
                @click="
                  a === 'narrate'
                    ? emit('narrate', b.ids)
                    : a === 'drop'
                      ? emit('drop', b.ids)
                      : emit('use-stale')
                "
              >
                {{ ACTION_LABEL[a] }}
                <span v-if="a !== 'stale'" class="opacity-60">({{ b.ids.length }})</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="audioReview.total" class="border-b border-zinc-200 p-4 dark:border-zinc-800">
      <div class="rounded-lg border-l-2 border-amber-400 bg-amber-400/10 p-3">
        <div class="flex items-start gap-2">
          <WarnIcon class="icon mt-0.5 shrink-0 text-amber-600" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">Audio review is unfinished</div>
            <p class="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
              The selected chapters contain
              <template v-if="audioReview.flagged.length">
                {{ plural(audioReview.flagged.length, "flagged clip") }}</template
              ><template v-if="audioReview.flagged.length && audioReview.retakes.length">
                and </template
              ><template v-if="audioReview.retakes.length">
                {{ plural(audioReview.retakes.length, "retake decision") }}</template
              >. They are playable, but they still need a listener's decision.
            </p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <RouterLink
                v-if="audioReview.flagged.length"
                :to="reviewLink('flagged')"
                class="btn-ghost btn-xs"
              >
                Review flagged ({{ audioReview.flagged.length }})
              </RouterLink>
              <RouterLink
                v-if="audioReview.retakes.length"
                :to="reviewLink('review')"
                class="btn-ghost btn-xs"
              >
                Compare retakes ({{ audioReview.retakes.length }})
              </RouterLink>
              <button class="btn-ghost btn-xs" @click="emit('show', audioReview.chapterIds)">
                Show affected chapters
              </button>
            </div>
            <label class="mt-3 flex items-start gap-2 text-xs">
              <input v-model="acceptUnreviewed" type="checkbox" class="mt-0.5 accent-violet-600" />
              <span>Build with these unresolved review items. The current clips will be used.</span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- what a build will do -->
    <div class="p-4">
      <div
        v-if="review.usingStale"
        class="mb-3 flex items-start gap-2 rounded-md bg-amber-400/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm mt-0.5" />
        <span class="min-w-0 flex-1"
          >Building with the stale audio in {{ plural(review.usingStale, "chapter") }} — the script
          has moved under those clips since they were rendered.</span
        >
        <button class="shrink-0 underline" @click="emit('use-stale')">undo that choice</button>
      </div>

      <div
        v-if="replaces"
        class="mb-3 rounded-md bg-violet-50 px-2.5 py-2 text-xs text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
      >
        This replaces <b class="font-mono">{{ replaces.filename }}</b> v{{ replaces.version
        }}<span v-if="reuse">
          — {{ reuse }} of {{ selected.length }} chapters have not changed and will be carried over
          rather than encoded again</span
        >. The old version stays listed until you delete it.
      </div>

      <div
        v-if="running"
        class="mb-3 rounded-md bg-zinc-100 px-2.5 py-2 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
      >
        <b class="font-mono">{{ running.filename }}</b> is building now. Wait for it, or cancel it
        on the Audiobooks tab — two builds of one audiobook would both claim v{{ running.version }}.
      </div>

      <button
        class="btn-primary w-full justify-center"
        :disabled="
          blocked || !selected.length || !!running || (!!audioReview.total && !acceptUnreviewed)
        "
        @click="emit('build')"
      >
        <BuildIcon class="icon" /> {{ buildLabel }}
      </button>
      <p class="mt-2 text-center text-[11px] leading-relaxed text-zinc-400">
        Simulated build — the queue, the progress and the failures are real UI, the encoder is not,
        and no file is written to disk.
      </p>
    </div>

    <ExportFiles
      v-model:open="files"
      :book-id="bookId"
      :plan="plan"
      :settings="settings"
      @preview="(ids, title) => listen(ids, title)"
    />
  </div>
</template>
