<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";

// Two takes of one line, side by side: the clip the book still uses on the left, the one waiting for
// a verdict on the right. Nothing is decided until the listener plays both and keeps one, so the
// panel's whole job is to make the difference audible — the shapes, the request each was rendered
// with, and what changed between them.
//
// The verdict itself belongs to the ledger, not here: a verdict removes this comparison and moves to
// the next retake, which can be in another chapter. So this emits `decide` and the ledger, which
// owns the book's review queue and the row keyboard shortcuts, acts on it.
import { defineAsyncComponent } from "vue";
import { FLAG_LABEL } from "@/lib/scriptReview";
import { speechPeaks } from "@/lib/peaks";
import { sampleRateLabel } from "@/lib/speech";
import { usePlayer } from "@/composables/usePlayer";
import { Pause as PauseIcon, Play as PlayIcon, Flag as FlagIcon } from "@lucide/vue";
import type { Segment } from "@/types";

// wavesurfer is only ever needed once a compare panel is open, so it stays out of the entry chunk.
const Waveform = defineAsyncComponent(() => import("@/components/Waveform.vue"));
// Memoised on what `speechPeaks` is a pure function of. **Identity** is the point, not the work: the
// template also reads `clipProgress`, which moves every 100ms while a clip plays, so an unmemoised
// call handed `Waveform` a fresh array ten times a second — and `Waveform` watches `peaks`, so it
// destroyed and rebuilt wavesurfer each time and never stayed alive long enough to draw a playhead.
//
// `<script setup>` compiles into `setup()`, so this map is per open panel rather than shared. The
// key carries the duration anyway: segment ids restart in every chapter, so `seg5#1` alone names a
// different clip per chapter, and the envelope's length comes from the duration.
const PEAKS = new Map<string, number[]>();
function peaksOf(seed: string, duration: number): number[] {
  const key = `${seed}@${duration}`;
  let peaks = PEAKS.get(key);
  if (!peaks) PEAKS.set(key, (peaks = speechPeaks(seed, duration)));
  return peaks;
}

defineProps<{
  segment: Segment;
  /** where this retake sits in the book's review queue, and how many there are */
  position: number;
  total: number;
}>();
/** the verdict, taken by the ledger: it owns the queue this comparison is one of */
defineEmits<{ decide: [keep: "current" | "new"] }>();
const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();
const { p, play, seekTo, clipProgress } = usePlayer();
const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** the clip under the playhead is this one — true whether it is playing alone or inside the chapter */
const onClip = (id: string) => p.clipId === id && p.playing;
/** the clip the retake is judged against: whatever is in the book right now */
const candId = (s: Segment) => `cand${s.id}`;
const candPlaying = (s: Segment) => onClip(candId(s));
/** What differs between the clip in the book and the retake waiting beside it. */
function takeDiff(s: Segment): string[] {
  const a = s.audio;
  const b = s.candidate;
  if (!b) return [];
  const out: string[] = [];
  if ((a.direction || "") !== (b.direction || ""))
    out.push(`direction “${a.direction || "—"}” → “${b.direction || "—"}”`);
  if ((a.voiceRef || "") !== (b.voiceRef || ""))
    out.push(
      `voice ${endpointsStore.voiceLabel(a.voiceRef) || "—"} → ${endpointsStore.voiceLabel(b.voiceRef) || "—"}`,
    );
  if ((a.style || "") !== (b.style || ""))
    out.push(`style “${a.style || "—"}” → “${b.style || "—"}”`);
  // only when both clips recorded one: a clip from before rates were recorded says nothing either way
  if (a.sampleRate && b.sampleRate && a.sampleRate !== b.sampleRate)
    out.push(`sample rate ${sampleRateLabel(a.sampleRate)} → ${sampleRateLabel(b.sampleRate)}`);
  if ((a.text || "") !== (b.text || "")) out.push("the line itself was edited");
  if ((a.said || a.text || "") !== (b.said || b.text || "") && (a.text || "") === (b.text || ""))
    out.push("the dictionary changed how a word is said");
  if (!out.length) out.push("same voice, same direction — the same request, rendered again");
  return out;
}
/** zinc wave / violet played for the clip in the book, sky for the one waiting to be judged */
const waveColors = (candidate: boolean) =>
  candidate
    ? { wave: uiStore.dark ? "#075985" : "#bae6fd", played: uiStore.dark ? "#38bdf8" : "#0284c7" }
    : { wave: uiStore.dark ? "#3f3f46" : "#d4d4d8", played: uiStore.dark ? "#a78bfa" : "#7c3aed" };
/** clicking a waveform plays that take from where you clicked */
function seekTake(id: string, duration: number, url: string | undefined, frac: number) {
  if (p.clipId !== id) play(id, duration, url);
  seekTo(frac * duration);
}
</script>

<template>
  <!-- a retake waiting to be judged. The left card is the clip the book still uses; the
       right one only replaces it if the listener says so. -->
  <tr class="bg-sky-50 dark:bg-sky-500/5">
    <td></td>
    <td colspan="5" class="px-2 py-2 pr-4 text-xs">
      <div class="flex flex-wrap items-center gap-2">
        <b class="text-sky-700 dark:text-sky-300">Two takes of #{{ segment.id }}</b>
        <span v-if="position" class="text-zinc-400"> retake {{ position }} of {{ total }} </span>
        <span v-if="segment.flag" class="text-amber-600"
          ><FlagIcon class="icon-sm" /> {{ FLAG_LABEL[segment.flag.kind]
          }}<span v-if="segment.flag.note"> — {{ segment.flag.note }}</span></span
        >
        <span
          v-if="['queued', 'generating'].includes(segment.candidate!.status)"
          class="ml-auto text-violet-500"
          >rendering take {{ segment.candidate!.n }}… the book still plays take
          {{ segment.audio.n ?? 1 }}</span
        >
      </div>
      <div class="mt-2 grid gap-2 sm:grid-cols-2">
        <div
          class="rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div class="flex items-center gap-2">
            <button
              class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-zinc-200 text-[10px] disabled:opacity-40 dark:bg-zinc-700"
              :aria-label="`${onClip('seg' + segment.id) ? 'Pause' : 'Play'} A, take ${segment.audio.n ?? 1}`"
              aria-keyshortcuts="1"
              :disabled="!segment.audio.duration"
              @click="play('seg' + segment.id, segment.audio.duration, segment.audio.url)"
            >
              <component
                :is="onClip('seg' + segment.id) ? PauseIcon : PlayIcon"
                class="icon-sm icon-fill"
              />
            </button>
            <b>A · Take {{ segment.audio.n ?? 1 }}</b>
            <span class="text-zinc-400">current book</span>
            <kbd class="ml-auto rounded border px-1 text-[10px] text-zinc-400">1</kbd>
            <span class="font-mono text-zinc-500">{{ segment.audio.duration.toFixed(1) }}s</span>
          </div>
          <Waveform
            v-if="segment.audio.duration"
            class="mt-1.5"
            :url="segment.audio.url"
            :peaks="
              peaksOf('seg' + segment.id + '#' + (segment.audio.n ?? 1), segment.audio.duration)
            "
            :duration="segment.audio.duration"
            :progress="clipProgress('seg' + segment.id) ?? 0"
            v-bind="waveColors(false)"
            @seek="
              (f) => seekTake('seg' + segment.id, segment.audio.duration, segment.audio.url, f)
            "
          />
          <div class="mt-1 pl-8 text-[11px] text-zinc-500">
            {{ endpointsStore.voiceLabel(segment.audio.voiceRef) || segment.audio.voice || "—" }} ·
            {{ segment.audio.direction || "no direction"
            }}<span v-if="segment.audio.sampleRate">
              · {{ sampleRateLabel(segment.audio.sampleRate) }}</span
            ><span v-if="segment.audio.at"> · {{ clock(segment.audio.at) }}</span>
          </div>
        </div>
        <div
          class="rounded-md border p-2"
          :class="
            segment.candidate!.duration
              ? 'border-sky-400 bg-white dark:bg-zinc-900'
              : 'border-dashed border-zinc-300 dark:border-zinc-700'
          "
        >
          <div class="flex items-center gap-2">
            <button
              class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-sky-500 text-[10px] text-white disabled:opacity-40"
              :aria-label="`${candPlaying(segment) ? 'Pause' : 'Play'} B, take ${segment.candidate!.n}`"
              aria-keyshortcuts="2"
              :disabled="!segment.candidate!.duration"
              @click="play(candId(segment), segment.candidate!.duration, segment.candidate!.url)"
            >
              <component
                :is="candPlaying(segment) ? PauseIcon : PlayIcon"
                class="icon-sm icon-fill"
              />
            </button>
            <b>B · Take {{ segment.candidate!.n }}</b>
            <span class="text-zinc-400">{{
              segment.candidate!.auto ? "replacement" : "retake"
            }}</span>
            <kbd class="ml-auto rounded border px-1 text-[10px] text-sky-500">2</kbd>
            <span class="font-mono text-zinc-500">{{
              segment.candidate!.duration ? segment.candidate!.duration.toFixed(1) + "s" : "…"
            }}</span>
          </div>
          <Waveform
            v-if="segment.candidate!.duration"
            class="mt-1.5"
            :url="segment.candidate!.url"
            :peaks="
              peaksOf(candId(segment) + '#' + segment.candidate!.n, segment.candidate!.duration)
            "
            :duration="segment.candidate!.duration"
            :progress="clipProgress(candId(segment)) ?? 0"
            v-bind="waveColors(true)"
            @seek="
              (f) =>
                seekTake(candId(segment), segment.candidate!.duration, segment.candidate!.url, f)
            "
          />
          <div class="mt-1 pl-8 text-[11px]">
            <span v-if="segment.candidate!.error" class="text-red-500"
              >{{
                segment.candidate!.error!.code
                  ? "HTTP " + segment.candidate!.error!.code + " · "
                  : ""
              }}{{ segment.candidate!.error!.message }}</span
            ><span v-else class="text-zinc-500"
              >{{
                endpointsStore.voiceLabel(segment.candidate!.voiceRef) ||
                segment.candidate!.voice ||
                "—"
              }}
              · {{ segment.candidate!.direction || "no direction"
              }}<span v-if="segment.candidate!.sampleRate">
                · {{ sampleRateLabel(segment.candidate!.sampleRate!) }}</span
              ><span v-if="segment.candidate!.at"> · {{ clock(segment.candidate!.at) }}</span></span
            >
          </div>
        </div>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <span class="min-w-0 flex-1 text-zinc-500"
          >{{ takeDiff(segment).join(" · ")
          }}<span
            v-if="!segment.audio.url && !segment.candidate!.url"
            class="ml-1 text-[10px] text-amber-600"
            title="the prototype renders no audio, so there is no file to decode — the shape is invented from the clip's identity, not measured"
            >· waveform illustrative</span
          ></span
        >
        <template v-if="!['queued', 'generating'].includes(segment.candidate!.status)">
          <button
            class="btn-ghost btn-xs"
            :title="
              segment.candidate!.duration
                ? 'keep the clip the book already uses (x)'
                : 'drop this retake (x)'
            "
            aria-keyshortcuts="x"
            @click="$emit('decide', 'current')"
          >
            {{
              segment.candidate!.duration
                ? `Keep A · take ${segment.audio.n ?? 1}`
                : "Discard retake"
            }}
            <kbd class="ml-1 rounded border px-1 text-[9px]">X</kbd>
          </button>
          <button
            v-if="segment.candidate!.duration"
            class="btn-primary btn-xs"
            title="put the new clip in the book and clear the flag (a)"
            aria-keyshortcuts="a"
            @click="$emit('decide', 'new')"
          >
            Keep B · take {{ segment.candidate!.n }}
            <kbd class="ml-1 rounded border border-white/40 px-1 text-[9px]">A</kbd>
          </button>
        </template>
      </div>
    </td>
  </tr>
</template>
