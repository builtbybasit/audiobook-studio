<script setup lang="ts">
// The peak/off-peak schedule: a timezone, and recurring windows in the order they are tried.
//
// Two things this has to get right, because they are the two that are wrong everywhere else:
//
//   · the timezone is explicit and shown, never the browser's assumed one silently
//   · a window whose end is at or before its start runs *past midnight*, and says so — the day list
//     then names the day the window starts on, so Fri 22:00–02:00 is Friday night, not Friday dawn
//
// Windows never stack: the first one in this list that covers the moment wins, and the list can be
// reordered, so precedence is something you can see rather than something you have to derive.
import { computed } from "vue";
import { UiNumber, UiSelect, UiTooltip } from "@/ui";
import {
  ChevronDown as DownIcon,
  ChevronUp as UpIcon,
  Plus as AddIcon,
  Trash2 as RemoveIcon,
} from "@lucide/vue";
import {
  COMPONENT_LABEL,
  DAY_SHORT,
  clockLabel,
  crossesMidnight,
  localClock,
  money,
  parseClock,
  rateSuffix,
  rateWithUnit,
  timezoneValid,
  windowCovers,
} from "@/lib/pricing";
import type { PricingConfig, RateComponent, RateSet, RateWindow, TtsBillingUnit } from "@/types";

const props = defineProps<{
  config: PricingConfig;
  base: RateSet;
  now: number;
  /** the components this endpoint prices — the four token rates, or the one speech rate */
  components: RateComponent[];
  /** the unit a speech rate is written in; absent on a token card */
  unit?: TtsBillingUnit;
}>();

/** The rates an explicit-rate window can set: only what this endpoint actually prices. */
const editable = computed(() => props.components.filter((c) => props.base[c] != null));

/** A short list rather than the full IANA set: this is a prototype, and a free-text box for a
 *  timezone is a way to silently break a schedule. The current value is always offered. */
const ZONES = computed(() => {
  const common = [
    "UTC",
    "Europe/London",
    "Europe/Berlin",
    "America/New_York",
    "America/Los_Angeles",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Asia/Kolkata",
    "Australia/Sydney",
  ];
  const all = [...new Set([props.config.timezone, ...common])];
  return all.map((value) => ({
    value,
    label: value,
    hint: timezoneValid(value)
      ? clockLabel(localClock(props.now, value).minutes)
      : "not a timezone",
  }));
});

const here = computed(() => localClock(props.now, props.config.timezone));

const active = (w: RateWindow) => windowCovers(w, here.value.day, here.value.minutes);
/** The first covering window is the one in force; later ones are covered but outranked. */
const inForce = computed(() => props.config.windows.find(active) ?? null);

function addWindow() {
  props.config.windows.push({
    id: "w" + Date.now(),
    label: "Off-peak",
    days: [],
    from: 22 * 60,
    to: 6 * 60,
    percent: 30,
  });
}
function removeWindow(i: number) {
  props.config.windows.splice(i, 1);
}
function move(i: number, by: number) {
  const j = i + by;
  if (j < 0 || j >= props.config.windows.length) return;
  const [w] = props.config.windows.splice(i, 1);
  props.config.windows.splice(j, 0, w);
}
/**
 * An empty day list is the "every day" sentinel, and every one of the seven buttons reads as
 * selected while it is empty. Clicking one of them therefore means *deselect this day* — so the
 * sentinel is expanded to the six days that are left rather than collapsed to the one clicked,
 * which is the opposite of what the button said it would do.
 *
 * Taking the last remaining day out leaves the list empty, which reads as "every day" again. That
 * is the sentinel doing what it says rather than a hidden state: a window that applies on no day
 * at all is not something the schedule can express, and would apply to nothing if it could.
 */
function toggleDay(w: RateWindow, day: number) {
  if (!w.days.length) {
    w.days = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== day);
    return;
  }
  const i = w.days.indexOf(day);
  if (i >= 0) w.days.splice(i, 1);
  else w.days.push(day);
  // all seven selected one at a time is the same window as the sentinel; keep one spelling of it
  if (w.days.length === 7) w.days = [];
}
function setTime(w: RateWindow, edge: "from" | "to", text: string) {
  const v = parseClock(text);
  if (v != null) w[edge] = v;
}
/** A window charges either a percentage off the card or explicit rates — never a mix per field. */
function setKind(w: RateWindow, kind: "percent" | "rates") {
  if (kind === "percent") {
    delete w.rates;
    w.percent ??= 30;
  } else {
    delete w.percent;
    w.rates ??= Object.fromEntries(editable.value.map((c) => [c, props.base[c]]));
  }
}

/** What a percentage window does to every rate this endpoint has, at today's card. */
function discountPreview(w: RateWindow): string {
  const off = 1 - (w.percent ?? 0) / 100;
  const parts = editable.value.map(
    (c) => `${COMPONENT_LABEL[c]} ${rateWithUnit((props.base[c] ?? 0) * off, c, props.unit)}`,
  );
  return parts.length
    ? `In this window: ${parts.join(" · ")}.`
    : "This endpoint prices nothing yet.";
}
const kindOf = (w: RateWindow): "percent" | "rates" => (w.rates ? "rates" : "percent");
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-end justify-between gap-2">
      <label class="space-y-1 text-xs font-medium"
        ><span>Timezone</span>
        <UiSelect
          :model-value="config.timezone"
          :options="ZONES"
          size="xs"
          class="w-52"
          @update:model-value="(v) => (config.timezone = String(v))"
        />
        <span class="block text-[11px] font-normal text-zinc-500">
          Windows below are read in this zone. It is
          <b class="font-mono">{{ clockLabel(here.minutes) }}</b> on
          {{
            ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][here.day]
          }}
          there now.
        </span></label
      >
      <button class="btn-ghost btn-xs" @click="addWindow">
        <AddIcon class="icon-sm" /> Add window
      </button>
    </div>

    <p v-if="!config.windows.length" class="text-[11px] leading-relaxed text-zinc-500">
      No schedule. The base rates above apply at every hour of every day.
    </p>

    <ol v-else class="space-y-2">
      <li
        v-for="(w, i) in config.windows"
        :key="w.id"
        class="rounded-md border p-2.5"
        :class="
          w === inForce
            ? 'border-violet-400 bg-violet-50/60 dark:border-violet-500 dark:bg-violet-500/10'
            : 'border-zinc-200 dark:border-zinc-800'
        "
      >
        <div class="mb-2 flex flex-wrap items-center gap-2">
          <span class="font-mono text-[10px] text-zinc-400">{{ i + 1 }}</span>
          <input
            v-model="w.label"
            class="input w-36 py-0.5 text-xs"
            placeholder="Off-peak"
            :aria-label="`Name of window ${i + 1}`"
          />
          <span v-if="w === inForce" class="chip chip-on">in force now</span>
          <span
            v-else-if="active(w)"
            class="chip chip-off"
            title="This window covers right now, but an earlier one in the list wins — windows never stack."
            >covered, outranked</span
          >
          <span class="ml-auto flex items-center gap-1">
            <button
              class="btn-ghost btn-xs"
              :disabled="i === 0"
              :aria-label="`Move ${w.label} earlier in precedence`"
              @click="move(i, -1)"
            >
              <UpIcon class="icon-sm" />
            </button>
            <button
              class="btn-ghost btn-xs"
              :disabled="i === config.windows.length - 1"
              :aria-label="`Move ${w.label} later in precedence`"
              @click="move(i, 1)"
            >
              <DownIcon class="icon-sm" />
            </button>
            <button
              class="btn-ghost btn-xs text-red-600 dark:text-red-400"
              :aria-label="`Remove ${w.label}`"
              @click="removeWindow(i)"
            >
              <RemoveIcon class="icon-sm" />
            </button>
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <label class="flex items-center gap-1"
            ><span class="text-zinc-500">From</span>
            <input
              class="input w-[4.5rem] py-0.5 font-mono text-xs"
              :value="clockLabel(w.from)"
              :aria-label="`${w.label} start time`"
              @change="setTime(w, 'from', ($event.target as HTMLInputElement).value)"
          /></label>
          <label class="flex items-center gap-1"
            ><span class="text-zinc-500">to</span>
            <input
              class="input w-[4.5rem] py-0.5 font-mono text-xs"
              :value="clockLabel(w.to)"
              :aria-label="`${w.label} end time`"
              @change="setTime(w, 'to', ($event.target as HTMLInputElement).value)"
          /></label>
          <span v-if="crossesMidnight(w)" class="text-[11px] text-amber-700 dark:text-amber-400">
            runs past midnight — ends {{ clockLabel(w.to) }} the next day
          </span>
          <span class="flex flex-wrap items-center gap-1">
            <span class="text-zinc-500">on</span>
            <button
              v-for="(d, day) in DAY_SHORT"
              :key="d"
              class="rounded px-1.5 py-0.5 text-[10px]"
              :class="
                !w.days.length || w.days.includes(day)
                  ? 'bg-violet-500 text-white'
                  : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800'
              "
              :aria-pressed="!w.days.length || w.days.includes(day)"
              @click="toggleDay(w, day)"
            >
              {{ d }}
            </button>
            <UiTooltip
              v-if="crossesMidnight(w)"
              text="For a window that runs past midnight these are the days it starts on: Fri 22:00–02:00 covers Friday night and the first two hours of Saturday."
            >
              <span class="cursor-help text-[10px] text-zinc-400 underline decoration-dotted"
                >start days</span
              >
            </UiTooltip>
            <span v-if="!w.days.length" class="text-[10px] text-zinc-400">every day</span>
          </span>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <UiSelect
            :model-value="kindOf(w)"
            :options="[
              { value: 'percent', label: 'Percentage off the base rates' },
              { value: 'rates', label: 'Explicit rates' },
            ]"
            size="xs"
            class="w-56"
            :aria-label="`How ${w.label} changes the price`"
            @update:model-value="(v) => setKind(w, v as 'percent' | 'rates')"
          />
          <UiNumber
            v-if="kindOf(w) === 'percent'"
            :model-value="w.percent ?? 0"
            class="w-24"
            unit="% off"
            :min="0"
            :max="100"
            :step="5"
            :label="`${w.label} discount`"
            @update:model-value="(v) => (w.percent = v ?? 0)"
          />
          <template v-else>
            <UiNumber
              v-for="c in editable"
              :key="c"
              :model-value="w.rates![c] ?? base[c]"
              class="w-32"
              prefix="$"
              :unit="rateSuffix(c, unit)"
              :min="0"
              :step="0.05"
              :label="`${w.label} ${COMPONENT_LABEL[c]} rate`"
              @update:model-value="(v) => (w.rates = { ...w.rates, [c]: v ?? 0 })"
            />
          </template>
          <span class="text-[11px] text-zinc-500">
            <template v-if="kindOf(w) === 'percent'">{{ discountPreview(w) }}</template>
            <template v-else
              >Rates you leave alone stay at the card rate inside this window.</template
            >
          </span>
        </div>
      </li>
    </ol>
  </div>
</template>
