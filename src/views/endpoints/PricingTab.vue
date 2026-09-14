<script setup lang="ts">
// Money, and the three different things people mean by "cost":
//
//   estimated — what a run would cost, worked out from these rates before anything is sent
//   reserved  — what is held against the budget while requests are in flight, worked out from the
//               worst case (full output ceiling) so a run can't overshoot the cap mid-flight
//   recorded  — what it actually cost, priced from the usage that came back
//
// And the fourth case that matters most: when the rate isn't known, the answer is "unknown", never
// a confident $0.
import { computed } from "vue";
import { useApp } from "@/stores/app";
import { UiNumber, UiSelect, UiTooltip } from "@/ui";
import { TriangleAlert as WarnIcon } from "@lucide/vue";
import {
  BILLING_UNITS,
  billingOf,
  billingUnitLabel,
  maybeMoney,
  money,
  opsOf,
  perMillionChars,
} from "@/lib/endpoints";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import type { MetricTotals, TtsBillingUnit } from "@/types";

const props = defineProps<{
  u: UnifiedEndpoint;
  totals: MetricTotals | null;
  rangeLabel: string;
  /** recorded spend on this endpoint since midnight, and how many rows couldn't be priced */
  today: { cost: number; unknown: number };
}>();

const app = useApp();
const ep = computed(() => (props.u.profile ?? props.u.endpoint)!);
const ops = computed(() => opsOf(props.u));
const billing = computed(() => (props.u.endpoint ? billingOf(props.u.endpoint) : null));

/** Keep the legacy per-1M-characters figure the run estimator works in aligned with the unit. */
function setBilling(unit: TtsBillingUnit | null, rate: number | null): void {
  const e = props.u.endpoint;
  if (!e) return;
  const next = {
    unit: unit ?? billingOf(e).unit,
    rate: rate === undefined ? billingOf(e).rate : rate,
  };
  e.billing = next;
  e.price = perMillionChars(next) ?? 0;
}

const converted = computed(() => (billing.value ? perMillionChars(billing.value) : null));
/** only a speech endpoint can have an unknown rate; scripting always has two numbers */
const unknownRate = computed(() => !!billing.value && billing.value.rate == null);
const noRates = computed(
  () => !!props.u.profile && !props.u.profile.inPrice && !props.u.profile.outPrice,
);

const books = computed(() =>
  app.books
    .map((b) => ({
      book: b,
      cap: b.budget?.cap ?? null,
      scriptCap: b.scriptBudget ?? null,
      spent: app.spent(b.id),
      scriptSpent: app.scriptSpent(b.id),
      reserved: app.scriptReserved(b.id),
      paused: !!b.budget?.paused,
    }))
    .filter((r) => r.cap != null || r.scriptCap != null || r.reserved > 0),
);
const anyBudget = computed(() => books.value.length > 0);

const limit = computed(() => ops.value.spendLimit);
const limitUsed = computed(() =>
  limit.value ? Math.min(100, (props.today.cost / limit.value) * 100) : 0,
);
</script>

<template>
  <div class="space-y-3">
    <!-- rates -->
    <section class="card p-3">
      <h3 class="label mb-2">Rates</h3>

      <!-- scripting: two prices, per million tokens -->
      <div v-if="u.profile" class="grid gap-3 sm:grid-cols-2">
        <label class="space-y-1 text-xs font-medium"
          ><span>Input tokens</span>
          <UiNumber
            v-model="u.profile.inPrice"
            class="w-full"
            prefix="$"
            unit="/ 1M"
            :min="0"
            :step="0.05"
            label="Input token price per million"
          />
          <span class="block text-[11px] font-normal text-zinc-500"
            >The chapter text, the prompt, and any context carried forward.</span
          ></label
        >
        <label class="space-y-1 text-xs font-medium"
          ><span>Output tokens</span>
          <UiNumber
            v-model="u.profile.outPrice"
            class="w-full"
            prefix="$"
            unit="/ 1M"
            :min="0"
            :step="0.05"
            label="Output token price per million"
          />
          <span class="block text-[11px] font-normal text-zinc-500"
            >The script that comes back — lines, speaker labels and directions.</span
          ></label
        >
      </div>

      <!-- tts: the unit is part of the price -->
      <div v-else class="grid gap-3 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
        <label class="space-y-1 text-xs font-medium"
          ><span>Billed</span>
          <UiSelect
            :model-value="billing!.unit"
            :options="BILLING_UNITS"
            class="w-full"
            @update:model-value="(v) => setBilling(v as TtsBillingUnit, billing!.rate)"
          />
          <span class="block text-[11px] font-normal text-zinc-500"
            >Not every provider bills per character — pick what yours actually charges for.</span
          ></label
        >
        <label class="space-y-1 text-xs font-medium"
          ><span>Rate</span>
          <UiNumber
            :model-value="billing!.rate"
            class="w-full"
            prefix="$"
            :unit="billingUnitLabel(billing!.unit).replace('per ', '/ ')"
            :min="0"
            :step="0.5"
            :empty="null"
            placeholder="not known"
            label="Rate"
            @update:model-value="(v) => setBilling(billing!.unit, v)"
          />
          <span class="block text-[11px] font-normal text-zinc-500">
            <template v-if="unknownRate"
              ><b class="text-amber-600 dark:text-amber-400">Leave it blank</b> if you don’t know
              the rate — requests are then recorded with an unknown cost rather than a free-looking
              $0.</template
            >
            <template v-else-if="converted != null"
              >≈ {{ money(converted) }} per 1M characters at this app’s text-to-audio ratio — that
              conversion is what run estimates use.</template
            >
            <template v-else
              >Per-request billing can’t be converted to a per-character figure, so run estimates
              count requests instead of characters.</template
            >
          </span></label
        >
      </div>

      <p
        v-if="noRates"
        class="mt-2 rounded bg-zinc-100 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300"
      >
        Both rates are zero, so this endpoint is treated as free — right for a model you host
        yourself, wrong if the provider bills you. Enter the rates and past requests keep the price
        they were recorded at.
      </p>
      <p
        v-if="unknownRate"
        class="mt-2 rounded bg-amber-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm" /> No rate set. Requests through this endpoint are recorded with
        an <b>unknown</b> cost: they are counted, never priced, and excluded from every total on
        this page — so the totals you see are floors, not the full bill.
      </p>
    </section>

    <!-- estimated / reserved / recorded -->
    <section class="card p-3">
      <h3 class="label mb-2">Estimated, reserved, recorded</h3>
      <dl class="grid gap-3 sm:grid-cols-3">
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <dt class="text-xs font-medium">Estimated</dt>
          <dd class="mt-1 text-[11px] leading-relaxed text-zinc-500">
            Worked out from these rates before a run starts, from the text to be sent. It moves when
            you change the rates, and it is never charged to anything.
          </dd>
        </div>
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <dt class="text-xs font-medium">Reserved</dt>
          <dd class="mt-1 font-mono text-sm">
            {{
              u.kind === "scripting"
                ? money(app.books.reduce((n, b) => n + app.scriptReserved(b.id), 0))
                : "—"
            }}
          </dd>
          <dd class="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
            <template v-if="u.kind === 'scripting'"
              >Held against the budget while requests are in flight — input cost plus the
              <b>whole</b> output ceiling, so a long answer can’t push a run past its cap. Released
              and replaced by the real figure when each request settles.</template
            >
            <template v-else
              >Speech requests aren’t reserved: their cost is known from the text before they are
              sent, so the estimate is the reservation.</template
            >
          </dd>
        </div>
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <dt class="text-xs font-medium">Recorded</dt>
          <dd class="mt-1 font-mono text-sm">
            {{ totals ? money(totals.cost) : "—" }}
            <span class="text-[11px] font-sans text-zinc-500">· {{ rangeLabel }}</span>
          </dd>
          <dd class="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
            Priced from the usage that actually came back, at the rates in force at the time.
            Changing a rate today does not re-price yesterday.
            <span v-if="totals?.unknownCost" class="text-amber-600 dark:text-amber-400"
              >{{ totals.unknownCost }} of these could not be priced.</span
            >
          </dd>
        </div>
      </dl>
    </section>

    <!-- limits -->
    <section class="card p-3">
      <h3 class="label mb-2">Spending limits</h3>
      <div class="grid gap-3 lg:grid-cols-2">
        <!-- endpoint scope -->
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
          <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
            Caps what <b>this endpoint</b> spends, added up across every book. Leave it blank for no
            endpoint limit.
          </p>
        </div>

        <!-- book scope -->
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <div class="mb-1.5 flex items-center justify-between gap-2">
            <span class="text-xs font-medium">Book budgets</span>
            <span class="chip chip-off">all endpoints</span>
          </div>
          <p class="text-[11px] leading-relaxed text-zinc-500">
            A different scope: each cap below limits what <b>one book</b> spends across
            <b>every</b> endpoint. A request has to fit under its book’s cap <i>and</i> under this
            endpoint’s daily limit.
          </p>
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
                    {{ money(r.scriptSpent) }} used</span
                  >
                </td>
                <td class="py-1 text-right font-mono">{{ money(r.spent) }}</td>
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

      <div
        class="mt-3 rounded-md bg-zinc-50 p-2.5 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300"
      >
        <b>When the remaining budget can’t cover another request</b> the run stops dispatching
        rather than half-finishing a chapter: requests already in flight are allowed to land and are
        recorded, nothing queued is sent, and the chapter is marked failed with the reason. Raise
        the cap and retry the chapter — the requests that already completed keep their recorded cost
        and are not paid for twice. An endpoint whose rate is unknown can’t be checked against a
        budget at all, which is the other reason not to leave a rate blank for a provider that bills
        you.
      </div>
      <p class="mt-2 text-[11px] text-zinc-500">
        <UiTooltip text="No payment method is connected and no provider is called.">
          <span class="cursor-help underline decoration-dotted underline-offset-2"
            >Budgets here are bookkeeping inside the prototype.</span
          >
        </UiTooltip>
      </p>
    </section>
  </div>
</template>
