<script setup lang="ts">
// What this endpoint charges right now, why, and when that changes.
//
// The compact line is the headline — "Input: $0.50 / 1M tokens · 50% promotion applied · ends
// tomorrow" — and the table under it is the working: base, what the schedule made it, what a
// promotion made it. Every step is shown because the question people actually have is not "what is
// the price" but "why is it that, and is it about to move".
//
// `components` says which rows this endpoint has — the four token rates, or the one speech rate —
// and `unit` says what the speech rate is written in, since that endpoint may bill per character,
// per token, per audio minute or per request.
import { computed } from "vue";
import { UiTooltip } from "@/ui";
import { Clock as ClockIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import {
  COMPONENT_HINT,
  COMPONENT_LABEL,
  componentLine,
  money,
  rateSuffix,
  rateWithUnit,
} from "@/lib/pricing";
import { stamp, whenPhrase } from "@/lib/wallClock";
import type { PricingSnapshot, RateComponent, TtsBillingUnit } from "@/types";

const props = defineProps<{
  snapshot: PricingSnapshot;
  now: number;
  /** which rows this endpoint has: `TOKEN_COMPONENTS` or `SPEECH_COMPONENTS` */
  components: RateComponent[];
  /** the unit a speech rate is written in; absent on a token card */
  unit?: TtsBillingUnit;
}>();

/** A token component with no rate of its own is not a row: it says where it is charged instead.
 *  The speech row is always shown, because an endpoint with no known rate is the case that most
 *  needs saying out loud. */
const rows = computed(() =>
  props.components
    .map((c) => ({ c, e: props.snapshot.components[c] }))
    .filter((r) => r.e.base != null || ["input", "output", "speech"].includes(r.c)),
);

const moved = (c: RateComponent) => props.snapshot.components[c].why.length > 0;
const suffix = (c: RateComponent) => rateSuffix(c, props.unit);
</script>

<template>
  <div class="space-y-2">
    <!-- the headline: one line per component, in the form the endpoint card uses too -->
    <ul class="space-y-1">
      <li
        v-for="r in rows"
        :key="r.c"
        class="flex flex-wrap items-baseline gap-x-1.5 text-xs"
        :class="moved(r.c) && 'font-medium'"
      >
        <UiTooltip :text="COMPONENT_HINT[r.c]">
          <span class="cursor-help underline decoration-dotted underline-offset-2">{{
            COMPONENT_LABEL[r.c]
          }}</span> </UiTooltip
        ><span class="font-mono">{{
          r.e.rate == null ? "—" : rateWithUnit(r.e.rate, r.c, unit)
        }}</span>
        <template v-if="r.e.rate == null"
          ><span class="text-[11px] text-amber-700 dark:text-amber-400">
            <template v-if="r.c === 'speech'"
              >no rate set — requests are counted but never priced</template
            >
            <template v-else>no separate rate — charged as ordinary input</template>
          </span></template
        >
        <template v-else-if="moved(r.c)">
          <span
            v-for="why in r.e.why"
            :key="why"
            class="rounded bg-violet-500/10 px-1.5 text-[11px] text-violet-700 dark:text-violet-300"
            >{{ why }}</span
          >
          <s class="font-mono text-[11px] text-zinc-400">{{ money(r.e.base ?? 0) }}</s>
        </template>
        <span v-else class="text-[11px] text-zinc-500">card rate</span>
      </li>
    </ul>

    <!-- when it changes next -->
    <p
      v-if="snapshot.next"
      class="flex items-start gap-1.5 rounded bg-zinc-50 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300"
    >
      <ClockIcon class="icon-sm mt-0.5 shrink-0" />
      <span
        ><b>{{ snapshot.next.label }}</b>
        {{ whenPhrase(snapshot.next.at, now, snapshot.timezone) }} —
        {{ stamp(snapshot.next.at, snapshot.timezone) }} ({{ snapshot.timezone }}). Requests that
        land after it are charged at the new rates; requests already recorded keep theirs.</span
      >
    </p>
    <p v-else class="text-[11px] text-zinc-500">
      Nothing scheduled changes these rates in the next fortnight.
    </p>

    <p
      v-if="!snapshot.timezoneOk"
      class="flex items-start gap-1.5 rounded bg-amber-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
    >
      <WarnIcon class="icon-sm mt-0.5 shrink-0" />
      <span
        >“{{ snapshot.timezone }}” is not a timezone this browser knows, so the schedule is being
        read in UTC. Pick one that is, or the windows are not the hours you think they are.</span
      >
    </p>

    <!-- the working -->
    <table class="w-full text-[11px]">
      <thead class="text-zinc-500">
        <tr>
          <th class="pb-1 text-left font-normal">Component</th>
          <th class="pb-1 text-right font-normal">Card rate</th>
          <th class="pb-1 text-right font-normal">After schedule</th>
          <th class="pb-1 text-right font-normal">After promotion</th>
          <th class="pb-1 pl-3 text-left font-normal">Why</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.c" class="border-t border-zinc-100 dark:border-zinc-800">
          <td class="py-1">
            {{ COMPONENT_LABEL[r.c] }}
            <span class="text-zinc-400">{{ suffix(r.c) }}</span>
          </td>
          <td class="py-1 text-right font-mono text-zinc-500">
            {{ r.e.base == null ? "—" : money(r.e.base) }}
          </td>
          <td
            class="py-1 text-right font-mono"
            :class="r.e.scheduled !== r.e.base && 'text-violet-600 dark:text-violet-400'"
          >
            {{ r.e.scheduled == null ? "—" : money(r.e.scheduled) }}
          </td>
          <td
            class="py-1 text-right font-mono"
            :class="r.e.rate !== r.e.scheduled && 'text-emerald-600 dark:text-emerald-400'"
          >
            {{ r.e.rate == null ? "—" : money(r.e.rate) }}
          </td>
          <td class="py-1 pl-3 text-zinc-500">
            {{ r.e.why.join(" → ") || "nothing applies" }}
          </td>
        </tr>
      </tbody>
    </table>

    <p
      v-if="snapshot.shadowed.length"
      class="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400"
    >
      <WarnIcon class="icon-sm" />
      {{ snapshot.shadowed.map((p) => `“${p.label}”`).join(", ")
      }}{{
        snapshot.shadowed.length === 1
          ? " is running but does not apply"
          : " are running but do not apply"
      }}: another promotion makes every rate
      {{ snapshot.shadowed.length === 1 ? "it covers" : "they cover" }} cheaper, and discounts do
      not stack.
    </p>

    <p class="sr-only">{{ rows.map((r) => componentLine(snapshot, r.c, now, unit)).join(". ") }}</p>
  </div>
</template>
