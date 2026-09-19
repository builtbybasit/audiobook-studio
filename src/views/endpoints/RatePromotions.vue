<script setup lang="ts">
// Temporary price changes: "50% off this model until Friday".
//
// Three states, kept apart on screen because they mean different things: **running** (applying
// now), **scheduled** (has a start date in the future, applying to nothing yet) and **ended** (kept
// as history, applying to nothing ever again). An expired promotion is never deleted by the app —
// it stops applying on its own, and the requests it priced keep the rates they were charged at.
//
// Promotions do not stack. Where two of them cover the same component, only the one that makes it
// cheapest applies; the other is shown as outranked rather than silently ignored.
import { computed } from "vue";
import { UiNumber, UiSelect } from "@/ui";
import { Plus as AddIcon, Trash2 as RemoveIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import {
  COMPONENT_LABEL,
  SCOPE_LABEL,
  scopeActive,
  effectiveRates,
  money,
  promotionExpired,
  promotionPending,
  promotionRunning,
  rateSuffix,
  rateWithUnit,
} from "@/lib/pricing";
import {
  calendarDay,
  endOfDay,
  endOfDayAfter,
  stamp,
  startOfDay,
  whenPhrase,
} from "@/lib/wallClock";
import type {
  PricingConfig,
  PricingSnapshot,
  Promotion,
  PromotionScope,
  RateComponent,
  RateSet,
  TtsBillingUnit,
} from "@/types";

const props = defineProps<{
  config: PricingConfig;
  base: RateSet;
  snapshot: PricingSnapshot;
  now: number;
  /** the components this endpoint prices — the four token rates, or the one speech rate */
  components: RateComponent[];
  /** the unit a speech rate is written in; absent on a token card */
  unit?: TtsBillingUnit;
}>();

/**
 * The scopes worth offering. A speech endpoint has one rate, so "whole model" and "speech rate" say
 * the same thing and only the first is shown — an option that cannot change the outcome is a
 * question nobody should have to answer.
 */
const SCOPES = computed<{ value: PromotionScope; label: string }[]>(() =>
  props.components.length < 2
    ? [{ value: "model", label: SCOPE_LABEL.model }]
    : [
        { value: "model", label: SCOPE_LABEL.model },
        ...props.components.map((c) => ({ value: c as PromotionScope, label: SCOPE_LABEL[c] })),
      ],
);

/** Running, scheduled and ended are three different things, so they are three different lists. */
const groups = computed(() => [
  {
    title: "Running now",
    rows: props.config.promotions.filter((p) => promotionRunning(p, props.now)),
  },
  {
    title: "Scheduled",
    rows: props.config.promotions.filter((p) => promotionPending(p, props.now)),
  },
  {
    title: "Ended — kept as history",
    rows: props.config.promotions.filter((p) => promotionExpired(p, props.now)),
  },
]);

const applied = (p: Promotion) => props.snapshot.applied.some((x) => x.id === p.id);
const shadowed = (p: Promotion) => props.snapshot.shadowed.some((x) => x.id === p.id);

/**
 * `<input type="date">` wants a yyyy-mm-dd, and the day it names is a day **where the endpoint is
 * billed** — the timezone the schedule, the "ends tomorrow" line and every other date on this page
 * are already read in. Reading it in the browser's zone instead moves a New York promotion's start
 * or end onto another calendar day when it is edited from Karachi.
 */
const dateValue = (at: number | null): string =>
  at == null ? "" : calendarDay(at, props.config.timezone);

function setDate(p: Promotion, field: "from" | "until", text: string) {
  if (!text) {
    p[field] = null;
    return;
  }
  // a start begins at midnight, an end runs to the last moment of the day it names
  const at =
    field === "from"
      ? startOfDay(text, props.config.timezone)
      : endOfDay(text, props.config.timezone);
  if (at != null) p[field] = at;
}

function addPromotion() {
  props.config.promotions.push({
    id: "promo" + Date.now(),
    label: "New promotion",
    from: null,
    until: endOfDayAfter(props.now, props.config.timezone, 7),
    scope: ["model"],
    percent: 50,
  });
}
function remove(p: Promotion) {
  const i = props.config.promotions.findIndex((x) => x.id === p.id);
  if (i >= 0) props.config.promotions.splice(i, 1);
}
function setKind(p: Promotion, kind: "percent" | "rates") {
  if (kind === "percent") {
    delete p.rates;
    p.percent ??= 50;
  } else {
    delete p.percent;
    p.rates ??= Object.fromEntries(
      props.components.filter((c) => props.base[c] != null).map((c) => [c, props.base[c]]),
    );
  }
}
const kindOf = (p: Promotion): "percent" | "rates" => (p.rates ? "rates" : "percent");
function toggleScope(p: Promotion, scope: PromotionScope) {
  if (scope === "model") {
    p.scope = ["model"];
    return;
  }
  const next = p.scope.filter((s) => s !== "model");
  const i = next.indexOf(scope);
  if (i >= 0) next.splice(i, 1);
  else next.push(scope);
  p.scope = next.length ? next : ["model"];
}

/**
 * What this promotion does to each component it covers, at today's rates.
 *
 * Priced through `effectiveRates` rather than re-derived: the owner's chain is base → scheduled →
 * promoted, so inside an active window the "from" is what the schedule already made the rate and
 * the percentage lands on *that* number. Working it off the card rate quoted a "from" this endpoint
 * is not charging and a "to" nobody would be billed — while the panel above it, reading the same
 * three steps, showed the right ones a few hundred pixels away.
 *
 * The promotion is resolved alone and with its dates dropped, so a scheduled or ended one still
 * says what it would do, and a running neighbour that outranks it does not hide it.
 */
function preview(p: Promotion): string {
  const alone = effectiveRates(
    props.base,
    { ...props.config, promotions: [{ ...p, from: null, until: null }] },
    props.now,
    props.unit,
  );
  const parts: string[] = [];
  for (const c of props.components) {
    // `scopeActive`, not membership: a `speech`-scoped promotion reaches the two token rates of a
    // token-billed endpoint, which is what the chip beside it already says it does
    if (!scopeActive(p, c, props.components)) continue;
    const { scheduled, rate } = alone.components[c];
    if (scheduled == null) continue;
    parts.push(`${COMPONENT_LABEL[c]} ${money(scheduled)} → ${rateWithUnit(rate, c, props.unit)}`);
  }
  return parts.length ? parts.join(" · ") : "nothing this endpoint prices";
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between gap-2">
      <p class="text-[11px] leading-relaxed text-zinc-500">
        A promotion applies on top of whatever the schedule left.
        <b>They do not stack</b>: where two cover the same rate, only the one that makes it cheapest
        applies. One expires on its own date — it is never deleted for you, and it never re-prices a
        request it already priced.
      </p>
      <button class="btn-ghost btn-xs shrink-0" @click="addPromotion">
        <AddIcon class="icon-sm" /> Add
      </button>
    </div>

    <p v-if="!config.promotions.length" class="text-[11px] text-zinc-500">
      No promotions. The schedule above, or the base rates, decide the price.
    </p>

    <template v-for="group in groups" :key="group.title">
      <div v-if="group.rows.length" class="space-y-1.5">
        <h4 class="label">{{ group.title }} ({{ group.rows.length }})</h4>
        <div
          v-for="p in group.rows"
          :key="p.id"
          class="rounded-md border p-2.5"
          :class="
            applied(p)
              ? 'border-emerald-400 bg-emerald-50/50 dark:border-emerald-500/60 dark:bg-emerald-500/10'
              : promotionExpired(p, now)
                ? 'border-zinc-200 bg-zinc-50 opacity-80 dark:border-zinc-800 dark:bg-zinc-900/50'
                : 'border-zinc-200 dark:border-zinc-800'
          "
        >
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <input
              v-model="p.label"
              class="input w-44 py-0.5 text-xs"
              placeholder="50% off this model"
              :aria-label="`Name of promotion ${p.id}`"
              :disabled="promotionExpired(p, now)"
            />
            <span v-if="applied(p)" class="chip chip-on">applied</span>
            <span
              v-else-if="shadowed(p)"
              class="chip chip-off text-amber-700 dark:text-amber-400"
              title="Another promotion makes every rate this one covers cheaper. Discounts do not stack, so only that one applies."
              ><WarnIcon class="icon-sm" /> outranked</span
            >
            <span v-else-if="promotionPending(p, now)" class="chip chip-off">not started</span>
            <span v-else-if="promotionExpired(p, now)" class="chip chip-off">ended</span>
            <span v-if="p.until != null" class="text-[11px] text-zinc-500">
              {{ promotionExpired(p, now) ? "ended" : "ends" }}
              {{
                promotionExpired(p, now)
                  ? stamp(p.until, config.timezone)
                  : whenPhrase(p.until, now, config.timezone)
              }}
            </span>
            <button
              class="btn-ghost btn-xs ml-auto text-red-600 dark:text-red-400"
              :aria-label="`Remove ${p.label}`"
              @click="remove(p)"
            >
              <RemoveIcon class="icon-sm" />
            </button>
          </div>

          <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <label class="flex items-center gap-1"
              ><span class="text-zinc-500">from</span>
              <input
                type="date"
                class="input py-0.5 text-xs"
                :value="dateValue(p.from)"
                :aria-label="`${p.label} start date`"
                @change="setDate(p, 'from', ($event.target as HTMLInputElement).value)"
            /></label>
            <label class="flex items-center gap-1"
              ><span class="text-zinc-500">until</span>
              <input
                type="date"
                class="input py-0.5 text-xs"
                :value="dateValue(p.until)"
                :aria-label="`${p.label} end date`"
                @change="setDate(p, 'until', ($event.target as HTMLInputElement).value)"
            /></label>
            <span class="text-[11px] text-zinc-500">
              {{ p.from == null ? "already running" : "" }}
              {{ p.until == null ? "· no end date, so it never stops applying" : "" }}
              <span v-if="p.from != null || p.until != null"
                >· dates are days in {{ config.timezone }}</span
              >
            </span>
          </div>

          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <span class="flex flex-wrap items-center gap-1">
              <span class="text-zinc-500">applies to</span>
              <button
                v-for="s in SCOPES"
                :key="s.value"
                class="rounded px-1.5 py-0.5 text-[10px]"
                :class="
                  scopeActive(p, s.value, components)
                    ? 'bg-violet-500 text-white'
                    : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800'
                "
                :aria-pressed="scopeActive(p, s.value, components)"
                @click="toggleScope(p, s.value)"
              >
                {{ s.label }}
              </button>
            </span>
          </div>

          <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <UiSelect
              :model-value="kindOf(p)"
              :options="[
                { value: 'percent', label: 'Percentage discount' },
                { value: 'rates', label: 'Replacement rates' },
              ]"
              size="xs"
              class="w-48"
              :aria-label="`How ${p.label} changes the price`"
              @update:model-value="(v) => setKind(p, v as 'percent' | 'rates')"
            />
            <UiNumber
              v-if="kindOf(p) === 'percent'"
              :model-value="p.percent ?? 0"
              class="w-24"
              unit="% off"
              :min="0"
              :max="100"
              :step="5"
              :label="`${p.label} discount`"
              @update:model-value="(v) => (p.percent = v ?? 0)"
            />
            <template v-else>
              <UiNumber
                v-for="c in components.filter(
                  (c) => scopeActive(p, c, components) && base[c] != null,
                )"
                :key="c"
                :model-value="p.rates![c] ?? base[c]"
                class="w-32"
                prefix="$"
                :unit="rateSuffix(c, unit)"
                :min="0"
                :step="0.05"
                :label="`${p.label} ${COMPONENT_LABEL[c]} rate`"
                @update:model-value="(v) => (p.rates = { ...p.rates, [c]: v ?? 0 })"
              />
            </template>
          </div>

          <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
            {{ preview(p) }}
          </p>
          <p v-if="p.note" class="mt-1 text-[11px] italic leading-relaxed text-zinc-500">
            {{ p.note }}
          </p>
        </div>
      </div>
    </template>
  </div>
</template>
