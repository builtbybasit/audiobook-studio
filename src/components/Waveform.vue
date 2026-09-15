<script setup lang="ts">
// A waveform, drawn by wavesurfer.js — used where the *shape* of a clip is the point: comparing two
// takes of the same line, where "what differs" can be dead air, a clipped ending or a flatter read
// before it is anything you can put into words.
//
// wavesurfer is used directly, not through a wrapper, for the same reason Unovis is on the endpoints
// page — and here the wrapper would be actively in the way: this draws, it does not play. The app has
// exactly one playback engine (`usePlayer`), so the element stays out of wavesurfer's hands and the
// playhead is pushed in from outside with `setTime`. `getDuration()` falls back to the decoded peaks,
// so that works with no media attached at all.
//
// With a `url` wavesurfer decodes the real file. Without one — the prototype has no files — it draws
// the invented shape from `peaks`, and the caller says so on screen.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import WaveSurfer from "wavesurfer.js";

const props = withDefaults(
  defineProps<{
    /** the real file, when a backend has rendered one */
    url?: string;
    /** pre-computed samples, used when there is no file */
    peaks?: number[];
    duration: number;
    /** 0…1 of this clip; the playhead the app's player is driving */
    progress?: number;
    wave?: string;
    played?: string;
    height?: number;
  }>(),
  { progress: 0, wave: "#a1a1aa", played: "#7c3aed", height: 32 },
);
const emit = defineEmits<{ seek: [fraction: number] }>();

const box = ref<HTMLElement | null>(null);
let ws: WaveSurfer | null = null;
// Peaks are decoded a microtask after create, and until they are, wavesurfer has no duration to draw
// progress against. So the playhead is held here and applied once the waveform is ready.
let ready = false;
function drawHead() {
  if (ready && ws) ws.setTime(props.progress * props.duration);
}

function build() {
  ws?.destroy();
  ws = null;
  if (!box.value || !props.duration) return;
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
    ...(props.url ? { url: props.url } : { peaks: [props.peaks ?? []] }),
  });
  ready = false;
  ws.on("ready", () => {
    ready = true;
    drawHead();
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
// a different clip is a different waveform; colours and the playhead are not
watch(() => [props.url, props.peaks, props.duration], build);
watch(
  () => [props.wave, props.played],
  () => ws?.setOptions({ waveColor: props.wave, progressColor: props.played }),
);
watch(() => props.progress, drawHead);
</script>

<template>
  <div ref="box" class="w-full cursor-pointer"></div>
</template>
