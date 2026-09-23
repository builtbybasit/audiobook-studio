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
import { UiNumber, UiSelect, UiTooltip } from "@/ui";
import NumberSlider from "@/components/NumberSlider.vue";
import { ChevronLeft as PrevIcon, ChevronRight as NextIcon, Check as OkIcon } from "@lucide/vue";
import { SPLIT_MODES, splitText } from "@/lib/split";
import { compact, opsOf } from "@/lib/endpoints";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import { SAMPLE_RATES, sampleRateLabel } from "@/lib/speech";
import { isBackend } from "@/services/mode";
import type { LiveActivity } from "@/views/endpoints/live";
import type { SampleRate, SplitMode } from "@/types";
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
const RATE_OPTIONS: UiOption[] = SAMPLE_RATES.map((hz) => ({
  value: hz,
  label: sampleRateLabel(hz),
  hint: RATE_HINT[hz],
}));
/** A speech endpoint's rate; a scripting profile has none, and never shows the control. */
function setRate(v: string | number | null) {
  if (props.u.endpoint) props.u.endpoint.sampleRate = v == null ? null : (v as SampleRate);
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
        <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
          The cooldown is live: the simulated transport uses it the next time this endpoint is rate
          limited. The timeout and retry limit are recorded and exported with your settings, but the
          prototype’s transport doesn’t enforce them — a backend would.
        </p>
      </section>
    </div>

    <div class="space-y-3">
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
        </div>
      </section>

      <!-- sample rate: speech only — a chat model returns text, which has no rate -->
      <section v-if="u.kind === 'tts' && u.endpoint" class="card p-3">
        <label class="flex items-center justify-between gap-3 text-sm"
          ><span class="min-w-0"
            >Sample rate
            <span class="block text-[11px] text-zinc-500"
              >Model default sends no rate; the clip records what came back.</span
            ></span
          ><UiSelect
            :model-value="u.endpoint.sampleRate ?? null"
            :options="RATE_OPTIONS"
            null-value="Model default"
            class="w-44 shrink-0"
            @update:model-value="setRate"
        /></label>
        <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
          Changing it marks clips rendered at another rate as needing a re-render — one audiobook
          file can only hold one rate.
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
          <dd class="text-zinc-500">
            Pause and resume, and concurrency — the dispatcher reads them before every request, so
            lowering concurrency mid-run just narrows the next batch.
            <template v-if="u.kind === 'tts'">
              Character limit and cut boundary too: each line is split as it goes out.</template
            >
          </dd>
        </div>
        <div class="flex gap-2">
          <dt class="w-24 shrink-0 font-medium text-violet-600 dark:text-violet-400">Next job</dt>
          <dd class="text-zinc-500">
            <template v-if="u.kind === 'scripting'"
              >Base URL, model, chunking, output ceiling and prices. A queued job carries a snapshot
              of all of these, so a run finishes on the settings it started with and its recorded
              cost stays honest.</template
            >
            <template v-else
              >Base URL, model, sample rate and prices. Clips already rendered keep the model, rate
              and cost they were recorded with.</template
            >
          </dd>
        </div>
      </dl>
      <p v-if="isBackend" class="mt-2 text-[11px] text-zinc-500">
        Saved to the server a moment after each change, and read by the next line it sends.
      </p>
      <p v-else class="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500">
        <UiTooltip
          text="Nothing on this page is written to disk: reload and it is back to the seeded configuration."
        >
          <span class="cursor-help underline decoration-dotted underline-offset-2"
            >Settings live in memory for this session only.</span
          >
        </UiTooltip>
      </p>
    </section>
  </div>
</template>
