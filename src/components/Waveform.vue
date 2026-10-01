<script setup lang="ts">
// A waveform, drawn by wavesurfer.js — used where the *shape* of a clip is the point: comparing two
// takes of the same line, where "what differs" can be dead air, a clipped ending or a flatter read
// before it is anything you can put into words; or a voice sample about to be cloned, where the
// shape shows the silence worth trimming.
//
// wavesurfer is used directly, not through a wrapper, for the same reason Unovis is on the endpoints
// page — and here the wrapper would be actively in the way: this draws, it does not play. The app has
// exactly one playback engine (`usePlayer`), so the element stays out of wavesurfer's hands and the
// playhead is pushed in from outside with `setTime`. `getDuration()` falls back to the decoded peaks,
// so that works with no media attached at all.
//
// A clip the page has decoded already hands its samples in as `peaks`, so wavesurfer draws those
// rather than fetching and decoding the file a second time. The optional `region` v-model is one
// start–end selection over the shape, dragged and resized with wavesurfer's regions plugin; setting
// it to null takes it away.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";

const props = withDefaults(
  defineProps<{
    /** the clip's file, which wavesurfer decodes */
    url: string;
    duration: number;
    /** 0…1 of this clip; the playhead the app's player is driving */
    progress?: number;
    wave?: string;
    played?: string;
    height?: number;
    /** the clip's samples, when the page has decoded them already */
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
// Peaks are decoded a microtask after create, and until they are, wavesurfer has no duration to draw
// progress against. So the playhead is held here and applied once the waveform is ready.
let ready = false;
function drawHead() {
  if (ready && ws) ws.setTime(props.progress * props.duration);
}

/** Draw the selection the parent holds: add it, move it, or take it away. */
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
    // only a finished drag is a new selection; the parent's own changes come back through the watch
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
  // clicking the shape is a seek request; the player decides what to do with it
  ws.on("interaction", (t: number) => emit("seek", props.duration ? t / props.duration : 0));
  // a file that won't load must not take the panel down with it
  ws.on("error", () => {});
}

onMounted(build);
onBeforeUnmount(() => {
  ws?.destroy();
  ws = null;
});
// a different clip is a different waveform; colours, the playhead and the selection are not
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
