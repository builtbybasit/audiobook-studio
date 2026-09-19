<script lang="ts">
import type { Segment } from "@/types";

/** Is there an audit trail to open? One definition: the row that opens it and the `i` key ask this
 *  too, and a row that says "click for render details" over an empty strip is a lie. */
export const hasDetails = (s: Segment): boolean => !!(s.audio.at || s.audio.error || s.audio.cuts);
</script>

<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useNarrationStore } from "@/stores/narration";
import { useUiStore } from "@/stores/ui";

// One clip's audit trail: what it was actually rendered with, what the dictionary sent in its place,
// why it no longer matches the script, what came back when it failed, every take of the line, and
// how a line too long for its endpoint was cut up. It is a record of a request, so nothing here is
// re-derived from what the book holds now — the facts come off the clip itself.
import { useJob } from "@/views/narration/shared";
import { secs } from "@/lib/speech";
import { usePlayer } from "@/composables/usePlayer";
import {
  Pause as PauseIcon,
  PencilLine as EditIcon,
  Play as PlayIcon,
  Scissors as CutIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import type { SegmentAudio, Take } from "@/types";

const props = defineProps<{ bookId: string; chapterId: number; segment: Segment }>();
/** the failed or drifted clip should be rendered again — the ledger owns every run entry point */
defineEmits<{ retry: [] }>();
const endpointsStore = useEndpointsStore();
const narrationStore = useNarrationStore();
const uiStore = useUiStore();
const { chapter, epName } = useJob(props);
const { p, play } = usePlayer();
const AT = { sentence: "sentence", clause: "clause", word: "word", char: "hard cut" };
const onClip = (id: string) => p.clipId === id && p.playing;
const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
// what differs between the clip and the script now (the reason a row is stale, made explicit)
const drift = (s: Segment, a?: SegmentAudio) => narrationStore.clipDrift(props.bookId, s, a);
/** The line itself, in the reader — where a wrong speaker, direction or word is fixed before a
 *  retake would read the same request again. The same deep link Search uses. */
const lineLink = (s: Segment) => ({
  path: `/book/${props.bookId}/scripting`,
  query: { ch: String(props.chapterId), seg: String(s.id) },
});
function requestOf(s: Segment) {
  const ep = endpointsStore.endpoints.find((e) => e.id === s.audio.endpoint);
  return JSON.stringify(
    {
      POST: (ep?.baseUrl ?? "") + "/audio/speech",
      headers: { Authorization: "Bearer <key>" },
      body: {
        model: s.audio.model,
        voice: s.audio.voice,
        input: s.audio.said ?? s.text,
        instructions: [s.audio.style, s.audio.direction].filter(Boolean).join("; ") || undefined,
        response_format: "wav",
      },
      error: s.audio.error,
    },
    null,
    2,
  );
}
function copyReq(s: Segment) {
  navigator.clipboard?.writeText(requestOf(s));
  uiStore.toast("Request copied as JSON", { kind: "success", timeout: 2500 });
}
/** The audit trail as a strip of labelled facts — what this clip was actually rendered with. The
 *  free-text ones (style, direction) go last and take the rest of the line: they are whole phrases. */
interface Fact {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}
function facts(s: Segment): Fact[] {
  const a = s.audio;
  if (!a.at) return [];
  return [
    { label: "voice", value: endpointsStore.voiceLabel(a.voiceRef) || a.voice || "—" },
    { label: "endpoint", value: epName(a.endpoint) },
    { label: "model", value: a.model ?? "—", mono: true },
    { label: "read as", value: a.type ?? s.type },
    { label: "rendered", value: clock(a.at) },
    { label: "took", value: a.ms ? (a.ms / 1000).toFixed(1) + "s" : "—", mono: true },
    ...(a.cost ? [{ label: "cost", value: "$" + a.cost.toFixed(4), mono: true }] : []),
    ...(a.lex ? [{ label: "respelled", value: `${a.lex} word${a.lex === 1 ? "" : "s"}` }] : []),
    ...(s.pause == null
      ? []
      : [{ label: "pause after", value: s.pause === 0 ? "none — runs on" : secs(s.pause) }]),
    ...(a.style ? [{ label: "style", value: a.style, wide: true }] : []),
    { label: "direction", value: a.direction || "—", wide: true },
  ];
}
/** Every take of a segment, the current one included, oldest first. */
function allTakes(s: Segment): (Take & { current?: boolean })[] {
  const list: (Take & { current?: boolean })[] = [...(s.audio.takes ?? [])];
  if (s.audio.duration)
    list.push({
      n: s.audio.n ?? 1,
      at: s.audio.at ?? 0,
      ms: s.audio.ms,
      duration: s.audio.duration,
      endpoint: s.audio.endpoint,
      voiceRef: s.audio.voiceRef,
      voice: s.audio.voice,
      direction: s.audio.direction,
      current: true,
    });
  return list.sort((a, b) => a.n - b.n);
}
const takeTitle = (t: Take) =>
  `${endpointsStore.voiceLabel(t.voiceRef) || t.voice || "—"} · ${t.direction || "no direction"} · ${t.at ? clock(t.at) : ""}`;
const takeId = (s: Segment, n: number) => `take${s.id}-${n}`;
function playTake(s: Segment, t: Take | undefined) {
  if (t) play(takeId(s, t.n), t.duration, t.url);
}
const takePlaying = (s: Segment, t: Take | undefined) => !!t && onClip(takeId(s, t.n));
</script>

<template>
  <tr class="bg-zinc-50 dark:bg-zinc-900/60">
    <td></td>
    <td colspan="5" class="py-2 pr-4">
      <div class="border-l-2 border-violet-400 pl-3 text-xs dark:border-violet-500">
        <!-- what this clip was rendered with -->
        <div v-if="facts(segment).length" class="flex items-start gap-3">
          <div class="flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-1.5">
            <div
              v-for="f in facts(segment)"
              :key="f.label"
              class="min-w-0"
              :class="f.wide ? 'min-w-[10rem] flex-1' : 'max-w-[220px]'"
            >
              <div class="text-[9px] uppercase tracking-wider text-zinc-400">
                {{ f.label }}
              </div>
              <div
                :class="[f.mono && 'font-mono text-[11px]', f.wide ? 'break-words' : 'truncate']"
              >
                {{ f.value }}
              </div>
            </div>
          </div>
          <span class="flex shrink-0 items-center gap-3 text-[11px]">
            <RouterLink
              :to="lineLink(segment)"
              class="text-violet-500 hover:underline"
              title="open this line in the reader"
              @click.stop
            >
              <EditIcon class="icon-sm" /> edit line
            </RouterLink>
            <button
              class="text-violet-500 hover:underline"
              title="the exact request body, as JSON"
              @click.stop="copyReq(segment)"
            >
              copy request
            </button>
          </span>
        </div>

        <!-- the dictionary rewrote something on the way out -->
        <div
          v-if="segment.audio.said"
          class="mt-2 rounded bg-violet-500/5 px-2 py-1 text-[11px] leading-relaxed"
        >
          <span class="text-[9px] uppercase tracking-wider text-zinc-400">sent</span>
          <span class="ml-1.5 font-mono text-violet-700 dark:text-violet-300">{{
            segment.audio.said
          }}</span>
        </div>

        <!-- the clip no longer matches the script -->
        <div
          v-if="drift(segment).length || segment.audio.status === 'stale'"
          class="mt-2 flex flex-wrap items-center gap-2 rounded bg-amber-400/10 px-2 py-1 text-amber-700 dark:text-amber-300"
        >
          <WarnIcon class="icon shrink-0" />
          <span class="min-w-0 flex-1">{{
            drift(segment).length
              ? `the script changed after this clip · ${drift(segment).join(" · ")}`
              : "edited after narration — this clip reads the old script"
          }}</span>
          <button
            v-if="chapter?.narration !== 'running'"
            class="btn-ghost btn-xs shrink-0 border-amber-400"
            @click.stop="$emit('retry')"
          >
            Render it again
          </button>
        </div>

        <!-- the request failed -->
        <div
          v-if="segment.audio.error"
          class="mt-2 rounded border border-red-300 bg-red-500/5 px-2 py-1.5 dark:border-red-500/40"
        >
          <div class="flex flex-wrap items-center gap-2">
            <b class="text-red-600">{{
              segment.audio.error.code ? "HTTP " + segment.audio.error.code : "not sent"
            }}</b
            ><span class="min-w-0 flex-1">{{ segment.audio.error.message }}</span
            ><span v-if="segment.audio.error.at" class="text-zinc-400">{{
              clock(segment.audio.error.at)
            }}</span>
          </div>
          <pre
            v-if="segment.audio.error.body"
            class="mt-1 max-h-16 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-1.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
            >{{ segment.audio.error.body }}</pre>
        </div>

        <!-- every take, the one in the book marked -->
        <div v-if="segment.audio.takes?.length" class="mt-2 flex flex-wrap items-center gap-1.5">
          <span class="text-[9px] uppercase tracking-wider text-zinc-400">takes</span>
          <button
            v-for="t in allTakes(segment)"
            :key="t.n"
            class="chip"
            :class="[t.current && 'chip-on', t.rejected && 'chip-off']"
            :title="takeTitle(t)"
            @click.stop="
              t.current
                ? play('seg' + segment.id, segment.audio.duration, segment.audio.url)
                : playTake(segment, t)
            "
          >
            <component
              :is="
                (t.current ? onClip('seg' + segment.id) : takePlaying(segment, t))
                  ? PauseIcon
                  : PlayIcon
              "
              class="icon-sm icon-fill"
            />
            take {{ t.n }} · {{ t.duration.toFixed(1) }}s
            <span v-if="t.current" class="text-[10px] opacity-70">in the book</span>
            <span v-else-if="t.rejected" class="text-[10px]">not kept</span>
          </button>
        </div>

        <!-- one segment, several requests -->
        <details v-if="segment.audio.cuts" class="mt-2">
          <summary class="cursor-pointer text-[9px] uppercase tracking-wider text-zinc-400">
            sent as {{ segment.audio.cuts!.length }} requests · cut at
            {{ (segment.audio.splitAt && AT[segment.audio.splitAt]) ?? segment.audio.splitAt }} ·
            joined after
          </summary>
          <ol class="mt-1 max-h-28 space-y-1 overflow-auto pr-1">
            <li v-for="(c, i) in segment.audio.cuts" :key="i" class="flex gap-3">
              <span class="w-14 shrink-0 whitespace-nowrap font-mono text-[10px] text-zinc-400"
                >{{ i + 1 }} · {{ c.to - c.from }} ch</span
              ><span class="min-w-0 flex-1 text-zinc-600 dark:text-zinc-300"
                >{{ (segment.audio.said ?? segment.text).slice(c.from, c.to)
                }}<span
                  v-if="c.at"
                  class="ml-2 font-mono text-[10px]"
                  :class="c.fallback ? 'text-amber-600' : 'text-zinc-400'"
                  ><CutIcon class="icon-sm" /> {{ AT[c.at]
                  }}{{ c.fallback ? " (fallback)" : "" }}</span
                ></span
              >
            </li>
          </ol>
        </details>
      </div>
    </td>
  </tr>
</template>
