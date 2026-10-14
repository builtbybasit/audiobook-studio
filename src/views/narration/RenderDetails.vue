<script lang="ts">
import type { Segment } from "@/types";

/** Is there an audit trail to open? The row and the `i` key both ask this. */
export const hasDetails = (s: Segment): boolean => !!(s.audio.at || s.audio.error || s.audio.cuts);
</script>

<script setup lang="ts">
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";

// One clip's audit trail. Every fact comes off the clip itself, never re-derived from the book.
import { errorStatus, lineLink, onClip, useJob } from "@/views/narration/shared";
import { hhmm } from "@/lib/format";
import { sanitize } from "@/lib/endpoints";
import { sampleRateLabel, secs } from "@/lib/speech";
import { usePlayer } from "@/composables/usePlayer";
import {
  Pause as PauseIcon,
  PencilLine as EditIcon,
  Play as PlayIcon,
  Scissors as CutIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import type { Take } from "@/types";

const props = defineProps<{ bookId: string; chapterId: number; segment: Segment }>();
/** the ledger owns every run entry point */
defineEmits<{ retry: [] }>();
const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();
const { chapter, epName, drift } = useJob(props);
const { play } = usePlayer();
const AT = { sentence: "sentence", clause: "clause", word: "word", char: "hard cut" };
/**
 * What the clip recorded about the request that made it, as JSON. The request body is not
 * recorded, so none is invented here; the endpoint's Activity tab has the requests.
 */
function clipRecord(s: Segment) {
  const a = s.audio;
  return JSON.stringify(
    {
      line: s.id,
      chapter: props.chapterId,
      speaker: s.speaker,
      status: a.status,
      endpoint: { id: a.endpoint, name: epName(a.endpoint) },
      model: a.model,
      voice: a.voice,
      sent: {
        text: a.pronounced ?? a.said ?? a.text,
        instructions: a.instructions,
        expressions: a.expressions,
        type: a.type,
      },
      parts: a.parts,
      cuts: a.cuts,
      sampleRate: a.sampleRate,
      rendered: a.at ? new Date(a.at).toISOString() : undefined,
      tookMs: a.ms || undefined,
      durationSeconds: a.duration || undefined,
      charge: a.charge,
      error: a.error
        ? {
            status: a.error.code || null,
            message: a.error.message,
            body: a.error.body ? sanitize(a.error.body) : undefined,
            part: a.error.part,
            at: a.error.at ? new Date(a.error.at).toISOString() : undefined,
          }
        : undefined,
    },
    null,
    2,
  );
}
async function copyRecord(s: Segment) {
  try {
    await navigator.clipboard.writeText(clipRecord(s));
    uiStore.toast("Clip record copied as JSON", {
      kind: "success",
      description: "What the clip recorded about its request. No API key is included.",
      timeout: 2500,
    });
  } catch {
    uiStore.toast("Could not copy the clip record", { kind: "error" });
  }
}
/** The audit trail as labelled facts; free-text ones (style, direction) go last, full width. */
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
    // the rate the file came back at, not the one asked for; absent when not recorded
    ...(a.sampleRate ? [{ label: "sample rate", value: sampleRateLabel(a.sampleRate) }] : []),
    { label: "read as", value: a.type ?? s.type },
    { label: "rendered", value: hhmm(a.at) },
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
  `${endpointsStore.voiceLabel(t.voiceRef) || t.voice || "—"} · ${t.direction || "no direction"} · ${t.at ? hhmm(t.at) : ""}`;
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
              :to="lineLink({ bookId, chapterId }, segment)"
              class="text-violet-500 hover:underline"
              title="open this line in the reader"
              @click.stop
            >
              <EditIcon class="icon-sm" /> edit line
            </RouterLink>
            <button
              class="text-violet-500 hover:underline"
              title="what this clip recorded about the request that made it, as JSON — the provider's own requests are on the endpoint's Activity tab"
              @click.stop="copyRecord(segment)"
            >
              copy clip record
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
            <b class="text-red-600">{{ errorStatus(segment.audio.error) }}</b
            ><span class="min-w-0 flex-1">{{ segment.audio.error.message }}</span
            ><span v-if="segment.audio.error.at" class="text-zinc-400">{{
              hhmm(segment.audio.error.at)
            }}</span>
          </div>
          <pre
            v-if="segment.audio.error.body"
            class="mt-1 max-h-16 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-1.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
            >{{ sanitize(segment.audio.error.body) }}</pre>
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
