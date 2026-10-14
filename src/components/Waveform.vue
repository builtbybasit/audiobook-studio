<script setup lang="ts">
// A waveform drawn by wavesurfer.js, used directly: it only draws. `usePlayer` is the one playback
// engine, so the playhead is pushed in with `setTime`. Pre-decoded `peaks` skip a second decode;
// the optional `region` v-model is one start–end selection (regions plugin), null for none.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";

const props = withDefaults(
  defineProps<{
    url: string;
    duration: number;
    /** 0…1 of this clip, driven by the app's player */
    progress?: number;
    wave?: string;
    played?: string;
    height?: number;
    /** pre-decoded samples, so wavesurfer skips decoding */
    peaks?: Float32Array;
  }>(),
  { progress: 0, wave: "#a1a1aa", played: "#7c3aed", height: 32, peaks: undefined },
);
const emit = defineEmits<{ seek: [fraction: number] }>();
/** a selection, in seconds; null draws none */
const region = defineModel<{ start: number; end: number } | null>("region", { default: null });

const box = ref<HTMLElement | null>(null);
let ws: WaveSurfer | null = null;
let regions: RegionsPlugin | null = null;
let shown: Region | null = null;
// Peaks decode a microtask after create; until then there is no duration, so the playhead waits.
let ready = false;
function drawHead() {
  if (ready && ws) ws.setTime(props.progress * props.duration);
}

/** Draw the parent's selection: add it, move it, or remove it. */
function drawRegion() {
  if (!ready || !regions) return;
  const r = region.value;
  if (!r) {
    shown?.remove();
    shown = null;
  } else if (!shown) {
    const made = regions.addRegion({
      start: r.start,
      end: r.end,
      color: "rgba(124, 58, 237, 0.18)",
      minLength: 0.1,
    });
    // only a finished drag is a new selection; the parent's changes come back through the watch
    made.on("update-end", () => (region.value = { start: made.start, end: made.end }));
    shown = made;
  } else if (shown.start !== r.start || shown.end !== r.end) {
    shown.setOptions({ start: r.start, end: r.end });
  }
}

function build() {
  ws?.destroy();
  ws = null;
  shown = null;
  if (!box.value || !props.duration) return;
  regions = RegionsPlugin.create();
  ws = WaveSurfer.create({
    container: box.value,
    height: props.height,
    waveColor: props.wave,
    progressColor: props.played,
    cursorWidth: 1,
    cursorColor: props.played,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
    duration: props.duration,
    url: props.url,
    peaks: props.peaks ? [props.peaks] : undefined,
    plugins: [regions],
  });
  ready = false;
  ws.on("ready", () => {
    ready = true;
    drawHead();
    drawRegion();
  });
  // a seek request; the player decides
  ws.on("interaction", (t: number) => emit("seek", props.duration ? t / props.duration : 0));
  // a file that won't load must not take the panel down with it
  ws.on("error", () => {});
}

onMounted(build);
onBeforeUnmount(() => {
  ws?.destroy();
  ws = null;
});
// a different clip rebuilds; colours, the playhead and the selection update in place
watch(() => [props.url, props.duration, props.peaks], build);
watch(
  () => [props.wave, props.played],
  () => ws?.setOptions({ waveColor: props.wave, progressColor: props.played }),
);
watch(() => props.progress, drawHead);
watch(region, drawRegion);
</script>

<template>
  <div ref="box" class="w-full cursor-pointer"></div>
</template>
