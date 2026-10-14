<script setup lang="ts">
import { useJobsStore } from "@/stores/jobs";
import { plural } from "@/lib/contents";
import { useLibraryStore } from "@/stores/library";

// Four kinds of "cost": estimated (before sending, no cache savings), reserved (worst case, held
// while in flight so a run can't overshoot the cap), recorded (priced per request at the rates in
// force when it completed), and unknown (never a confident $0).
import { computed } from "vue";
import { useNow } from "@vueuse/core";

import { UiHint, UiNumber, UiSwitch } from "@/ui";
import { TriangleAlert as WarnIcon } from "@lucide/vue";
import { billingOf, opsOf, rateCardOf } from "@/lib/endpoints";
import {
  COMPONENT_HINT,
  effectiveRates,
  money,
  perMillionChars,
  pricingWarnings,
  speechRateKnown,
} from "@/lib/pricing";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import BillingModel from "@/views/endpoints/BillingModel.vue";
import EffectiveRates from "@/views/endpoints/EffectiveRates.vue";
import RatePromotions from "@/views/endpoints/RatePromotions.vue";
import RateSchedule from "@/views/endpoints/RateSchedule.vue";
import { recentCacheRate } from "@/lib/scriptActivity";
import type { EndpointKind, MetricTotals, RequestRecord, TtsBilling } from "@/types";

const props = defineProps<{
  u: UnifiedEndpoint;
  totals: MetricTotals | null;
  rangeLabel: string;
  /** recorded spend since midnight, and how many rows couldn't be priced */
  today: { cost: number; unknown: number };
  /** newest first */
  settled: RequestRecord[];
}>();

const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const ep = computed(() => props.u.entry);
const ops = computed(() => opsOf(props.u));
const billing = computed(() => (props.u.endpoint ? billingOf(props.u.endpoint) : null));

// Effective rates change on their own (off-peak windows, promotions), so keep a clock.
const clock = useNow({ interval: 1000 });
const now = computed(() => clock.value.getTime());

// ---------- the rate card ----------
// Every kind shares the schedule and promotions; `rateCardOf` gives its rates and unit.
const card = computed(() => rateCardOf(props.u));
const config = computed(() => card.value.config);
const base = computed(() => card.value.base);
// without the unit, reason strings fall back to "/ 1M chars" for every kind
const snapshot = computed(() =>
  effectiveRates(base.value, config.value, now.value, card.value.unit),
);
const warnings = computed(() => pricingWarnings(base.value, config.value, now.value));
/** The advanced sections start open only on an endpoint that uses them. */
const hasSchedule = computed(() => !!config.value?.windows.length);
const hasPromotions = computed(() => !!config.value?.promotions.length);
const observed = computed(() => (props.u.profile ? recentCacheRate(props.settled) : null));

/** Off means "charged as input". */
function setCached(on: boolean) {
  const input = base.value.input ?? 0;
  config.value.cachedInput = on ? Number((input * 0.25).toFixed(4)) : null;
}
function setCacheWrite(on: boolean) {
  const input = base.value.input ?? 0;
  config.value.cacheWrite = on ? Number((input * 1.25).toFixed(4)) : null;
}

// ---------- the speech rate ----------
/** `price` is the legacy per-1M-chars figure: kept in step where one exists, else zeroed (a
 *  per-request fee or byte rate has no character equivalent). */
function setBilling(next: TtsBilling): void {
  const e = props.u.endpoint;
  if (!e) return;
  e.billing = next;
  e.price = perMillionChars(next) ?? 0;
}

/** only a speech endpoint can have an unknown rate */
const unknownRate = computed(() => !!billing.value && !speechRateKnown(billing.value));
/** All-zero rates mean free; said, since it may be a mistake. */
const FREE: Record<EndpointKind, (u: UnifiedEndpoint) => string | null> = {
  scripting: (u) =>
    !u.profile!.inPrice && !u.profile!.outPrice
      ? "Both rates are zero, so this endpoint is treated as free"
      : null,
  // a speech card says this itself, beside its rate
  tts: () => null,
  transcription: (u) =>
    !u.transcriber!.perMinute ? "The rate is zero, so this endpoint is treated as free" : null,
};
const free = computed(() => FREE[props.u.kind](props.u));

const ESTIMATED: Record<EndpointKind, string> = {
  scripting:
    "Worked out from these rates before a run starts; it assumes no cache savings, so the real figure comes in at or under it, and it is never charged to anything.",
  tts: "Worked out from these rates and the text before a run starts; it is never charged to anything.",
  transcription:
    "A recording is priced by how long it plays once it is sent; nothing is estimated before.",
};
const ESTIMATED_SAYS: Record<EndpointKind, string> = {
  scripting: "From these rates, before a run starts.",
  tts: "From these rates, before a run starts.",
  transcription: "None — priced once sent.",
};
const RESERVED: Record<EndpointKind, string> = {
  scripting:
    "Held against a book’s cap while requests are in flight, at undiscounted rates with the whole output ceiling, and released as each request settles.",
  tts: "A speech request’s cost is known from the text before it is sent, so the estimate is the reservation.",
  transcription: "A recording is sent on a click, not by a run, so nothing is held against a book.",
};
const RESERVED_SAYS: Record<EndpointKind, string> = {
  scripting: "· every book, every scripting endpoint",
  tts: "· speech requests aren’t reserved",
  transcription: "· transcriptions aren’t reserved",
};

const books = computed(() =>
  libraryStore.books
    .map((b) => ({
      book: b,
      cap: b.budget?.cap ?? null,
      scriptCap: b.scriptBudget ?? null,
      spent: jobsStore.spent(b.id),
      scriptSpent: jobsStore.scriptSpent(b.id),
      reserved: jobsStore.scriptReserved(b.id),
      paused: !!b.budget?.paused,
    }))
    .filter((r) => r.cap != null || r.scriptCap != null || (r.reserved ?? 0) > 0),
);
// unread spending is unknown, never zero
const moneyOrUnknown = (n: number | undefined) => (n == null ? "—" : money(n));
// unknown while any book's reservation is still unread
const reservedAll = computed(() => {
  let n = 0;
  for (const b of libraryStore.books) {
    const r = jobsStore.scriptReserved(b.id);
    if (r == null) return undefined;
    n += r;
  }
  return n;
});
const anyBudget = computed(() => books.value.length > 0);

const limit = computed(() => ops.value.spendLimit);
const limitUsed = computed(() =>
  limit.value ? Math.min(100, (props.today.cost / limit.value) * 100) : 0,
);
</script>

<template>
  <div class="space-y-3">
    <section class="card p-3">
      <h3 class="label mb-2">
        Rates
        <UiHint
          label="rates"
          text="A blank rate means unknown, never $0; unpriced requests are counted but left out of every total."
        />
      </h3>

      <div v-if="u.profile" class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <!-- divs, not labels: the hint is a button, and each field names itself (`label`) -->
          <div class="space-y-1 text-xs font-medium">
            <span>Input tokens <UiHint label="input tokens" :text="COMPONENT_HINT.input" /></span>
            <UiNumber
              v-model="u.profile.inPrice"
              class="w-full"
              prefix="$"
              unit="/ 1M"
              :min="0"
              :step="0.05"
              label="Input token price per million"
            />
          </div>
          <div class="space-y-1 text-xs font-medium">
            <span
              >Output tokens <UiHint label="output tokens" :text="COMPONENT_HINT.output"
            /></span>
            <UiNumber
              v-model="u.profile.outPrice"
              class="w-full"
              prefix="$"
              unit="/ 1M"
              :min="0"
              :step="0.05"
              label="Output token price per million"
            />
          </div>
        </div>

        <!-- off by default: most providers this app talks to don't have it -->
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <UiSwitch :model-value="config.cachedInput != null" @update:model-value="setCached"
            >This provider charges a different rate for cached input
            <UiHint
              label="cached input"
              text="Off is not free: cached tokens are then charged at the ordinary input rate. On, the cached slice of a request is charged here and the rest at the input rate."
          /></UiSwitch>
          <div v-if="config.cachedInput != null" class="mt-2 flex flex-wrap items-center gap-3">
            <UiNumber
              :model-value="config.cachedInput"
              class="w-36"
              prefix="$"
              unit="/ 1M"
              :min="0"
              :step="0.01"
              label="Cached input price per million"
              @update:model-value="(v) => (config.cachedInput = v ?? 0)"
            />
            <span class="text-[11px] text-zinc-500">{{
              u.profile.inPrice
                ? Math.round((config.cachedInput / u.profile.inPrice) * 100) + "% of the input rate"
                : "set an input rate to compare"
            }}</span>
          </div>

          <div class="mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <UiSwitch :model-value="config.cacheWrite != null" @update:model-value="setCacheWrite"
              >…and a different rate again for writing the cache
              <UiHint
                label="cache writes"
                text="Only some providers bill cache writes, usually dearer than input; off, those tokens are charged at the ordinary input rate."
            /></UiSwitch>
            <UiNumber
              v-if="config.cacheWrite != null"
              :model-value="config.cacheWrite"
              class="mt-2 w-36"
              prefix="$"
              unit="/ 1M"
              :min="0"
              :step="0.01"
              label="Cache write price per million"
              @update:model-value="(v) => (config.cacheWrite = v ?? 0)"
            />
          </div>
        </div>
      </div>

      <BillingModel
        v-else-if="u.endpoint"
        :endpoint="u.endpoint"
        :billing="billing!"
        :now="now"
        @update="setBilling"
      />

      <div v-else-if="u.transcriber" class="space-y-1 text-xs font-medium">
        <span>Audio sent</span>
        <UiNumber
          v-model="u.transcriber.perMinute"
          class="w-44"
          prefix="$"
          unit="/ audio min"
          :min="0"
          :step="0.001"
          label="USD per audio minute"
        />
      </div>

      <p
        v-if="free"
        class="mt-2 rounded bg-zinc-100 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300"
      >
        {{ free }} — right for a model you host yourself, wrong if the provider bills you.
      </p>
      <p
        v-if="unknownRate && (config.windows.length || config.promotions.length)"
        class="mt-2 rounded bg-amber-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm" /> The schedule and promotions below change nothing while the rate
        is unknown.
      </p>
      <p
        v-for="w in warnings"
        :key="w"
        class="mt-2 rounded bg-amber-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm" /> {{ w }}
      </p>
    </section>

    <section class="card p-3">
      <h3 class="label mb-2">
        Effective price now
        <UiHint
          label="the effective price"
          text="Card rate, then the schedule, then the one promotion that makes each component cheapest; a request is priced at the rates in force when it completes."
        />
      </h3>
      <EffectiveRates
        :snapshot="snapshot"
        :now="now"
        :components="card.components"
        :unit="card.unit"
      />
    </section>

    <details class="card p-3" :open="hasSchedule">
      <summary class="label cursor-pointer select-none">
        Peak / off-peak schedule
        <span class="ml-1 font-normal normal-case text-zinc-400">
          {{
            config.windows.length
              ? `${plural(config.windows.length, "window")} · ${config.timezone}`
              : "none — the rates above apply at every hour"
          }}
        </span>
      </summary>
      <div class="mt-3">
        <RateSchedule
          :config="config"
          :base="base"
          :now="now"
          :components="card.components"
          :unit="card.unit"
        />
      </div>
    </details>

    <details class="card p-3" :open="hasPromotions">
      <summary class="label cursor-pointer select-none">
        Promotions
        <span class="ml-1 font-normal normal-case text-zinc-400">
          {{
            config.promotions.length
              ? `${snapshot.applied.length} applying, ${config.promotions.length} on record`
              : "none"
          }}
        </span>
      </summary>
      <div class="mt-3">
        <RatePromotions
          :config="config"
          :base="base"
          :snapshot="snapshot"
          :now="now"
          :components="card.components"
          :unit="card.unit"
        />
      </div>
    </details>

    <section class="card p-3">
      <h3 class="label mb-2">Estimated, reserved, recorded</h3>
      <dl class="grid gap-3 sm:grid-cols-3">
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <dt class="text-xs font-medium">
            Estimated
            <UiHint label="estimates" :text="ESTIMATED[u.kind]" />
          </dt>
          <dd class="mt-1 text-[11px] text-zinc-500">{{ ESTIMATED_SAYS[u.kind] }}</dd>
        </div>
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <dt class="text-xs font-medium">
            Reserved
            <UiHint label="reservations" :text="RESERVED[u.kind]" />
          </dt>
          <!-- reservations are per book and record no endpoint, so this is library-wide -->
          <dd class="mt-1 font-mono text-sm">
            {{ u.kind === "scripting" ? moneyOrUnknown(reservedAll) : "—" }}
            <span class="font-sans text-[11px] text-zinc-500">{{ RESERVED_SAYS[u.kind] }}</span>
          </dd>
        </div>
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <dt class="text-xs font-medium">
            Recorded
            <UiHint
              label="recorded spend"
              text="Priced per request from the usage that came back, at the rates in force when it completed; changing a rate today does not re-price yesterday."
            />
          </dt>
          <dd class="mt-1 font-mono text-sm">
            {{ totals ? money(totals.cost) : "—" }}
            <span class="text-[11px] font-sans text-zinc-500">· {{ rangeLabel }}</span>
          </dd>
          <dd
            v-if="totals?.unknownCost || totals?.estimatedCost || totals?.providerReported"
            class="mt-0.5 text-[11px] leading-relaxed text-zinc-500"
          >
            <span v-if="totals?.unknownCost" class="text-amber-600 dark:text-amber-400"
              >{{ totals.unknownCost }} not priced.</span
            >
            <span v-if="totals?.estimatedCost" class="text-amber-600 dark:text-amber-400"
              >{{ totals.estimatedCost }} estimated — part of their usage was missing.</span
            >
            <span v-if="totals?.providerReported"
              >{{ totals.providerReported }} priced from the provider’s own figure.</span
            >
          </dd>
        </div>
      </dl>

      <div
        v-if="u.kind === 'scripting' && totals"
        class="mt-3 rounded-md border border-zinc-200 p-2.5 text-[11px] leading-relaxed dark:border-zinc-800"
      >
        <div class="mb-1 text-xs font-medium">
          Cache, as reported
          <UiHint
            label="the cache figure"
            text="Only requests that reported cache detail count; those that said nothing are left out rather than read as misses, and their cost is an upper bound."
          />
        </div>
        <template v-if="totals.cacheReported">
          <!-- both halves come from requests that reported cache; unreported isn't a miss -->
          <p>
            <b class="font-mono">{{ totals.cachedInputTokens.toLocaleString() }}</b> of
            <b class="font-mono">{{ totals.cacheReportedInputTokens.toLocaleString() }}</b> input
            tokens cached —
            <b
              >{{
                totals.cacheReportedInputTokens
                  ? Math.round((totals.cachedInputTokens / totals.cacheReportedInputTokens) * 100)
                  : 0
              }}%</b
            >
            over {{ rangeLabel }}, from the {{ totals.cacheReported }} of
            {{ totals.requests }} requests that reported it.
          </p>
          <p v-if="totals.cacheReported < totals.requests" class="mt-1 text-zinc-500">
            The other {{ totals.requests - totals.cacheReported }} reported no cache detail; their
            <b class="font-mono">{{
              (totals.inputTokens - totals.cacheReportedInputTokens).toLocaleString()
            }}</b>
            input tokens are left out.
          </p>
          <p v-if="observed" class="mt-1 text-zinc-500">
            Last {{ observed.samples }} requests: {{ Math.round(observed.hitRate * 100) }}% cached
            on average.
          </p>
        </template>
        <p v-else class="text-zinc-500">
          No request reported cache detail in {{ rangeLabel }}; costs assume none and are labelled
          estimates.
        </p>
      </div>
    </section>

    <section class="card p-3">
      <h3 class="label mb-2">
        Spending limits
        <UiHint
          label="spending limits"
          text="Checked at undiscounted rates with no cache savings, since a promotion can end mid-run, against what the server priced each request at — never your provider’s invoice."
        />
      </h3>
      <div class="grid gap-3 lg:grid-cols-2">
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <div class="mb-1.5 flex items-center justify-between gap-2">
            <span class="text-xs font-medium">This endpoint</span>
            <span class="chip chip-off">all books</span>
          </div>
          <label class="flex items-center justify-between gap-3 text-xs"
            ><span>Daily limit</span>
            <UiNumber
              :model-value="ops.spendLimit"
              class="w-32"
              @update:model-value="(v) => (ep.spendLimit = v)"
              prefix="$"
              unit="/ day"
              :min="0"
              :step="1"
              :empty="null"
              placeholder="no limit"
              label="Daily spending limit for this endpoint"
          /></label>
          <div class="mt-2 text-[11px] text-zinc-500">
            Spent today: <b class="font-mono">{{ money(today.cost) }}</b>
            <span v-if="today.unknown" class="text-amber-600 dark:text-amber-400">
              + {{ today.unknown }} unpriced</span
            >
            <template v-if="limit != null"> of {{ money(limit) }}</template>
          </div>
          <div v-if="limit != null" class="mt-1 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800">
            <div
              class="h-1.5 rounded transition-all"
              :class="
                limitUsed > 90 ? 'bg-red-500' : limitUsed > 70 ? 'bg-amber-500' : 'bg-violet-500'
              "
              :style="{ width: limitUsed + '%' }"
            ></div>
          </div>
        </div>

        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <div class="mb-1.5 flex items-center justify-between gap-2">
            <span class="text-xs font-medium"
              >Book budgets
              <UiHint
                label="book budgets"
                text="Each cap limits what one book spends across every endpoint; it is set on the book’s overview page."
            /></span>
            <span class="chip chip-off">all endpoints</span>
          </div>
          <table v-if="anyBudget" class="mt-2 w-full text-[11px]">
            <thead class="text-zinc-500">
              <tr>
                <th class="pb-1 text-left font-normal">Book</th>
                <th class="pb-1 text-right font-normal">Spent</th>
                <th class="pb-1 text-right font-normal">Cap</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in books"
                :key="r.book.id"
                class="border-t border-zinc-100 dark:border-zinc-800"
              >
                <td class="py-1">
                  <RouterLink :to="`/book/${r.book.id}`" class="hover:text-violet-500">{{
                    r.book.title
                  }}</RouterLink>
                  <span v-if="r.paused" class="ml-1 text-amber-600 dark:text-amber-400"
                    >paused</span
                  >
                  <span v-if="r.scriptCap != null" class="block text-zinc-500"
                    >scripting sub-cap {{ money(r.scriptCap) }} ·
                    {{ moneyOrUnknown(r.scriptSpent) }} used</span
                  >
                </td>
                <td class="py-1 text-right font-mono">{{ moneyOrUnknown(r.spent) }}</td>
                <td class="py-1 text-right font-mono">
                  {{ r.cap == null ? "none" : money(r.cap) }}
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="mt-2 text-[11px] text-zinc-500">
            No book has a budget set. Set one on a book’s overview page.
          </p>
        </div>
      </div>

      <p class="mt-3 text-[11px] text-zinc-500">
        When a book’s budget can’t cover another request, the run stops dispatching; in-flight
        requests land and are recorded.
        <UiHint
          label="a run out of budget"
          text="The chapter fails with the reason; raise the cap and retry it — the requests that already completed keep their recorded cost and are not paid for twice."
        />
      </p>
    </section>
  </div>
</template>
