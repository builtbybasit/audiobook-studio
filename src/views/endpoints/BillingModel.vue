<script setup lang="ts">
// How a speech endpoint bills, and what that makes one request cost.
//
// Three things this panel has to get right, because each of them is a way a cost display starts
// lying:
//
//   1. Only the fields this model actually uses are on screen. A per-request endpoint has no
//      character rate and a per-character one has no audio-token rate; offering them invites
//      somebody to fill one in and wonder why it changes nothing.
//   2. Blank is not zero. A rate nobody has typed in is unknown, and requests through the endpoint
//      are then counted and never priced. Zero is a real answer — a model you host yourself — and
//      the two read differently everywhere.
//   3. Changing the model never reinterprets a rate. $15 per million characters is not $15 per
//      million audio tokens, so switching parks the old rates rather than carrying them across, and
//      switching back restores them instead of asking for them again.
import { computed } from "vue";
import { UiNumber, UiSelect, UiSwitch } from "@/ui";
import { TriangleAlert as WarnIcon } from "@lucide/vue";
import {
  BILLING_UNITS,
  COMPONENT_HINT,
  COMPONENT_LABEL,
  DEFAULT_AUDIO_TOKENS_PER_SECOND,
  audioTokensPerSecondOf,
  billableChars,
  billingUnitLabel,
  billsAudioTokens,
  chargeLabel,
  componentAmount,
  effectiveRates,
  maybeMoney,
  measureSpeech,
  money,
  quantityFor,
  rateSuffix,
  readPricing,
  speechComponents,
  speechRates,
  switchBillingUnit,
  utf8Bytes,
} from "@/lib/pricing";
import type { Endpoint, TtsBilling, TtsBillingUnit } from "@/types";

const props = defineProps<{ endpoint: Endpoint; billing: TtsBilling; now: number }>();

/**
 * The sample the preview is worked out from.
 *
 * Non-ASCII on purpose: a preview over plain English would show the byte count equalling the
 * character count and quietly teach the wrong thing about the one model whose whole point is that
 * they differ.
 */
const SAMPLE = "“时候到了,” the elder said, and did not look up from his scroll.";

const components = computed(() => speechComponents(props.billing.unit));
const snapshot = computed(() =>
  effectiveRates(
    speechRates(props.billing),
    readPricing(props.endpoint),
    props.now,
    props.billing.unit,
  ),
);

const emit = defineEmits<{ update: [TtsBilling] }>();
const patch = (over: Partial<TtsBilling>) => emit("update", { ...props.billing, ...over });

/** Switching model parks the old rates rather than reinterpreting them — see `switchBillingUnit`. */
const setUnit = (unit: TtsBillingUnit) => emit("update", switchBillingUnit(props.billing, unit));

/** What was configured under a model this endpoint is not on right now. */
const parkedNote = computed(() => {
  const parked = props.billing.parked ?? {};
  const rows = Object.entries(parked).filter(
    ([, v]) => v && (v.rate != null || v.audioRate != null),
  );
  if (!rows.length) return "";
  return rows
    .map(([unit, v]) => `${money(v!.rate ?? 0)} ${billingUnitLabel(unit as TtsBillingUnit)}`)
    .join(", ");
});

/** Which rate field belongs to which component, so the labels and the arithmetic cannot drift. */
const fields = computed(() =>
  components.value.map((component) => ({
    component,
    label: component === "speech" ? "Rate" : COMPONENT_LABEL[component],
    hint: component === "speech" ? "" : COMPONENT_HINT[component],
    suffix: rateSuffix(component, props.billing.unit),
    value: component === "audioTokens" ? (props.billing.audioRate ?? null) : props.billing.rate,
    set: (v: number | null) =>
      component === "audioTokens" ? patch({ audioRate: v }) : patch({ rate: v }),
  })),
);

// ---------- the calculation preview ----------
//
// One line, counted exactly the way a real request is counted, then priced component by component
// at the rates in force *now* — so a discount running today shows up here and the arithmetic on
// screen is the arithmetic the receipt will show.
const preview = computed(() => {
  const seconds = 4.2;
  const units = measureSpeech({ text: SAMPLE, requests: 1, audioSeconds: seconds }, props.billing);
  const rows = components.value.map((c) => {
    const quantity = quantityFor(c, props.billing.unit, units);
    const rate = snapshot.value.components[c].rate;
    return {
      component: c,
      label: chargeLabel(c, props.billing.unit),
      quantity,
      quantityLabel: quantityLabel(c, quantity),
      rate,
      amount: componentAmount(c, props.billing.unit, quantity, rate),
    };
  });
  const known = rows.every((r) => r.amount != null);
  return {
    units,
    rows,
    total: known ? rows.reduce((n, r) => n + (r.amount ?? 0), 0) : null,
    seconds,
  };
});

function quantityLabel(c: string, quantity: number): string {
  if (c === "textTokens") return `${Math.round(quantity).toLocaleString()} text tokens`;
  if (c === "audioTokens") return `${Math.round(quantity).toLocaleString()} audio tokens`;
  switch (props.billing.unit) {
    case "chars":
      return `${Math.round(quantity).toLocaleString()} characters`;
    case "bytes":
      return `${Math.round(quantity).toLocaleString()} UTF-8 bytes`;
    case "minute":
      return `${quantity.toFixed(2)} audio minutes`;
    default:
      return `${Math.round(quantity).toLocaleString()} requests`;
  }
}

const sampleChars = billableChars(SAMPLE);
const sampleBytes = utf8Bytes(SAMPLE);

const unknownRate = computed(() => props.billing.rate == null);
const halfConfigured = computed(
  () =>
    billsAudioTokens(props.billing.unit) &&
    props.billing.rate != null &&
    (props.billing.audioRate ?? null) == null,
);
const free = computed(() => components.value.every((c) => snapshot.value.components[c].rate === 0));
</script>

<template>
  <div class="space-y-3">
    <!-- the model. Everything below it depends on this one choice, so it leads. -->
    <div class="grid gap-3 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
      <label class="space-y-1 text-xs font-medium"
        ><span>Billing model</span>
        <UiSelect
          :model-value="billing.unit"
          :options="BILLING_UNITS"
          class="w-full"
          @update:model-value="(v) => setUnit(v as TtsBillingUnit)"
        />
        <span class="block text-[11px] font-normal leading-relaxed text-zinc-500">{{
          BILLING_UNITS.find((b) => b.value === billing.unit)?.hint
        }}</span></label
      >
      <div class="space-y-2">
        <!-- one field per component this model prices, and no others -->
        <label v-for="f in fields" :key="f.component" class="block space-y-1 text-xs font-medium"
          ><span>{{ f.label }}</span>
          <UiNumber
            :model-value="f.value"
            class="w-full"
            prefix="$"
            :unit="f.suffix"
            :min="0"
            :step="f.component === 'audioTokens' ? 1 : 0.5"
            :empty="null"
            placeholder="not known"
            :label="f.label"
            @update:model-value="f.set"
          />
          <span v-if="f.hint" class="block text-[11px] font-normal leading-relaxed text-zinc-500">{{
            f.hint
          }}</span></label
        >
      </div>
    </div>

    <!-- the audio-token conversion: an assumption, so it is editable and labelled as one -->
    <div
      v-if="billsAudioTokens(billing.unit)"
      class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800"
    >
      <label class="flex flex-wrap items-center justify-between gap-3 text-xs font-medium"
        ><span>Audio tokens per second</span>
        <UiNumber
          :model-value="audioTokensPerSecondOf(billing)"
          class="w-32"
          unit="tok / s"
          :min="1"
          :step="1"
          label="Audio tokens per second of generated audio"
          @update:model-value="
            (v) => patch({ audioTokensPerSecond: v ?? DEFAULT_AUDIO_TOKENS_PER_SECOND })
          "
      /></label>
      <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
        Audio tokens don’t follow from the text — they follow the length of the recording — so an
        estimate has to go through the audio’s expected duration and this conversion. It is
        <b>an assumption about your provider’s tokeniser</b>, not something this app can measure:
        set it from their documentation. It is used for estimates and for any completed request
        whose response didn’t report a token count; where the provider does report one, that number
        is used instead and the receipt says so.
      </p>
    </div>

    <!-- instructions: submitted content, so a provider that meters what it receives meters these -->
    <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
      <UiSwitch
        :model-value="billing.billsInstructions ?? true"
        label="Voice instructions sent with the line are billable"
        @update:model-value="(v) => patch({ billsInstructions: v })"
      />
      <p class="mt-1 text-[11px] leading-relaxed text-zinc-500">
        A character’s style and a line’s direction go over the wire with the text. Most providers
        meter what they receive; a few ignore the instructions field entirely. Off, they are still
        sent and still recorded — they are simply left out of the billable count.
      </p>
    </div>

    <!-- what the rates make one request cost. The working, not just the answer. -->
    <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
      <div class="mb-1 flex items-baseline justify-between gap-2">
        <span class="text-xs font-medium">One line, at these rates</span>
        <span class="text-[10px] uppercase tracking-wider text-zinc-400">worked example</span>
      </div>
      <p class="mb-1.5 font-mono text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">
        {{ SAMPLE }}
      </p>
      <p class="mb-2 text-[11px] leading-relaxed text-zinc-500">
        {{ sampleChars }} characters · <b>{{ sampleBytes }} UTF-8 bytes</b> · ~{{
          preview.units.textTokens
        }}
        text tokens · {{ preview.seconds }}s of audio<span v-if="preview.units.audioTokens != null">
          · ~{{ preview.units.audioTokens }} audio tokens</span
        >. The same line, counted four ways — only the one this model bills on is charged.
      </p>
      <table class="w-full text-[11px]">
        <tbody>
          <tr
            v-for="r in preview.rows"
            :key="r.component"
            class="border-t border-zinc-100 dark:border-zinc-800"
          >
            <td class="py-1">{{ r.label }}</td>
            <td class="py-1 text-right font-mono text-zinc-500">{{ r.quantityLabel }}</td>
            <td class="py-1 text-right font-mono text-zinc-500">
              ×
              {{
                r.rate == null
                  ? "unknown"
                  : money(r.rate) + " " + rateSuffix(r.component, billing.unit)
              }}
            </td>
            <td class="py-1 text-right font-mono">{{ maybeMoney(r.amount) }}</td>
          </tr>
          <tr class="border-t border-zinc-200 font-medium dark:border-zinc-700">
            <td class="py-1" colspan="3">
              {{ preview.rows.length > 1 ? "Input cost + audio cost" : "Total" }}
            </td>
            <td class="py-1 text-right font-mono">{{ maybeMoney(preview.total) }}</td>
          </tr>
        </tbody>
      </table>
      <p
        v-if="snapshot.window || snapshot.applied.length"
        class="mt-1.5 text-[11px] leading-relaxed text-violet-600 dark:text-violet-400"
      >
        At the rates in force right now, not the card rates:
        {{
          [snapshot.window?.label, ...snapshot.applied.map((p) => p.label)]
            .filter(Boolean)
            .join(" → ")
        }}.
      </p>
      <p v-if="preview.total != null" class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
        A 2,000-line chapter of this length would be about
        <b class="font-mono">{{ money(preview.total * 2000) }}</b> at today’s rates.
      </p>
    </div>

    <!-- what was configured under another model, kept rather than thrown away -->
    <p v-if="parkedNote" class="text-[11px] leading-relaxed text-zinc-500">
      Rates kept from another billing model: {{ parkedNote }}. They are not applied and never
      reinterpreted — switch back to that model and they return. Requests already recorded keep the
      model and the rates they were charged under, whatever you change here.
    </p>

    <p
      v-if="halfConfigured"
      class="rounded bg-amber-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
    >
      <WarnIcon class="icon-sm" /> This model bills the text and the audio separately and only the
      text rate is set. Knowing half a price is not half an answer: requests are recorded with an
      <b>unknown</b> cost until both rates are filled in.
    </p>
    <p
      v-else-if="unknownRate"
      class="rounded bg-amber-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
    >
      <WarnIcon class="icon-sm" /> No rate set. Requests through this endpoint are recorded with an
      <b>unknown</b> cost: counted, never priced, and excluded from every total on this page — so
      those totals are floors, not the full bill. Leave it blank only if you genuinely don’t know
      the rate; enter <b>0</b> for a model you host yourself.
    </p>
    <p
      v-else-if="free"
      class="rounded bg-zinc-100 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300"
    >
      Zero, not unknown: this endpoint is treated as <b>free</b> and its requests are priced at
      $0.00 rather than left unpriced. Right for a model you host yourself, wrong if the provider
      bills you.
    </p>
  </div>
</template>
