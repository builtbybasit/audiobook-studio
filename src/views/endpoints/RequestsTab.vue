<script setup lang="ts">
// How many requests go out at once, how long they are given, and how the text is cut up before it
// is sent. Three separate numbers are shown for concurrency because they answer different
// questions: what you configured, what is in flight, and what is actually allowed right now (zero
// while paused, cooling down, or missing a key).
//
// The split preview runs the real splitter, and checks that the pieces put back together are
// character-for-character the source — a chunking setting that quietly drops text would be the
// worst kind of bug to ship.
import { computed, ref, watch } from "vue";
import { UiNumber, UiSelect } from "@/ui";
import NumberSlider from "@/components/NumberSlider.vue";
import { ChevronLeft as PrevIcon, ChevronRight as NextIcon, Check as OkIcon } from "@lucide/vue";
import { SPLIT_MODES, splitText } from "@/lib/split";
import { compact, opsOf } from "@/lib/endpoints";
import { isSimulated } from "@/lib/providers";
import { reasoningRequest } from "@/lib/reasoning";
import { REASONING_LEVELS } from "@/lib/scripting";
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
import type { AudioFormat, ReasoningEffort, SampleRate, SplitMode } from "@/types";
import type { UiOption } from "@/ui/types";

const props = defineProps<{
  u: UnifiedEndpoint;
  live: LiveActivity;
  /** a real chapter when a book is open, otherwise a built-in paragraph */
  sample: string;
  sampleLabel: string;
}>();

const ep = computed(() => (props.u.profile ?? props.u.endpoint)!);
const ops = computed(() => opsOf(props.u));
const text = ref(props.sample);
watch(
  () => props.sample,
  (s) => {
    if (!dirty.value) text.value = s;
  },
);
const dirty = ref(false);

const parts = computed(() =>
  splitText(text.value, ep.value.maxChars, ep.value.splitAt as SplitMode, true),
);
const preserved = computed(() => parts.value.map((p) => p.text).join("") === text.value);
const at = ref(0);
watch(parts, () => {
  at.value = Math.min(at.value, Math.max(0, parts.value.length - 1));
});
const part = computed(() => parts.value[Math.min(at.value, parts.value.length - 1)]);

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
        <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
          Shared across every book. Type any number — the slider’s range grows to fit it, so 2,500
          is as easy to set as 4.
          <template v-if="u.kind === 'scripting'"
            >Chunks of a chapter run in parallel; chapters stay ordered.</template
          >
          <template v-else>Lines of a chapter run in parallel up to this limit.</template>
        </p>
      </section>

      <!-- timing -->
      <section class="card p-3">
        <h3 class="label mb-2">Timeouts and retries</h3>
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
        <p v-if="u.kind === 'tts'" class="mt-2 text-[11px] leading-relaxed text-zinc-500">
          The server uses all three from the next request. A rate limit holds every line for this
          endpoint until the cooldown ends, not only the one refused.
        </p>
        <p v-else class="mt-2 text-[11px] leading-relaxed text-zinc-500">
          The server uses all three; a run keeps the ones it was queued with.
        </p>
      </section>
    </div>

    <div class="space-y-3">
      <!-- how a simulated endpoint answers -->
      <section v-if="simulated" class="card p-3">
        <h3 class="label mb-2">Simulated answers</h3>
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
        <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
          Nothing is sent anywhere and nothing is billed, a failure included. Both apply from the
          next request.
        </p>
      </section>

      <!-- input limits -->
      <section class="card p-3">
        <h3 class="label mb-2">Input limits</h3>
        <NumberSlider
          v-model="ep.maxChars"
          label="Maximum characters per request"
          :initial-max="u.kind === 'scripting' ? 12000 : 4096"
          unit="chars"
        />
        <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
          <template v-if="u.kind === 'scripting'"
            >0 sends the whole chapter in one request. Prompt and carried context are extra input
            tokens on top.</template
          >
          <template v-else
            >0 sends whole lines. Longer lines are cut, sent as several requests, and the audio
            joined back together.</template
          >
        </p>
        <label class="mt-3 flex items-center justify-between gap-3 text-sm"
          ><span
            >Cut at
            <span class="block text-[11px] text-zinc-500"
              >Falls back to a finer boundary when none fits.</span
            ></span
          ><UiSelect v-model="ep.splitAt" :options="SPLIT_MODES" class="w-44 shrink-0"
        /></label>
        <div v-if="u.profile" class="mt-3">
          <NumberSlider
            v-model="u.profile.maxOutputTokens"
            label="Maximum output tokens"
            :min="1"
            :initial-max="16384"
            unit="/ request"
          />
          <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
            The script coming back is longer than you expect — speaker labels and directions add up.
            This ceiling is also what each request reserves against the budget before it is sent.
          </p>
          <template v-if="!isSimulated(u.baseUrl)">
            <label class="mt-3 flex items-center justify-between gap-3 text-sm"
              ><span class="min-w-0"
                >Reasoning
                <span class="block text-[11px] text-zinc-500"
                  >How long a model that reasons thinks before it answers. Most hosts bill the
                  thinking as output tokens.</span
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
        <h3 class="label mb-2">Audio</h3>
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
                  {{ support?.rates?.map(sampleRateLabel).join(", ") }}. The default sends no rate;
                  the clip records what came back.</template
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
          The size per minute depends on the model’s own rate and bitrate, which this API does not
          say.
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
        <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
          MP3 and Opus are about a tenth the size of WAV. Building an audiobook from them needs
          ffmpeg on the server (<code class="font-mono">EXPORT_ENCODER=ffmpeg</code>). Clips already
          rendered keep the format they were made in; changing the rate marks clips at another rate
          as needing a re-render, since one audiobook file can only hold one rate.
        </p>
      </section>

      <!-- split preview -->
      <section class="card p-3">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 class="label">Split preview</h3>
          <span class="text-[11px] text-zinc-500"
            >{{ dirty ? "your text" : sampleLabel }} · {{ text.length.toLocaleString() }} chars →
            {{ parts.length }} request{{ parts.length === 1 ? "" : "s" }}</span
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
              (no {{ AT_LABEL[ep.splitAt as SplitMode] }} in range)</span
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
        <p
          class="mt-2 text-[11px]"
          :class="preserved ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600'"
        >
          <OkIcon v-if="preserved" class="icon-sm" />
          <template v-if="preserved"
            >All {{ text.length.toLocaleString() }} characters preserved — the pieces rejoin to the
            source exactly, whitespace included.</template
          >
          <template v-else
            >The pieces do not rejoin to the source. This is a bug — please report it.</template
          >
        </p>
      </section>
    </div>

    <!-- what applies when -->
    <section class="card p-3 xl:col-span-2">
      <h3 class="label mb-2">When these changes take effect</h3>
      <dl class="grid gap-x-6 gap-y-1.5 text-[11px] leading-relaxed sm:grid-cols-2">
        <div class="flex gap-2">
          <dt class="w-24 shrink-0 font-medium text-emerald-600 dark:text-emerald-400">
            Immediately
          </dt>
          <dd v-if="u.kind === 'scripting'" class="text-zinc-500">
            Pause and resume: a paused endpoint can’t start a run. One already queued or going
            carries on.
          </dd>
          <dd v-else class="text-zinc-500">
            Pause and resume, and concurrency — the dispatcher reads them before every request, so
            lowering concurrency mid-run just narrows the next batch. Character limit and cut
            boundary too: each line is split as it goes out.
          </dd>
        </div>
        <div class="flex gap-2">
          <dt class="w-24 shrink-0 font-medium text-violet-600 dark:text-violet-400">Next job</dt>
          <dd class="text-zinc-500">
            <template v-if="u.kind === 'scripting'"
              >Base URL, model, chunking, output ceiling, reasoning and prices, the prompt, and
              concurrency, timeouts and retries. A queued job carries a snapshot of all of these, so
              a run finishes on the settings it started with and its recorded cost stays
              honest.</template
            >
            <template v-else
              >Base URL, model, audio format, sample rate and prices. Clips already rendered keep
              the model, format, rate and cost they were recorded with.</template
            >
          </dd>
        </div>
      </dl>
      <p class="mt-2 text-[11px] text-zinc-500">
        Saved to the server a moment after each change, and read by the next
        {{ u.kind === "tts" ? "line" : "run" }} it sends.
      </p>
    </section>
  </div>
</template>
