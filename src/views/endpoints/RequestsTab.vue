<script setup lang="ts">
// How many requests go out at once, how long they are given, and how the text is cut up before it
// is sent — the last only for the kinds that send text: a transcriber is sent one recording a
// request, and has the first two alone. Three separate numbers are shown for concurrency because they answer different
// questions: what you configured, what is in flight, and what is actually allowed right now (zero
// while paused, cooling down, or missing a key).
//
// The split preview runs the real splitter, and checks that the pieces put back together are
// character-for-character the source — a chunking setting that quietly drops text would be the
// worst kind of bug to ship. For a scripting endpoint it also says what the piece shown is
// expected to use, with the prompt this endpoint sends and, for a model that reasons, the thinking
// its recent requests at this level were seen to spend.
import { computed, ref, watch } from "vue";
import { plural } from "@/lib/contents";
import { UiHint, UiNumber, UiSelect, UiSwitch } from "@/ui";
import NumberSlider from "@/components/NumberSlider.vue";
import { ChevronLeft as PrevIcon, ChevronRight as NextIcon, Check as OkIcon } from "@lucide/vue";
import { SPLIT_MODES, splitText } from "@/lib/split";
import { compact, opsOf } from "@/lib/endpoints";
import { isSimulated, speechProviderOf } from "@/lib/providers";
import { reasoningRequest } from "@/lib/reasoning";
import { REASONING_LEVELS, reasoningEstimateNote, tokenEstimate } from "@/lib/scripting";
import { resolvePrompt } from "@/lib/prompt";
import { money } from "@/lib/pricing";
import { useEndpointsStore } from "@/stores/endpoints";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import { SAMPLE_RATES, sampleRateLabel } from "@/lib/speech";
import { FORMAT_LABEL, encodingOf, encodingProblems, speechFormats } from "@/lib/endpointShapes";
import {
  encodingChanged,
  repairEncoding,
  sizeLabel,
  sizePerMinute,
  supportOf,
} from "@/lib/audioFormat";
import type { LiveActivity } from "@/views/endpoints/live";
import type {
  AudioFormat,
  BatchLimits,
  EndpointKind,
  ReasoningEffort,
  SampleRate,
  ScriptEndpointTelemetry,
  SplitMode,
} from "@/types";
import type { UiOption } from "@/ui/types";

const props = defineProps<{
  u: UnifiedEndpoint;
  live: LiveActivity;
  /** a real chapter when a book is open, otherwise a built-in paragraph */
  sample: string;
  sampleLabel: string;
  /** a scripting endpoint's thinking per input token at its current level, once a request said */
  reasoning?: ScriptEndpointTelemetry["reasoning"];
}>();

const endpointsStore = useEndpointsStore();

const ep = computed(() => props.u.entry);
/** what cuts its text into requests — a profile or a speech endpoint; null for a transcriber */
const cut = computed(() => props.u.profile ?? props.u.endpoint);
const ops = computed(() => opsOf(props.u));

// What differs by kind, said once per kind.
const CONCURRENCY_HINT: Record<EndpointKind, string> = {
  scripting:
    "Chunks of a chapter run in parallel up to this limit; chapters stay in order. Type any number and the slider grows to fit it.",
  tts: "Lines of a chapter run in parallel up to this limit. Type any number and the slider grows to fit it.",
  transcription:
    "Recordings are sent in parallel up to this limit. Type any number and the slider grows to fit it.",
};
const WHEN_IT_APPLIES: Record<EndpointKind, string> = {
  scripting:
    "Saved as you go. Everything here applies to the next run; a run already queued keeps the settings it started with.",
  tts: "Saved as you go. Concurrency, timeouts, retries and cutting apply to the next line; format and sample rate to the next job.",
  transcription: "Saved as you go. Everything here applies to the next recording sent.",
};
const text = ref(props.sample);
watch(
  () => props.sample,
  (s) => {
    if (!dirty.value) text.value = s;
  },
);
const dirty = ref(false);

const parts = computed(() =>
  cut.value ? splitText(text.value, cut.value.maxChars, cut.value.splitAt as SplitMode, true) : [],
);
const preserved = computed(() => parts.value.map((p) => p.text).join("") === text.value);
const at = ref(0);
watch(parts, () => {
  at.value = Math.min(at.value, Math.max(0, parts.value.length - 1));
});
const part = computed(() => parts.value[Math.min(at.value, parts.value.length - 1)]);

/**
 * What the piece shown would use as one scripting request: the prompt this endpoint sends for a
 * book without its own, and the thinking its requests at this level were seen to spend.
 */
const tokens = computed(() => {
  const p = props.u.profile;
  if (!p || !part.value?.text) return null;
  return tokenEstimate(part.value.text, p, Date.now(), {
    prompt: resolvePrompt({ library: endpointsStore.prompt, profile: p.prompt }),
    reasoningPerInputToken: props.reasoning?.perInputToken,
  });
});
const thinkingNote = computed(() =>
  props.u.profile && tokens.value && !isSimulated(props.u.baseUrl)
    ? reasoningEstimateNote(
        props.u.profile.reasoning,
        props.reasoning,
        tokens.value.reasoningTokens,
      )
    : null,
);

// ---------- batches ----------
// Only an OpenAI-compatible server can speak the batch speech API; whether this one does is asked
// of the saved endpoint whenever its address, model or key changes, and on "Check again".
const batchable = computed(
  () => props.u.endpoint && speechProviderOf(props.u.endpoint).id === "compatible",
);
const batches = ref<
  | { state: "asking" }
  | { state: "answered"; limits: BatchLimits | null }
  | { state: "failed"; error: string }
>({ state: "asking" });
async function askBatches() {
  const e = props.u.endpoint;
  if (!e || !batchable.value) return;
  batches.value = { state: "asking" };
  const answer = await endpointsStore.batchesOf(e.id);
  if (props.u.endpoint !== e) return;
  batches.value =
    "error" in answer
      ? { state: "failed", error: answer.error }
      : { state: "answered", limits: answer.limits };
}
watch(
  () => [props.u.endpoint?.id, props.u.baseUrl, props.u.endpoint?.model, props.u.endpoint?.hasKey],
  askBatches,
  { immediate: true },
);
const batchesOn = computed(() => props.u.endpoint?.batch !== false);
const batchNote = computed(() => {
  const b = batches.value;
  if (b.state === "asking") return "Asking the server…";
  if (b.state === "failed") return `Could not ask the server: ${b.error}`;
  const l = b.limits;
  if (!l) return "This server doesn't take batches; lines go one at a time.";
  const items = l.maxItems == null ? "any number of lines" : `up to ${plural(l.maxItems, "line")}`;
  if (!batchesOn.value) return `Off. The server takes ${items} a request.`;
  const atOnce =
    l.maxItems == null || props.u.concurrency < 2
      ? ""
      : ` — up to ${(l.maxItems * props.u.concurrency).toLocaleString("en")} at once`;
  return `Sending ${items} a request, the server's limit${atOnce}.`;
});

const AT_LABEL: Record<SplitMode, string> = {
  sentence: "sentence end",
  clause: "clause",
  word: "word",
  char: "hard cut",
};

// What each rate is for, in the terms someone choosing one would ask about. The model's own rate is
// the `nullValue` row above these, so it is not listed here.
const RATE_HINT: Record<SampleRate, string> = {
  16000: "speech-grade, smallest files",
  22050: "half of CD",
  24000: "what most speech models render natively",
  32000: "wideband",
  44100: "CD, and the ACX audiobook standard",
  48000: "video and broadcast",
};
/** A speech endpoint's rate; a scripting profile has none, and never shows the control. */
function setRate(v: string | number | null) {
  if (props.u.endpoint) props.u.endpoint.sampleRate = v == null ? null : (v as SampleRate);
  repairNotes.value = [];
}

// ---------- audio format ----------
// The format, bitrate and rate are one choice: which rates and bitrates exist depends on the
// format, and which formats exist depends on the API the base URL speaks. So the rate list narrows
// to the chosen format's, the bitrate list appears only for a format that has one, and switching
// format goes through `repairEncoding` — anything the new format lacks is put back to the
// provider's default and said below, rather than left for the server to refuse the next line with.
const formats = computed(() => (props.u.endpoint ? speechFormats(props.u.endpoint) : []));
const support = computed(() => (props.u.endpoint ? supportOf(props.u.endpoint) : undefined));
const encoding = computed(() => encodingOf(props.u.endpoint ?? {}));
const FORMAT_OPTIONS = computed<UiOption[]>(() =>
  formats.value.map((f) => ({
    value: f.format,
    label: FORMAT_LABEL[f.format],
    // "WAV · 16-bit PCM, mono" → the part after the name, as the row's hint
    hint: f.label.split(" · ")[1],
  })),
);
const BITRATE_OPTIONS = computed<UiOption[]>(() =>
  (support.value?.bitrates ?? []).map((b) => ({
    value: b.value,
    label: b.label,
    hint: b.value === support.value?.defaultBitrate ? "provider default" : undefined,
  })),
);
/** The rates this format may be asked for; an API that takes none offers only the model's own. */
const RATE_OPTIONS = computed<UiOption[]>(() => {
  const rates = support.value?.rates;
  if (!rates) return [];
  return SAMPLE_RATES.filter((hz) => rates.includes(hz)).map((hz) => ({
    value: hz,
    label: sampleRateLabel(hz),
    hint: RATE_HINT[hz],
  }));
});
const rateNull = computed(() =>
  support.value?.defaultRate
    ? `Provider default (${sampleRateLabel(support.value.defaultRate)})`
    : "Model default",
);
/** No rate can be asked for, and none is set — the control has nothing to offer. One that is set
 *  (saved before the format picker, or imported) stays open so it can be cleared. */
const rateLocked = computed(
  () => support.value?.rates === null && (props.u.endpoint?.sampleRate ?? null) === null,
);
const problems = computed(() => (props.u.endpoint ? encodingProblems(props.u.endpoint) : []));
const size = computed(() => (props.u.endpoint ? sizePerMinute(props.u.endpoint) : null));
/** What the last format change had to put back — shown until the next change. */
const repairNotes = ref<string[]>([]);
watch(
  () => props.u.key,
  () => (repairNotes.value = []),
);

function setFormat(v: string | number | null) {
  const ep = props.u.endpoint;
  if (!ep || v == null) return;
  const r = repairEncoding(ep, v as AudioFormat);
  if (encodingChanged(ep, r)) {
    ep.encoding = r.encoding;
    ep.sampleRate = r.sampleRate;
  }
  repairNotes.value = r.notes;
}
function setBitrate(v: string | number | null) {
  const ep = props.u.endpoint;
  if (!ep) return;
  const { format } = encodingOf(ep);
  ep.encoding = v == null ? (format === "wav" ? null : { format }) : { format, bitrate: Number(v) };
  repairNotes.value = [];
}

/** A simulated speech endpoint has no provider to be slow or to fail, so it is told how to be: how
 *  long each answer takes and what share fail. A scripting profile has neither setting. */
const simulated = computed(() =>
  props.u.endpoint && isSimulated(props.u.baseUrl) ? props.u.endpoint : null,
);

/** What the host makes of the level picked, when it can't do exactly that; a simulated profile
 *  thinks about nothing, and is not offered the choice. */
const reasoningNote = computed(() =>
  props.u.profile ? reasoningRequest(props.u.baseUrl, props.u.profile.reasoning).note : null,
);
function setReasoning(v: string | number | null) {
  if (props.u.profile) props.u.profile.reasoning = v == null ? null : (v as ReasoningEffort);
}

const limitNote = computed(() => {
  const l = props.live;
  if (l.effectiveLimit >= props.u.concurrency) return null;
  if (!props.u.enabled) return "0 — paused, so nothing new is dispatched";
  if (props.u.backoffUntil > Date.now()) return "0 — cooling down after a rate limit";
  return "0 — no credential set";
});
</script>

<template>
  <div class="grid gap-3 xl:grid-cols-2">
    <div class="space-y-3">
      <!-- concurrency -->
      <section class="card p-3">
        <NumberSlider
          v-model="ep.concurrency"
          label="Concurrency"
          :min="1"
          :initial-max="32"
          unit="requests"
        />
        <dl
          class="mt-3 grid grid-cols-3 gap-2 rounded-md bg-zinc-50 px-2.5 py-2 text-xs dark:bg-zinc-800/60"
        >
          <div>
            <dt class="text-[10px] text-zinc-500">Configured</dt>
            <dd class="font-mono">{{ u.concurrency.toLocaleString() }}</dd>
          </div>
          <div>
            <dt class="text-[10px] text-zinc-500">In flight now</dt>
            <dd class="font-mono">
              {{ live.active
              }}<span v-if="live.queued" class="text-zinc-400"> · {{ live.queued }} waiting</span>
            </dd>
          </div>
          <div>
            <dt class="text-[10px] text-zinc-500">Effective limit</dt>
            <dd class="font-mono" :class="limitNote && 'text-amber-600 dark:text-amber-400'">
              {{ limitNote ? "0" : u.concurrency.toLocaleString() }}
            </dd>
          </div>
        </dl>
        <p v-if="limitNote" class="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          {{ limitNote }}. Requests already in flight are finishing.
        </p>
        <p class="mt-1.5 text-[11px] text-zinc-500">
          Shared across every book.
          <UiHint label="concurrency" :text="CONCURRENCY_HINT[u.kind]" />
        </p>
      </section>

      <!-- batches: a compatible server that speaks the batch speech API -->
      <section v-if="batchable && u.endpoint" class="card p-3">
        <div class="flex items-center justify-between gap-3">
          <h3 class="label">
            Batches
            <UiHint
              label="batches"
              text="Many lines in one request, for a server that speaks the batch speech API. The server sets how many (omnivoice-fastapi: OMNIVOICE_MAX_BATCH_ITEMS); each batch takes one concurrency slot."
            />
          </h3>
          <UiSwitch
            :model-value="batchesOn"
            label="Send in batches"
            @update:model-value="(v) => (u.endpoint!.batch = v)"
          />
        </div>
        <p
          class="mt-1.5 text-[11px]"
          :class="
            batches.state === 'failed' ||
            (batches.state === 'answered' && batchesOn && !batches.limits)
              ? 'text-amber-700 dark:text-amber-400'
              : 'text-zinc-500'
          "
          role="status"
        >
          {{ batchNote }}
          <button
            v-if="batches.state !== 'asking'"
            type="button"
            class="ml-1 underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
            @click="askBatches"
          >
            Check again
          </button>
        </p>
      </section>

      <!-- timing -->
      <section class="card p-3">
        <h3 class="label mb-2">
          Timeouts and retries
          <UiHint
            v-if="u.kind === 'tts'"
            label="the cooldown"
            text="A rate limit holds every line on this endpoint until the cooldown ends, not only the one refused."
          />
        </h3>
        <div class="space-y-2.5 text-sm">
          <label class="flex items-center justify-between gap-3"
            ><span class="min-w-0"
              >Request timeout
              <span class="block text-[11px] text-zinc-500"
                >Give up on one request after this long.</span
              ></span
            ><UiNumber
              :model-value="ops.timeoutSec"
              @update:model-value="(v) => (ep.timeoutSec = v ?? ops.timeoutSec)"
              class="w-28 shrink-0"
              :min="5"
              :max="3600"
              :step="5"
              unit="s"
              label="Request timeout in seconds"
          /></label>
          <label class="flex items-center justify-between gap-3"
            ><span class="min-w-0"
              >Retry limit
              <span class="block text-[11px] text-zinc-500"
                >Extra attempts after the first, per request.</span
              ></span
            ><UiNumber
              :model-value="ops.maxRetries"
              @update:model-value="(v) => (ep.maxRetries = v ?? ops.maxRetries)"
              class="w-28 shrink-0"
              :min="0"
              :max="10"
              :step="1"
              unit="tries"
              label="Retry limit"
          /></label>
          <label class="flex items-center justify-between gap-3"
            ><span class="min-w-0"
              >Rate-limit cooldown
              <span class="block text-[11px] text-zinc-500"
                >How long dispatch holds off after a 429 with no Retry-After.</span
              ></span
            ><UiNumber
              :model-value="ops.cooldownSec"
              @update:model-value="(v) => (ep.cooldownSec = v ?? ops.cooldownSec)"
              class="w-28 shrink-0"
              :min="1"
              :max="600"
              :step="1"
              unit="s"
              label="Rate-limit cooldown in seconds"
          /></label>
        </div>
      </section>
    </div>

    <div v-if="cut" class="space-y-3">
      <!-- how a simulated endpoint answers -->
      <section v-if="simulated" class="card p-3">
        <h3 class="label mb-2">
          Simulated answers
          <UiHint
            label="simulated answers"
            text="Nothing is sent or billed, a failure included; both apply from the next request."
          />
        </h3>
        <div class="space-y-2.5 text-sm">
          <label class="flex items-center justify-between gap-3"
            ><span class="min-w-0"
              >Answer takes
              <span class="block text-[11px] text-zinc-500"
                >How long each request waits before its tone comes back.</span
              ></span
            ><UiNumber
              :model-value="simulated.latency"
              @update:model-value="(v) => (simulated!.latency = v ?? 0)"
              class="w-28 shrink-0"
              :min="0"
              :max="60000"
              :step="100"
              unit="ms"
              label="Answer takes, in milliseconds"
          /></label>
          <label class="flex items-center justify-between gap-3"
            ><span class="min-w-0"
              >Fails
              <span class="block text-[11px] text-zinc-500"
                >The share of requests that fail, to watch a run retry and recover.</span
              ></span
            ><UiNumber
              :model-value="Math.round(simulated.failRate * 1000) / 10"
              @update:model-value="(v) => (simulated!.failRate = (v ?? 0) / 100)"
              class="w-28 shrink-0"
              :min="0"
              :max="100"
              :step="1"
              unit="%"
              label="Fails, as a percentage of requests"
          /></label>
        </div>
      </section>

      <!-- input limits -->
      <section class="card p-3">
        <h3 class="label mb-2">Input limits</h3>
        <NumberSlider
          v-model="cut.maxChars"
          label="Maximum characters per request"
          :initial-max="u.kind === 'scripting' ? 12000 : 4096"
          unit="chars"
        />
        <p class="mt-1.5 text-[11px] text-zinc-500">
          <template v-if="u.kind === 'scripting'"
            >0 sends the whole chapter in one request.
            <UiHint
              label="the character limit"
              text="The prompt and carried context are extra input tokens on top of this."
          /></template>
          <template v-else
            >0 sends whole lines; longer ones are cut and the audio joined back together.</template
          >
        </p>
        <label class="mt-3 flex items-center justify-between gap-3 text-sm"
          ><span
            >Cut at
            <span class="block text-[11px] text-zinc-500"
              >Falls back to a finer boundary when none fits.</span
            ></span
          ><UiSelect v-model="cut.splitAt" :options="SPLIT_MODES" class="w-44 shrink-0"
        /></label>
        <div v-if="u.profile" class="mt-3">
          <NumberSlider
            v-model="u.profile.maxOutputTokens"
            label="Maximum output tokens"
            :min="1"
            :initial-max="16384"
            unit="/ request"
          />
          <p class="mt-1.5 text-[11px] text-zinc-500">
            Reserved against the budget before each request is sent.
            <UiHint
              label="max output tokens"
              text="Scripts run longer than the prose — speaker labels and directions add up — and a model’s thinking counts against this too."
            />
          </p>
          <template v-if="!isSimulated(u.baseUrl)">
            <label class="mt-3 flex items-center justify-between gap-3 text-sm"
              ><span class="min-w-0"
                >Reasoning
                <span class="block text-[11px] text-zinc-500"
                  >Thinking before the answer, billed as output tokens.</span
                ></span
              ><UiSelect
                :model-value="u.profile.reasoning ?? null"
                :options="REASONING_LEVELS"
                null-value="Model default"
                class="w-44 shrink-0"
                aria-label="Reasoning"
                @update:model-value="setReasoning"
            /></label>
            <p
              v-if="reasoningNote"
              class="mt-1.5 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
              role="status"
            >
              {{ reasoningNote }}
            </p>
          </template>
        </div>
      </section>

      <!-- audio: speech only — a chat model returns text, which has no format or rate -->
      <section v-if="u.kind === 'tts' && u.endpoint" class="card p-3">
        <h3 class="label mb-2">
          Audio
          <UiHint
            label="audio formats"
            text="MP3 and Opus are about a tenth of WAV’s size but need ffmpeg on the server to build an audiobook; rendered clips keep their format, and a rate change marks clips at another rate for re-render."
          />
        </h3>
        <div class="space-y-2.5 text-sm">
          <label class="flex items-center justify-between gap-3"
            ><span class="min-w-0"
              >Audio format
              <span class="block text-[11px] text-zinc-500"
                >What every new line is asked for and kept as.</span
              ></span
            ><UiSelect
              :model-value="encoding.format"
              :options="FORMAT_OPTIONS"
              class="w-44 shrink-0"
              aria-label="Audio format"
              @update:model-value="setFormat"
          /></label>
          <label v-if="BITRATE_OPTIONS.length" class="flex items-center justify-between gap-3"
            ><span class="min-w-0"
              >Bitrate
              <span class="block text-[11px] text-zinc-500"
                >Higher is closer to the original, and larger.</span
              ></span
            ><UiSelect
              :model-value="encoding.bitrate ?? support?.defaultBitrate ?? null"
              :options="BITRATE_OPTIONS"
              class="w-44 shrink-0"
              aria-label="Bitrate"
              @update:model-value="setBitrate"
          /></label>
          <label class="flex items-center justify-between gap-3"
            ><span class="min-w-0"
              >Sample rate
              <span class="block text-[11px] text-zinc-500">
                <template v-if="support && !support.rates"
                  >This API takes no rate — it answers at the model’s own.</template
                >
                <template v-else
                  >{{ FORMAT_LABEL[encoding.format] }} here offers
                  {{ support?.rates?.map(sampleRateLabel).join(", ") }}; the default sends
                  none.</template
                >
              </span></span
            ><UiSelect
              :model-value="u.endpoint.sampleRate ?? null"
              :options="RATE_OPTIONS"
              :null-value="rateNull"
              :disabled="rateLocked"
              class="w-44 shrink-0"
              aria-label="Sample rate"
              @update:model-value="setRate"
          /></label>
        </div>
        <p v-if="size" class="mt-2 rounded-md bg-zinc-50 px-2.5 py-1.5 text-xs dark:bg-zinc-800/60">
          <span class="font-mono">{{ size.approx ? "~" : "≈ " }}{{ sizeLabel(size.bytes) }}</span>
          <span class="text-zinc-500"> per minute of speech · {{ size.basis }}</span>
        </p>
        <p v-else class="mt-2 text-[11px] text-zinc-500">
          Size per minute unknown: this API does not say the model’s rate or bitrate.
        </p>
        <p
          v-for="n in repairNotes"
          :key="n"
          class="mt-2 rounded bg-violet-50 px-2 py-1 text-[11px] text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"
          role="status"
        >
          {{ n }}
        </p>
        <p
          v-for="p in problems"
          :key="p"
          class="mt-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
          role="alert"
        >
          {{ p }}. The server refuses a line until this is fixed.
        </p>
      </section>

      <!-- split preview -->
      <section class="card p-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 class="label">Split preview</h3>
          <span class="text-[11px] text-zinc-500"
            >{{ dirty ? "your text" : sampleLabel }} · {{ text.length.toLocaleString() }} chars →
            {{ plural(parts.length, "request") }}</span
          >
        </div>
        <textarea
          v-model="text"
          rows="3"
          class="input w-full resize-y font-serif text-xs leading-relaxed"
          aria-label="Sample text to split"
          @input="dirty = true"
        ></textarea>
        <div class="mt-2 flex items-center justify-between gap-2">
          <button
            class="btn-ghost btn-xs"
            :disabled="at <= 0"
            aria-label="Previous piece"
            @click="at = Math.max(0, at - 1)"
          >
            <PrevIcon class="icon-sm" />
          </button>
          <span class="text-[11px] text-zinc-500"
            >Piece {{ Math.min(at + 1, parts.length) }} of {{ parts.length }} ·
            {{ part?.text.length.toLocaleString() }} chars<template v-if="part?.at">
              · cut at {{ AT_LABEL[part.at] }}</template
            ><span v-if="part?.fallback" class="text-amber-600 dark:text-amber-400">
              (no {{ AT_LABEL[cut.splitAt as SplitMode] }} in range)</span
            ></span
          >
          <button
            class="btn-ghost btn-xs"
            :disabled="at >= parts.length - 1"
            aria-label="Next piece"
            @click="at++"
          >
            <NextIcon class="icon-sm" />
          </button>
        </div>
        <pre
          class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 font-serif text-xs leading-relaxed dark:bg-zinc-950/50"
          >{{ part?.text }}</pre>
        <p v-if="tokens" class="mt-2 text-[11px] text-zinc-500">
          ~{{ tokens.inputTokens.toLocaleString() }} input + ~{{
            tokens.outputTokens.toLocaleString()
          }}
          output tokens · {{ money(tokens.cost) }} for this piece, with this endpoint’s prompt
          <span v-if="thinkingNote" class="block text-zinc-400">{{ thinkingNote }}</span>
        </p>
        <p
          class="mt-2 text-[11px]"
          :class="preserved ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600'"
        >
          <OkIcon v-if="preserved" class="icon-sm" />
          <template v-if="preserved"
            >All {{ text.length.toLocaleString() }} characters preserved, whitespace
            included.</template
          >
          <template v-else
            >The pieces do not rejoin to the source — a bug, please report it.</template
          >
        </p>
      </section>
    </div>

    <!-- when it applies: a queued run keeps its snapshot; a line is dispatched on what is saved now -->
    <p class="text-[11px] text-zinc-500 xl:col-span-2">{{ WHEN_IT_APPLIES[u.kind] }}</p>
  </div>
</template>
