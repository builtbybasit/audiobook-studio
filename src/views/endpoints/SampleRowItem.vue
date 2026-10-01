<script setup lang="ts">
// One picked sample in the clone or keep form: play it, see its shape and how long it runs, cut it
// down, say what is said in it.
//
// The file is decoded here once (`lib/sampleAudio.ts`) and that one decode serves everything: the
// duration, the waveform's peaks, the speech found for "Trim silence" and the cut itself. A file the
// browser cannot decode still plays where the <audio> element can, but has no shape and no trim.
//
// Playback is the app's one player, under an id made from the file's object URL, so it lights only
// this row's button and stops when the row goes. Playing a selection starts the player at its start
// and pauses it once the playhead passes its end, which the player notices on its own tick — a
// tenth of a second late at most. Apply swaps the row's file for the cut, a WAV, and marks the row
// trimmed, so a transcript typed for the whole file asks to be checked.
import { computed, defineAsyncComponent, ref, shallowRef, watch } from "vue";
import {
  Pause as PauseIcon,
  Play as PlayIcon,
  Scissors as TrimIcon,
  X as RemoveIcon,
} from "@lucide/vue";
import { UiHint, UiNumber } from "@/ui";
import { usePlayer, type Queue } from "@/composables/usePlayer";
import { useUiStore } from "@/stores/ui";
import { sizeLabel } from "@/lib/audioFormat";
import { clockDuration } from "@/lib/time";
import { MAX_TRANSCRIPT_CHARS } from "@/lib/voiceSamples";
import { decodeSample, speechBounds, trimSample, type SampleAudio } from "@/lib/sampleAudio";
import type { SampleRow } from "@/views/endpoints/cloneForm";

// wavesurfer is only needed once a sample is picked, so it stays out of the page's chunk
const Waveform = defineAsyncComponent(() => import("@/components/Waveform.vue"));

const props = defineProps<{
  row: SampleRow;
  /** the provider takes a transcript of each sample */
  asks: boolean;
  /** …and will not clone without one */
  must: boolean;
}>();
const emit = defineEmits<{ change: [row: SampleRow]; remove: [] }>();
const player = usePlayer();
const uiStore = useUiStore();
const name = computed(() => props.row.file.name);

const url = ref("");
const id = computed(() => `sample-pick:${url.value}`);
const audio = shallowRef<SampleAudio | null>(null);
const unreadable = ref(false);
/** the selection while trimming; null when not */
const trim = ref<{ start: number; end: number } | null>(null);
const silent = ref(false);
/** where a selection being played stops */
const stopAt = ref<number | null>(null);

watch(
  () => props.row.file,
  async (file, _, onCleanup) => {
    const u = URL.createObjectURL(file);
    url.value = u;
    audio.value = null;
    unreadable.value = false;
    trim.value = null;
    let gone = false;
    onCleanup(() => {
      gone = true;
      if (player.p.id === `sample-pick:${u}`) player.stop();
      URL.revokeObjectURL(u);
    });
    try {
      const decoded = await decodeSample(file);
      if (!gone) audio.value = decoded;
    } catch {
      if (!gone) unreadable.value = true;
    }
  },
  { immediate: true },
);

const playing = computed(() => player.p.id === id.value && player.p.playing);
const queue = (a: SampleAudio): Queue => ({
  id: id.value,
  clips: [{ id: id.value, duration: a.duration, url: url.value, label: name.value }],
  title: name.value,
});
function toggle() {
  if (audio.value) player.playQueue(queue(audio.value));
  else void player.playFile(id.value, url.value, name.value).catch(() => {});
}
/** a click on the shape plays from there, or moves the playhead if this sample is loaded already */
function seek(fraction: number) {
  if (!audio.value) return;
  const at = fraction * audio.value.duration;
  if (player.p.id === id.value) player.seekTo(at);
  else player.playQueue(queue(audio.value), at);
}

function playSelection() {
  if (stopAt.value != null) return player.pause();
  if (!audio.value || !trim.value) return;
  player.playQueue(queue(audio.value), trim.value.start);
  stopAt.value = trim.value.end;
}
// Read the playhead only while a selection plays. Pausing, or playing something else, ends it too.
watch(
  () =>
    stopAt.value != null &&
    (player.p.id !== id.value || !player.p.playing || player.p.pos >= stopAt.value),
  (over) => {
    if (!over) return;
    if (player.p.id === id.value && player.p.playing) player.pause();
    stopAt.value = null;
  },
);

function startTrim() {
  if (audio.value) trim.value = { start: 0, end: audio.value.duration };
  silent.value = false;
}
function trimSilence() {
  if (!audio.value) return;
  const found = speechBounds(audio.value);
  silent.value = !found;
  if (found) trim.value = found;
}
/** an edge typed in, kept a tenth of a second from the other one and inside the clip */
function setEdge(edge: "start" | "end", v: number | null) {
  const t = trim.value;
  if (!t || !audio.value || v == null) return;
  trim.value =
    edge === "start"
      ? { start: Math.min(Math.max(0, v), t.end - 0.1), end: t.end }
      : { start: t.start, end: Math.max(Math.min(audio.value.duration, v), t.start + 0.1) };
}
const round = (s: number) => Math.round(s * 100) / 100;
function cancel() {
  trim.value = null;
  stopAt.value = null;
}
function apply() {
  if (!audio.value || !trim.value) return;
  const file = trimSample(audio.value, trim.value.start, trim.value.end, name.value);
  cancel();
  emit("change", { ...props.row, file, trimmed: true });
}
function said(e: Event) {
  emit("change", { ...props.row, transcript: (e.target as HTMLInputElement).value });
}

const colors = computed(() =>
  uiStore.dark ? { wave: "#3f3f46", played: "#a78bfa" } : { wave: "#d4d4d8", played: "#7c3aed" },
);
</script>

<template>
  <li class="py-1 text-xs">
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="btn-ghost btn-xs shrink-0"
        :aria-label="`${playing ? 'Pause' : 'Play'} ${name}`"
        @click="toggle"
      >
        <PauseIcon v-if="playing" class="icon-sm icon-fill" />
        <PlayIcon v-else class="icon-sm icon-fill" />
      </button>
      <span class="min-w-0 flex-1 truncate" :title="name">{{ name }}</span>
      <span class="shrink-0 text-[11px] text-zinc-500 tabular-nums"
        >{{ audio ? `${clockDuration(audio.duration)} · ` : ""
        }}{{ sizeLabel(row.file.size) }}</span
      >
      <button
        v-if="audio && !trim"
        type="button"
        class="btn-ghost btn-xs shrink-0"
        :aria-label="`Trim ${name}`"
        @click="startTrim"
      >
        <TrimIcon class="icon-sm" /> Trim
      </button>
      <button
        type="button"
        class="btn-ghost btn-xs shrink-0 hover:text-red-500"
        :aria-label="`Remove ${name}`"
        @click="emit('remove')"
      >
        <RemoveIcon class="icon-sm" />
      </button>
    </div>
    <Waveform
      v-if="audio"
      v-model:region="trim"
      class="mt-1"
      :url="url"
      :duration="audio.duration"
      :peaks="audio.samples"
      :progress="player.clipProgress(id) ?? 0"
      :height="28"
      v-bind="colors"
      @seek="seek"
    />
    <p v-else-if="unreadable" class="text-[11px] text-zinc-500">
      This browser can't decode it, so there is no waveform or trim.
    </p>
    <div v-if="trim && audio" class="mt-1 flex flex-wrap items-center gap-2">
      <button type="button" class="btn-ghost btn-xs" @click="playSelection">
        <PauseIcon v-if="stopAt != null" class="icon-sm icon-fill" />
        <PlayIcon v-else class="icon-sm icon-fill" />
        {{ stopAt != null ? "Pause" : "Play selection" }}
      </button>
      <!-- Enter in a field must not submit the clone form around this row -->
      <UiNumber
        class="w-20"
        :model-value="round(trim.start)"
        :step="0.1"
        unit="s"
        :label="`Start of the selection in ${name}, seconds`"
        @update:model-value="(v) => setEdge('start', v)"
        @keydown.enter.prevent
      />
      <span class="text-zinc-400">–</span>
      <UiNumber
        class="w-20"
        :model-value="round(trim.end)"
        :step="0.1"
        unit="s"
        :label="`End of the selection in ${name}, seconds`"
        @update:model-value="(v) => setEdge('end', v)"
        @keydown.enter.prevent
      />
      <button type="button" class="btn-ghost btn-xs" @click="trimSilence">Trim silence</button>
      <UiHint
        label="trimming"
        text="Drag the selection or its edges on the waveform, or type them. Trim silence selects from where speech starts to where it ends. Apply keeps only the selection, as a WAV file."
      />
      <span v-if="silent" class="text-[11px] text-amber-600 dark:text-amber-400"
        >No speech found.</span
      >
      <span class="ml-auto flex gap-2">
        <button type="button" class="btn-ghost btn-xs" @click="cancel">Cancel</button>
        <button type="button" class="btn-primary btn-xs" @click="apply">Apply</button>
      </span>
    </div>
    <input
      v-if="asks"
      :value="row.transcript"
      class="input mt-1 w-full py-0.5"
      :maxlength="MAX_TRANSCRIPT_CHARS"
      :required="must"
      :placeholder="
        must ? 'What is said in this sample (required)' : 'What is said in this sample (optional)'
      "
      :aria-label="`Transcript of ${name}`"
      @input="said"
    />
    <p
      v-if="asks && row.trimmed && row.transcript.trim()"
      class="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400"
    >
      Trimmed — check the transcript still matches.
    </p>
  </li>
</template>
