<script setup lang="ts">
// One picked sample in the clone or keep form: play, waveform, trim, transcript. Decoded once
// (`lib/sampleAudio.ts`) for duration, peaks, silence trim and the cut; an undecodable file still
// plays but can't be trimmed. A selection stops on the player's tick, up to 0.1 s late.
import { computed, defineAsyncComponent, ref, shallowRef, watch } from "vue";
import {
  Captions as TranscribeIcon,
  LoaderCircle as BusyIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Scissors as TrimIcon,
  X as RemoveIcon,
} from "@lucide/vue";
import { UiHint, UiNumber, UiTooltip } from "@/ui";
import { usePlayer, type Queue } from "@/composables/usePlayer";
import { useEndpointsStore } from "@/stores/endpoints";
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
  /** the provider takes a per-sample transcript */
  asks: boolean;
  /** …and will not clone without one */
  must: boolean;
}>();
const emit = defineEmits<{ change: [row: SampleRow]; remove: [] }>();
const player = usePlayer();
const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();
const name = computed(() => props.row.file.name);

const url = ref("");
const id = computed(() => `sample-pick:${url.value}`);
const audio = shallowRef<SampleAudio | null>(null);
const unreadable = ref(false);
const trim = ref<{ start: number; end: number } | null>(null);
const silent = ref(false);
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
// Pausing, or playing something else, also ends the selection.
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
/** kept 0.1 s from the other edge and inside the clip */
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
const hearing = ref(false);
async function transcribe() {
  const file = props.row.file;
  hearing.value = true;
  try {
    const text = await endpointsStore.transcribe(file);
    // a file replaced meanwhile is not what was heard
    if (text == null || props.row.file !== file) return;
    // heard from the current file, so an earlier trim no longer needs a check
    emit("change", {
      ...props.row,
      transcript: text.trim().slice(0, MAX_TRANSCRIPT_CHARS),
      trimmed: false,
    });
  } finally {
    hearing.value = false;
  }
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
    <div v-if="asks" class="mt-1 flex items-center gap-1">
      <input
        :value="row.transcript"
        class="input min-w-0 flex-1 py-0.5"
        :maxlength="MAX_TRANSCRIPT_CHARS"
        :required="must"
        :placeholder="
          must ? 'What is said in this sample (required)' : 'What is said in this sample (optional)'
        "
        :aria-label="`Transcript of ${name}`"
        @input="said"
      />
      <UiTooltip
        v-if="endpointsStore.canTranscribe"
        text="Transcribe with a speech-to-text endpoint"
      >
        <button
          type="button"
          class="btn-ghost btn-xs shrink-0"
          :disabled="hearing"
          :aria-label="`Transcribe ${name}`"
          @click="transcribe"
        >
          <BusyIcon v-if="hearing" class="icon-sm animate-spin" />
          <TranscribeIcon v-else class="icon-sm" />
        </button>
      </UiTooltip>
    </div>
    <p
      v-if="asks && row.trimmed && row.transcript.trim()"
      class="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400"
    >
      Trimmed — check the transcript still matches.
    </p>
  </li>
</template>
