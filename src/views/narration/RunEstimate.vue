<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useNarrationStore } from "@/stores/narration";

// "This run" panel: what the current chapter selection will cost before pressing Narrate. Cost and
// request counts are per endpoint, because each speaker's voice pins its lines to one endpoint and
// long segments split against that endpoint's per-request limit.
import { computed } from "vue";
import { runSummary, SCOPE_HELP, SCOPE_LABEL, skipSummary } from "@/lib/runPlan";
import { UiSwitch, UiToggleGroup } from "@/ui";
import { TriangleAlert as WarnIcon } from "@lucide/vue";
// `money` keeps fractions of a cent visible: a two-clip run really does cost $0.000002, and
// rounding that to "$0.00" is the same lie as showing an unknown rate as free.
import { billingOf, billingUnitLabel, money } from "@/lib/endpoints";
import type { EndpointEstimate, NarrationScope } from "@/types";
// `blockers` is worked out by the view, not here: the run strip says how many there are and this
// panel lists them, and one calculation is how those two stay in agreement.
const props = defineProps<{ bookId: string; selected: number[]; blockers: string[] }>();
const scope = defineModel<NarrationScope>("scope", { default: "fill" });
const keepPending = defineModel<boolean>("keepPending", { default: true });
const castStore = useCastStore();
const narrationStore = useNarrationStore();
const est = computed(() =>
  narrationStore.estimate(props.bookId, props.selected, scope.value, keepPending.value),
);
const plan = computed(() =>
  narrationStore.narrationRunPlan(props.bookId, props.selected, scope.value, keepPending.value),
);
const scopes: { value: NarrationScope; label: string }[] = (
  ["fill", "failed", "all"] as NarrationScope[]
).map((value) => ({ value, label: SCOPE_LABEL[value] }));
const cast = computed(() => castStore.charactersOf(props.bookId));
const voiced = computed(() => cast.value.filter((c) => c.voice).length);
const expressions = computed(() =>
  narrationStore.expressionIssues(
    props.bookId,
    plan.value.chapters.map((c) => c.id),
  ),
);
const fmt = (s: number) =>
  s >= 3600
    ? `~${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
    : `~${Math.round(s / 60)}m`;
const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));

/** Only worth a row when the text is not all ASCII — that is the whole point of byte billing. */
const bytesDiffer = computed(() => est.value.units.bytes > est.value.units.chars);

/** What this endpoint's share is charged on, in that endpoint's own unit. */
function unitsLine(e: EndpointEstimate): string {
  const u = e.units;
  switch (billingOf(e.endpoint).unit) {
    case "bytes":
      return `${k(u.bytes)} bytes from ${k(u.chars)} characters`;
    case "tokens":
      return `~${k(u.textTokens ?? 0)} text tokens`;
    case "audio-tokens":
      return `~${k(u.textTokens ?? 0)} text tokens + ~${k(u.audioTokens ?? 0)} audio tokens`;
    case "minute":
      return `${(u.audioSeconds / 60).toFixed(1)} audio minutes`;
    case "request":
      return `${u.requests} requests`;
    default:
      return `${k(u.chars)} characters`;
  }
}

function rowTitle(e: EndpointEstimate): string {
  const split =
    e.audioCost != null && e.inputCost != null
      ? `input ${money(e.inputCost)} + audio ${money(e.audioCost)}. `
      : "";
  return split + (e.why.length ? e.why.join(" → ") : "at this endpoint’s card rate");
}
defineExpose({ scope, keepPending, plan });
</script>
<template>
  <div class="text-xs">
    <div class="label mb-1.5">This run</div>
    <!-- what the run is for. The estimate below counts this scope, not every line in the book. -->
    <UiToggleGroup v-model="scope" :options="scopes" block size="xs" />
    <p class="mb-2 mt-1 text-[11px] leading-snug text-zinc-500">{{ SCOPE_HELP[scope] }}</p>
    <!-- only shown when this scope actually reaches lines with a retake waiting, and shown in
         both switch positions: the count is what the choice is about, not what it left behind. -->
    <div v-if="est.pending" class="mb-2">
      <UiSwitch v-model="keepPending" label="Keep retakes waiting for a verdict" />
      <p class="mt-1 text-[11px] leading-snug text-zinc-500">
        {{
          keepPending
            ? `${est.pending} line${est.pending === 1 ? "" : "s"} this scope would render ${est.pending === 1 ? "has" : "have"} a retake to judge, and ${est.pending === 1 ? "is" : "are"} left out of this run.`
            : `${est.pending} retake${est.pending === 1 ? "" : "s"} waiting for a verdict ${est.pending === 1 ? "joins" : "join"} that line’s take list, still playable, and the line is rendered again — the clip in the book keeps playing until its replacement lands.`
        }}
      </p>
    </div>
    <div class="grid grid-cols-2 gap-x-4 gap-y-1">
      <span class="text-zinc-500">Chapters</span
      ><span class="text-right font-mono">{{ est.chapters }}</span>
      <span class="text-zinc-500">Clips to render</span
      ><span class="text-right font-mono">{{ est.segments }}</span>
      <!-- Billable characters, not the length of the chapter: the dictionary rewrites words on the
           way out, expression tags are inserted and the voice instructions travel with the request.
           The byte row sits beside it and counts the same content, so the two can be compared. -->
      <span
        class="text-zinc-500"
        title="Billable characters of what will actually be submitted — after pronunciation replacements and expression tags, plus any voice instructions. Not the length of the chapter."
        >Characters</span
      ><span class="text-right font-mono">{{ k(est.units.chars) }}</span>
      <!-- the byte count only earns a row where it differs from the character count, which is
           exactly when an endpoint that bills on bytes is going to cost more than it looks -->
      <template v-if="bytesDiffer">
        <span
          class="text-zinc-500"
          title="The same content, metered the way a byte-billed endpoint meters it. Non-ASCII text is more bytes than characters."
          >UTF-8 bytes</span
        ><span class="text-right font-mono">{{ k(est.units.bytes) }}</span>
      </template>
      <span class="text-zinc-500">Requests</span
      ><span class="text-right font-mono"
        >{{ est.requests
        }}<span
          v-if="est.split"
          class="text-amber-600"
          :title="`${est.split} segments exceed their endpoint’s per-request limit and are sent in parts`"
        >
          · {{ est.split }} split</span
        ></span
      >
      <span class="text-zinc-500">Audio</span
      ><span class="text-right font-mono">{{ est.chapters ? fmt(est.seconds) : "—" }}</span>
      <span class="text-zinc-500">Voices set</span
      ><span class="text-right font-mono">{{ voiced }}/{{ cast.length }}</span>
      <!-- input + audio = total, where anything in this run bills on the audio. Adding them into
           one number hides which half is large, and on a token-billed endpoint the audio half
           usually is. -->
      <template v-if="est.audioCost != null">
        <span class="text-zinc-500">Input text</span
        ><span class="text-right font-mono text-zinc-500">{{ money(est.inputCost) }}</span>
        <span class="text-zinc-500">Output audio</span
        ><span class="text-right font-mono text-zinc-500">{{ money(est.audioCost) }}</span>
      </template>
      <span class="text-zinc-500">Est. cost</span
      ><span class="text-right font-mono font-semibold text-amber-600"
        >{{ money(est.cost) }}<span v-if="est.unpriced" class="font-normal">+</span></span
      >
      <!-- the conservative figure sits under the headline, labelled, and is what the cap uses -->
      <template v-if="est.withoutPromotions > est.cost + 1e-9">
        <span class="text-zinc-500">Without today’s discounts</span
        ><span class="text-right font-mono text-zinc-500">{{ money(est.withoutPromotions) }}</span>
      </template>
    </div>
    <p v-if="est.unpriced" class="mt-1 leading-snug text-amber-700 dark:text-amber-400">
      {{ est.unpriced }} request{{ est.unpriced === 1 ? "" : "s" }} go to an endpoint with no rate
      set, so this is a floor rather than the bill.
    </p>
    <details v-if="est.cautions.length" class="mt-1.5 rounded bg-zinc-50 p-2 dark:bg-zinc-800/60">
      <summary class="cursor-pointer select-none text-zinc-600 dark:text-zinc-300">
        Why this is an estimate and not a price
      </summary>
      <ul class="mt-1.5 space-y-1 leading-snug text-zinc-500">
        <li v-for="why in est.cautions" :key="why">{{ why }}</li>
        <li>
          Every clip is priced when it lands, not when the run starts, so a run that crosses one of
          these boundaries is charged differently either side of it.
        </li>
      </ul>
    </details>
    <p v-if="plan.chapters.length" class="mt-1.5 leading-snug text-zinc-500">
      {{ runSummary(plan).join(" · ") }}.
      <span v-if="est.replacing"
        >{{ est.replacing }} clip{{ est.replacing === 1 ? "" : "s" }} already
        {{ est.replacing === 1 ? "plays" : "play" }} in the book — each keeps playing until its
        replacement succeeds, and the clip it displaces joins that line’s take list.</span
      >
    </p>
    <p v-if="skipSummary(plan)" class="mt-1 leading-snug text-amber-700 dark:text-amber-400">
      {{ skipSummary(plan) }}
    </p>
    <div v-if="est.per.length" class="mt-2 border-t border-zinc-100 pt-1.5 dark:border-zinc-800">
      <div class="mb-1 text-[10px] uppercase tracking-wider text-zinc-400">By endpoint</div>
      <div v-for="e in est.per" :key="e.endpoint.id" class="flex items-center gap-2 py-0.5">
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          :class="e.endpoint.enabled ? 'bg-emerald-500' : 'bg-zinc-400'"
        ></span>
        <span
          class="min-w-0 flex-1 truncate"
          :class="!e.endpoint.enabled && 'text-zinc-400 line-through'"
          >{{ e.endpoint.name }}</span
        >
        <span
          class="font-mono text-zinc-500"
          :title="`${e.segments} segments · ${e.requests} requests${e.endpoint.maxChars ? ' · limit ' + e.endpoint.maxChars : ''}`"
          >{{ e.requests }} req</span
        >
        <span
          class="w-20 text-right font-mono"
          :class="e.cost == null ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500'"
          :title="rowTitle(e)"
          >{{ e.cost == null ? "unknown" : e.cost === 0 ? "free" : money(e.cost) }}</span
        >
      </div>
      <!-- how each endpoint bills, and the split where it bills on two things. Three endpoints in
           one run can be charged on three different quantities, and the total is only readable
           once each row says which. -->
      <div
        v-for="e in est.per"
        :key="e.endpoint.id + '-unit'"
        class="pl-3.5 leading-snug text-zinc-400"
      >
        {{ e.endpoint.name }}: {{ billingUnitLabel(billingOf(e.endpoint).unit) }} ·
        {{ unitsLine(e) }}
      </div>
      <!-- what moved an endpoint off its card rate, named rather than left as a cheaper number -->
      <div
        v-for="e in est.per.filter((x) => x.why.length)"
        :key="e.endpoint.id + '-why'"
        class="mt-0.5 leading-snug text-violet-600 dark:text-violet-400"
      >
        {{ e.endpoint.name }}: {{ e.why.join(" → ") }}
      </div>
      <div v-if="est.unrouted" class="mt-0.5 text-amber-600">
        {{ est.unrouted }} segments have no endpoint (voice missing).
      </div>
    </div>
    <div v-for="b in blockers" :key="b" class="mt-2 text-amber-600">
      <WarnIcon class="icon-sm" /> {{ b }}
    </div>
    <div
      v-if="expressions.length"
      class="mt-2 rounded bg-amber-50 p-2 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
    >
      <WarnIcon class="icon-sm" /> {{ expressions.length }} expressions need review. Press Narrate
      to resolve them before any work is queued.
    </div>
  </div>
</template>
