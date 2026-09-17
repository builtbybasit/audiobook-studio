<script setup lang="ts">
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";

// Money, and the four different things people mean by "cost":
//
//   estimated — what a run would cost, worked out from these rates before anything is sent. It
//               assumes no cache savings, because cache use cannot be known in advance.
//   reserved  — what is held against the budget while requests are in flight, worked out from the
//               worst case (full output ceiling, no discounts) so a run can't overshoot the cap
//   recorded  — what it actually cost, priced per request from the usage that came back, at the
//               rates in force when that request completed
//   unknown   — when the rate isn't known, the answer is "unknown", never a confident $0
//
// Ordinary pricing is the top card and nothing else. The schedule and the promotions are behind
// disclosures that stay shut on an endpoint that has neither, which is most of them.
import { computed, onMounted, onUnmounted, ref } from "vue";

import { UiNumber, UiSwitch, UiTooltip } from "@/ui";
import { TriangleAlert as WarnIcon } from "@lucide/vue";
import { billingOf, money, opsOf, perMillionChars, speechPricing } from "@/lib/endpoints";
import {
  TOKEN_COMPONENTS,
  baseRates,
  effectiveRates,
  ensurePricing,
  pricingWarnings,
  speechComponents,
  speechRateKnown,
} from "@/lib/pricing";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import BillingModel from "@/views/endpoints/BillingModel.vue";
import EffectiveRates from "@/views/endpoints/EffectiveRates.vue";
import RatePromotions from "@/views/endpoints/RatePromotions.vue";
import RateSchedule from "@/views/endpoints/RateSchedule.vue";
import type { MetricTotals, TtsBilling } from "@/types";

const props = defineProps<{
  u: UnifiedEndpoint;
  totals: MetricTotals | null;
  rangeLabel: string;
  /** recorded spend on this endpoint since midnight, and how many rows couldn't be priced */
  today: { cost: number; unknown: number };
}>();

const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const ep = computed(() => (props.u.profile ?? props.u.endpoint)!);
const ops = computed(() => opsOf(props.u));
const billing = computed(() => (props.u.endpoint ? billingOf(props.u.endpoint) : null));

// The effective rates move on their own — an off-peak window opens, a promotion expires — so this
// panel keeps its own clock rather than reading a stale snapshot until somebody clicks something.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval>;
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => clearInterval(clock));

// ---------- the rate card, whichever kind this endpoint is ----------
// Both kinds go through the same schedule and the same promotions; what differs is which rates they
// have and what unit those rates are written in, so that is all the page has to branch on.
const card = computed(() =>
  props.u.profile
    ? {
        base: baseRates(props.u.profile),
        config: ensurePricing(props.u.profile),
        components: TOKEN_COMPONENTS,
        unit: undefined,
      }
    : {
        ...speechPricing(props.u.endpoint!),
        // only the components this endpoint's billing model actually prices: one rate for a
        // per-character card, two for a token-billed one, and never a row for something it does
        // not charge for
        components: speechComponents(billingOf(props.u.endpoint!).unit),
      },
);
const config = computed(() => card.value.config);
const base = computed(() => card.value.base);
const snapshot = computed(() => effectiveRates(base.value, config.value, now.value));
const warnings = computed(() => pricingWarnings(base.value, config.value, now.value));
/** Whether the advanced sections start open: an endpoint that already uses them. */
const hasSchedule = computed(() => !!config.value?.windows.length);
const hasPromotions = computed(() => !!config.value?.promotions.length);
const observed = computed(() =>
  props.u.profile ? jobsStore.observedCache(props.u.profile.id) : null,
);

/** Turning cached pricing on needs a starting number; turning it off means "charged as input". */
function setCached(on: boolean) {
  const input = base.value.input ?? 0;
  config.value.cachedInput = on ? Number((input * 0.25).toFixed(4)) : null;
}
function setCacheWrite(on: boolean) {
  const input = base.value.input ?? 0;
  config.value.cacheWrite = on ? Number((input * 1.25).toFixed(4)) : null;
}

// ---------- the speech rate ----------
/**
 * Write a new billing model.
 *
 * `price` is the legacy per-1M-characters figure some older readers still use. It is kept in step
 * where the model can honestly produce one and zeroed where it cannot — a per-request fee and a
 * byte rate have no character equivalent, and inventing one is the conflation the whole billing
 * model exists to prevent.
 */
function setBilling(next: TtsBilling): void {
  const e = props.u.endpoint;
  if (!e) return;
  e.billing = next;
  e.price = perMillionChars(next) ?? 0;
}

/** only a speech endpoint can have an unknown rate; scripting always has two numbers */
const unknownRate = computed(() => !!billing.value && !speechRateKnown(billing.value));
const noRates = computed(
  () => !!props.u.profile && !props.u.profile.inPrice && !props.u.profile.outPrice,
);

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
    <!-- ordinary pricing: the card rates, and nothing else -->
    <section class="card p-3">
      <h3 class="label mb-2">Rates</h3>

      <!-- scripting: two prices, per million tokens -->
      <div v-if="u.profile" class="space-y-3">
        <div class="grid gap-3 sm:grid-cols-2">
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

        <!-- cached input: off by default, because most providers this app talks to don't have it -->
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <UiSwitch
            :model-value="config.cachedInput != null"
            label="This provider charges a different rate for cached input"
            @update:model-value="setCached"
          />
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
            <span class="text-[11px] text-zinc-500"
              >{{
                u.profile.inPrice
                  ? Math.round((config.cachedInput / u.profile.inPrice) * 100) +
                    "% of the input rate"
                  : "set an input rate to compare"
              }}. A request is usually part cached: the cached tokens are charged here and the rest
              at the input rate, never both.</span
            >
          </div>
          <p v-else class="mt-1 text-[11px] leading-relaxed text-zinc-500">
            Off means <b>no separate line</b> — cached tokens are charged at the ordinary input
            rate. That is not the same as free.
          </p>

          <div class="mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <UiSwitch
              :model-value="config.cacheWrite != null"
              label="…and a different rate again for writing the cache"
              @update:model-value="setCacheWrite"
            />
            <div v-if="config.cacheWrite != null" class="mt-2 flex flex-wrap items-center gap-3">
              <UiNumber
                :model-value="config.cacheWrite"
                class="w-36"
                prefix="$"
                unit="/ 1M"
                :min="0"
                :step="0.01"
                label="Cache write price per million"
                @update:model-value="(v) => (config.cacheWrite = v ?? 0)"
              />
              <span class="text-[11px] text-zinc-500"
                >Only some providers bill this. Where they do it is usually dearer than ordinary
                input, because the first request pays for the ones after it.</span
              >
            </div>
            <p v-else class="mt-1 text-[11px] leading-relaxed text-zinc-500">
              Leave this off unless your provider bills cache writes separately. Off, any reported
              cache-write tokens are charged at the ordinary input rate.
            </p>
          </div>
        </div>
      </div>

      <!-- tts: the billing model is part of the price -->
      <BillingModel
        v-else
        :endpoint="u.endpoint!"
        :billing="billing!"
        :now="now"
        @update="setBilling"
      />

      <p
        v-if="noRates"
        class="mt-2 rounded bg-zinc-100 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300"
      >
        Both rates are zero, so this endpoint is treated as free — right for a model you host
        yourself, wrong if the provider bills you. Enter the rates and past requests keep the price
        they were recorded at.
      </p>
      <!-- the one thing the billing panel cannot say, because it does not know what is below it -->
      <p
        v-if="unknownRate && (config.windows.length || config.promotions.length)"
        class="mt-2 rounded bg-amber-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm" /> A schedule and promotions are configured below, and while the
        rate is unknown they change nothing: a discount on a price nobody knows is still a price
        nobody knows.
      </p>
      <p
        v-for="w in warnings"
        :key="w"
        class="mt-2 rounded bg-amber-400/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
      >
        <WarnIcon class="icon-sm" /> {{ w }}
      </p>
    </section>

    <!-- what is actually charged right now, and when that changes -->
    <section class="card p-3">
      <h3 class="label mb-2">Effective price now</h3>
      <EffectiveRates
        :snapshot="snapshot"
        :now="now"
        :components="card.components"
        :unit="card.unit"
      />
    </section>

    <!-- advanced: shut unless this endpoint already uses them -->
    <details class="card p-3" :open="hasSchedule">
      <summary class="label cursor-pointer select-none">
        Peak / off-peak schedule
        <span class="ml-1 font-normal normal-case text-zinc-400">
          {{
            config.windows.length
              ? `${config.windows.length} window${config.windows.length === 1 ? "" : "s"} · ${config.timezone}`
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

    <!-- estimated / reserved / recorded -->
    <section class="card p-3">
      <h3 class="label mb-2">Estimated, reserved, recorded</h3>
      <dl class="grid gap-3 sm:grid-cols-3">
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <dt class="text-xs font-medium">Estimated</dt>
          <dd class="mt-1 text-[11px] leading-relaxed text-zinc-500">
            Worked out from these rates before a run starts, from the text to be sent.
            <template v-if="u.kind === 'scripting'"
              >Cache use isn’t knowable in advance, so an estimate assumes <b>none</b> and the real
              figure comes in at or under it.</template
            >
            It moves when you change the rates, and it is never charged to anything.
          </dd>
        </div>
        <div class="rounded-md border border-zinc-200 p-2.5 dark:border-zinc-800">
          <dt class="text-xs font-medium">Reserved</dt>
          <dd class="mt-1 font-mono text-sm">
            {{
              u.kind === "scripting"
                ? money(libraryStore.books.reduce((n, b) => n + jobsStore.scriptReserved(b.id), 0))
                : "—"
            }}
          </dd>
          <dd class="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
            <template v-if="u.kind === 'scripting'"
              >Held against the budget while requests are in flight — input cost plus the
              <b>whole</b> output ceiling, at the <b>undiscounted</b> rates, so neither a long
              answer nor a promotion ending mid-run can push a run past its cap. Released and
              replaced by the real figure when each request settles.</template
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
            Priced per request, from the usage that actually came back, at the rates in force when
            each one completed. Changing a rate today does not re-price yesterday.
            <span v-if="totals?.unknownCost" class="text-amber-600 dark:text-amber-400"
              >{{ totals.unknownCost }} of these could not be priced.</span
            >
            <span v-if="totals?.estimatedCost" class="text-amber-600 dark:text-amber-400"
              >{{ totals.estimatedCost }} are estimates: part of their usage was missing.</span
            >
            <span v-if="totals?.providerReported"
              >{{ totals.providerReported }} were priced from a charge the provider reported
              itself.</span
            >
          </dd>
        </div>
      </dl>

      <!-- what the cache actually did, over the selected range -->
      <div
        v-if="u.kind === 'scripting' && totals"
        class="mt-3 rounded-md border border-zinc-200 p-2.5 text-[11px] leading-relaxed dark:border-zinc-800"
      >
        <div class="mb-1 text-xs font-medium">Cache, as reported</div>
        <template v-if="totals.cacheReported">
          <!-- both halves of the fraction come from the same requests: dividing reported cached
               tokens by every request's input would count traffic that said nothing about its
               cache as a run of misses, which is the one reading this page never makes -->
          <p>
            <b class="font-mono">{{ totals.cachedInputTokens.toLocaleString() }}</b> of
            <b class="font-mono">{{ totals.cacheReportedInputTokens.toLocaleString() }}</b> input
            tokens came back marked as cached —
            <b
              >{{
                totals.cacheReportedInputTokens
                  ? Math.round((totals.cachedInputTokens / totals.cacheReportedInputTokens) * 100)
                  : 0
              }}%</b
            >
            over {{ rangeLabel }}, across the {{ totals.cacheReported }} of
            {{ totals.requests }} requests that reported it.
          </p>
          <p v-if="totals.cacheReported < totals.requests" class="mt-1 text-zinc-500">
            The other {{ totals.requests - totals.cacheReported }} reported no cache detail at all,
            and their
            <b class="font-mono">{{
              (totals.inputTokens - totals.cacheReportedInputTokens).toLocaleString()
            }}</b>
            input tokens are left out of that percentage entirely. They are not counted as misses —
            they are simply unknown, and their cost is an upper bound rather than a fact.
          </p>
          <p v-if="observed" class="mt-1 text-zinc-500">
            This session’s own requests averaged
            {{ Math.round(observed.hitRate * 100) }}% cached over {{ observed.samples }} requests.
            Run estimates can show that figure beside the conservative one; they never use it for a
            budget check.
          </p>
        </template>
        <p v-else class="text-zinc-500">
          Nothing through this endpoint has reported cache detail in {{ rangeLabel }}. Costs are
          worked out with every input token at the ordinary rate and labelled estimates, which is an
          upper bound — not a claim that nothing was cached.
        </p>
      </div>
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
        and are not paid for twice. A budget check never leans on a discount or a cache hit: it uses
        the undiscounted price with no cache savings, because a promotion can expire and an off-peak
        window can close while a run is still going. An endpoint whose rate is unknown can’t be
        checked against a budget at all, which is the other reason not to leave a rate blank for a
        provider that bills you.
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
