<script setup lang="ts">
import { useDemoStore } from "@/stores/demo";
import { useEndpointsStore } from "@/stores/endpoints";
import { useJobsStore } from "@/stores/jobs";
import { useLibraryStore } from "@/stores/library";
import { useScriptsStore } from "@/stores/scripts";
import { useUiStore } from "@/stores/ui";
import { useUsageStore } from "@/stores/usage";

// Endpoints — app-wide, both kinds, one page.
//
// The app talks to two sorts of OpenAI-compatible server: chat models that turn prose into a
// script, and speech models that render a line. They used to be configured in two different places,
// each buried inside a book's stage, which made "what is running, what is broken, what am I
// spending" unanswerable. This page is the answer: a compact overview, a searchable list of every
// endpoint, and the selected one's detail behind the tabs the scripting editor already used.
//
// Where the numbers come from:
//   · what is running now  — the live job simulator in the store (`live.ts`)
//   · everything historical — `endpointService`, which in this build is a fixture generator
// Both are simulated. No provider is called, nothing is billed, and nothing persists.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { keyring } from "@/lib/keyring";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import { UiToggleGroup, UiTooltip } from "@/ui";
import {
  Ban as CancelIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Plus as AddIcon,
  Download as ExportIcon,
  Search as SearchIcon,
  Server as EndpointIcon,
  Upload as ImportIcon,
  TriangleAlert as WarnIcon,
} from "@lucide/vue";
import EndpointCard from "@/views/endpoints/EndpointCard.vue";
import OverviewTab from "@/views/endpoints/OverviewTab.vue";
import ConnectionTab from "@/views/endpoints/ConnectionTab.vue";
import RequestsTab from "@/views/endpoints/RequestsTab.vue";
import ExpressionsTab from "@/views/endpoints/ExpressionsTab.vue";
import VoicesTab from "@/views/endpoints/VoicesTab.vue";
import PricingTab from "@/views/endpoints/PricingTab.vue";
import ActivityTab from "@/views/endpoints/ActivityTab.vue";
import { endpointService, probeCost, seriesFrom, RANGES } from "@/services/endpoints";
import type { EndpointDescriptor } from "@/services/endpoints";
import {
  DOT,
  KIND_LABEL,
  TEXT,
  billingOf,
  endpointErrors,
  ensureOps,
  healthOf,
  money,
  opsOf,
  speechPricing,
  unifyEndpoint,
  unifyProfile,
} from "@/lib/endpoints";
import type { Health, UnifiedEndpoint } from "@/lib/endpoints";
import { bindCredential } from "@/lib/credentials";
import { ensurePricing, pricingOf } from "@/lib/pricing";
import { usageFormatFor } from "@/mock/simulators/usage";
import { useEndpointActivity } from "@/views/endpoints/live";
const { jobsUsing, liveActivity, liveRequests } = useEndpointActivity();
import { TABS, draftDirty, filterOf, tabOf, tabsFor, ui } from "@/views/endpoints/state";
import type { TabId } from "@/views/endpoints/state";
import type { MetricBucket, RequestRecord, SettingsFile } from "@/types";

const demoStore = useDemoStore();
const endpointsStore = useEndpointsStore();
const jobsStore = useJobsStore();
const libraryStore = useLibraryStore();
const scriptsStore = useScriptsStore();
const uiStore = useUiStore();
const usageStore = useUsageStore();
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval>;
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => clearInterval(clock));

// ---------- the unified list ----------
const all = computed<UnifiedEndpoint[]>(() => [
  ...endpointsStore.profiles.map(unifyProfile),
  ...endpointsStore.endpoints.map(unifyEndpoint),
]);
// fill operational defaults in, and restore any credential bindings, whenever the lists change
watch(
  () => [endpointsStore.profiles.length, endpointsStore.endpoints.length] as const,
  () => {
    for (const p of endpointsStore.profiles) {
      ensureOps(p, "scripting");
      // an endpoint saved before advanced pricing existed gets an empty schedule and no promotions,
      // which is exactly "ordinary pricing" — nothing on screen changes for it
      ensurePricing(p);
    }
    for (const e of endpointsStore.endpoints) {
      ensureOps(e, "tts");
      ensurePricing(e);
    }
    for (const u of all.value) {
      const cred = opsOf(u).credentialId;
      if (cred) bindCredential(u.slot, cred);
    }
  },
  { immediate: true },
);

const KIND_FILTERS = [
  { value: "all", label: "All" },
  { value: "scripting", label: "Scripting" },
  { value: "tts", label: "TTS" },
];
const list = computed(() => {
  const q = ui.search.trim().toLowerCase();
  return all.value.filter((u) => {
    if (ui.kind !== "all" && u.kind !== ui.kind) return false;
    if (!q) return true;
    return `${u.name} ${u.model} ${u.baseUrl}`.toLowerCase().includes(q);
  });
});

// ---------- history ----------
// One pull of the widest range per endpoint; every shorter range is bucketed from it locally. A
// real backend would more likely serve pre-aggregated buckets — `EndpointService` leaves room for
// either.
const histories = ref<Record<string, RequestRecord[]>>({});
const loading = ref(true);

const describe = (u: UnifiedEndpoint): EndpointDescriptor => ({
  key: u.key,
  id: u.id,
  kind: u.kind,
  name: u.name,
  model: u.model,
  baseUrl: u.baseUrl,
  concurrency: u.concurrency,
  inPrice: u.profile?.inPrice,
  outPrice: u.profile?.outPrice,
  // the whole rate card, so the fixture prices its invented week at the schedule and promotions
  // that were actually in force at each row's finishing time
  pricing: u.profile ? pricingOf(u.profile) : u.endpoint ? speechPricing(u.endpoint) : undefined,
  usageFormat: u.profile ? usageFormatFor(u.profile.model, u.profile.baseUrl) : undefined,
  billing: u.endpoint ? billingOf(u.endpoint) : undefined,
  maxChars: u.endpoint?.maxChars,
  hasKey: keyring.has(u.slot),
});

async function load() {
  loading.value = true;
  const next: Record<string, RequestRecord[]> = {};
  await Promise.all(
    all.value.map(async (u) => {
      next[u.key] = await endpointService.history(describe(u), "7d");
    }),
  );
  histories.value = next;
  loading.value = false;
}
onMounted(load);
watch(() => all.value.length, load);
// A demo reset or a scenario replaces the rate cards this history was priced from, and the fixture
// service has already dropped it by the time the epoch changes — so pull it again rather than keep
// showing a week priced against a world that is gone.
watch(() => demoStore._epoch, load);

const rangeLabel = computed(() => RANGES.find((r) => r.value === ui.range)!.label);

/**
 * Every settled request against this endpoint: the ones this session actually made, then the
 * fixture service's invented week.
 *
 * The session's own rows come out of the append-only ledger rather than out of the running job
 * simulator, which only knows about work that has not finished yet. Reading the simulator alone
 * made a request disappear from this page the moment it completed — the one point at which it had
 * a receipt worth looking at — and left the page showing unrelated backstory instead.
 */
const settledFor = (u: UnifiedEndpoint): RequestRecord[] => [
  // by id *and* kind: a speech endpoint and a scripting profile may share an id, and the seeded
  // world has an `openai` of each
  ...usageStore.ofEndpoint(u.id, u.kind),
  ...(histories.value[u.key] ?? []),
];

/** Buckets for one endpoint over one range, folded from its records. */
const seriesFor = (u: UnifiedEndpoint, range = ui.range) =>
  seriesFrom(settledFor(u), u.kind, range, now.value);

const liveFor = (u: UnifiedEndpoint) => liveActivity(u);

function healthFor(u: UnifiedEndpoint): Health {
  const rows = histories.value[u.key] ?? [];
  return healthOf(u, {
    hasKey: keyring.has(u.slot),
    errors: endpointErrors(u),
    now: now.value,
    totals: loading.value ? null : seriesFor(u).totals,
    lastSeen: rows.length ? (rows[0].finishedAt ?? rows[0].queuedAt) : null,
    tested: !!ui.tests[u.key]?.ok,
  });
}

// ---------- selection ----------
const selected = computed<UnifiedEndpoint | null>(
  () => all.value.find((u) => u.key === ui.selected) ?? list.value[0] ?? all.value[0] ?? null,
);
watch(
  selected,
  (u) => {
    if (u && ui.selected !== u.key) ui.selected = u.key;
  },
  { immediate: true },
);
const detail = ref<HTMLElement | null>(null);
async function select(u: UnifiedEndpoint) {
  ui.selected = u.key;
  if (window.matchMedia("(max-width: 1023px)").matches) {
    await nextTick();
    detail.value?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

const tab = computed<TabId>({
  get: () => (selected.value ? tabOf(selected.value.key, selected.value.kind) : "overview"),
  set: (v) => {
    if (selected.value) ui.tab[selected.value.key] = v;
  },
});
const tabs = computed(() => tabsFor(selected.value?.kind ?? "tts"));
/** A speech endpoint with no voices can't render anything, so the tab that fixes it says so. */
const noVoices = computed(
  () => !!selected.value?.endpoint && !selected.value.endpoint.voices.length,
);

const series = computed(() => (selected.value ? seriesFor(selected.value) : null));
const live = computed(() =>
  selected.value
    ? liveFor(selected.value)
    : { active: 0, queued: 0, waiting: null, effectiveLimit: 0 },
);
const health = computed(() =>
  selected.value
    ? healthFor(selected.value)
    : ({ state: "idle", label: "", tone: "muted", detail: "" } as Health),
);
const busyJobs = computed(() => (selected.value ? jobsUsing(selected.value) : []));

/** In flight now, then what this session settled, then the sample history — newest first. */
const activityRows = computed(() => {
  const u = selected.value;
  if (!u) return [];
  const from = now.value - RANGES.find((r) => r.value === ui.range)!.ms;
  const settled = settledFor(u).filter((r) => (r.finishedAt ?? r.queuedAt) >= from);
  return [...liveRequests(u, now.value), ...settled];
});

// ---------- the strip ----------
const startOfToday = computed(() => {
  const d = new Date(now.value);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
});
/** What one endpoint has been charged since midnight, this session's own requests included. */
const spendSince = (rows: RequestRecord[]) => {
  let cost = 0;
  let unknown = 0;
  for (const r of rows) {
    if ((r.finishedAt ?? r.queuedAt) < startOfToday.value) continue;
    if (r.cost == null) unknown++;
    else cost += r.cost;
  }
  return { cost, unknown };
};
const spendToday = computed(() =>
  all.value.reduce(
    (acc, u) => {
      const one = spendSince(settledFor(u));
      return { cost: acc.cost + one.cost, unknown: acc.unknown + one.unknown };
    },
    { cost: 0, unknown: 0 },
  ),
);
const spendTodayFor = (u: UnifiedEndpoint) => spendSince(settledFor(u));
const totals = computed(() => {
  let active = 0;
  let queued = 0;
  for (const u of all.value) {
    const l = liveFor(u);
    active += l.active;
    queued += l.queued;
  }
  return { active, queued };
});
const attention = computed(() =>
  all.value
    .map((u) => ({ u, h: healthFor(u) }))
    .filter((x) => ["failing", "misconfigured", "nokey"].includes(x.h.state)),
);

// ---------- actions ----------
function toggleEnabled(u: UnifiedEndpoint, value: boolean) {
  const target = (u.profile ?? u.endpoint)!;
  target.enabled = value;
  uiStore.toast(`${u.name} ${value ? "resumed" : "paused"}`, {
    kind: value ? "success" : "info",
    description: value
      ? "Requests that were waiting start going out again."
      : "New requests wait instead of going out; anything already in flight finishes and is recorded. Use Cancel to stop the jobs themselves.",
    undo: () => {
      target.enabled = !value;
    },
  });
}

const confirmCancel = ref(false);
function cancelWork(u: UnifiedEndpoint) {
  const jobs = jobsUsing(u);
  if (!jobs.length) return;
  for (const j of jobs) jobsStore.cancelJob(j.id);
  confirmCancel.value = false;
  uiStore.toast(`Cancelled ${jobs.length} job${jobs.length === 1 ? "" : "s"} on ${u.name}`, {
    kind: "warn",
    description:
      "Requests already in flight finish and stay recorded. Nothing rendered was deleted.",
  });
}

const testing = ref(false);
async function runTest(u: UnifiedEndpoint) {
  testing.value = true;
  try {
    const result = await endpointService.testConnection(describe(u));
    ui.tests[u.key] = result;
    uiStore.toast(result.ok ? `${u.name} answered` : `${u.name} did not answer`, {
      kind: result.ok ? "success" : "error",
      description: result.detail,
    });
  } finally {
    testing.value = false;
  }
}

/**
 * What pressing Test would cost, priced the same way the test itself prices it: through the shared
 * engine, at the rates in force now. Working it out from the base rates here and from the engine
 * there would disagree with itself the moment an off-peak window opened or a promotion started.
 */
function probeCostOf(u: UnifiedEndpoint): number | null {
  return probeCost(describe(u), now.value);
}

function remove(u: UnifiedEndpoint) {
  if (u.profile) endpointsStore.removeScriptProfile(u.id);
  else endpointsStore.removeEndpoint(u.id);
  delete histories.value[u.key];
  ui.selected = null;
}

function add(kind: "scripting" | "tts") {
  const key =
    kind === "scripting"
      ? "scripting:" + endpointsStore.addScriptProfile()
      : "tts:" + endpointsStore.addEndpoint().id;
  ui.selected = key;
  ui.tab[key] = "connection";
  ui.kind = "all";
  ui.search = "";
}

// ---------- deep links ----------
// A stage inside a book links here to fix one endpoint — `?endpoint=tts:ep1&tab=voices`. The page
// keeps its selection in module state so it survives leaving the route, so a link just writes into
// that state rather than becoming a second source of truth for it.
const route = useRoute();
function applyQuery() {
  const key = route.query.endpoint;
  if (typeof key !== "string" || !all.value.some((u) => u.key === key)) return;
  ui.selected = key;
  ui.kind = "all";
  ui.search = "";
  const wanted = route.query.tab;
  if (typeof wanted === "string" && TABS.some((t) => t.id === wanted))
    ui.tab[key] = wanted as TabId;
}
onMounted(applyQuery);
watch(() => [route.query.endpoint, route.query.tab], applyQuery);

// ---------- settings file ----------
// Endpoints, scripting profiles and script settings as JSON, never keys. It used to live in the
// two per-book stages, which meant a library with no books had no way to move a configuration
// between machines.
function exportSettings() {
  const blob = new Blob([JSON.stringify(endpointsStore.exportSettings(), null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "audiobook-studio-settings.json";
  a.click();
  URL.revokeObjectURL(a.href);
  uiStore.toast("Settings exported", {
    kind: "success",
    description: "audiobook-studio-settings.json — API keys are never included.",
    timeout: 4000,
  });
}
function importSettings(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  void file.text().then((text: string) => {
    try {
      endpointsStore.importSettings(JSON.parse(text) as SettingsFile);
    } catch (error) {
      uiStore.toast("Could not import settings", {
        kind: "error",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  });
  input.value = "";
}

// sample text for the split preview: a real chapter when a book is open
const SAMPLE =
  "The mountain mist thinned as dawn crept over the outer sect grounds. “You are late,” said the steward, without looking up from his ledger. Ji Ning bowed, and said nothing; there was nothing to say that would not cost him another month of hauling water. The steward wrote a line, blotted it, and finally raised his eyes. “Twice this week. The elders notice such things — and so, unfortunately, do I.”";
const sample = computed(() => {
  const b = uiStore.currentBookId;
  const ch = b ? libraryStore.chaptersOf(b).find((c) => !c.excluded) : null;
  return b && ch
    ? { text: scriptsStore.rawText(b, ch.id), label: `ch ${ch.id} · ${ch.title}` }
    : { text: SAMPLE, label: "sample text" };
});

function pickBucket(b: MetricBucket | null) {
  const u = selected.value;
  if (!u) return;
  const f = filterOf(u.key);
  f.window = b ? { from: b.from, to: b.to } : null;
  if (b) ui.tab[u.key] = "activity";
}
</script>

<template>
  <div class="mx-auto max-w-[1400px] space-y-4 p-4 sm:p-6">
    <!-- header -->
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Endpoints</h1>
        <p class="max-w-2xl text-sm text-zinc-500">
          Every scripting and speech endpoint, across every book. Health, throughput and spend come
          from a fixture service — nothing here calls a provider or is billed.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn-ghost btn-xs" @click="add('scripting')">
          <AddIcon class="icon-sm" /> Scripting endpoint
        </button>
        <button class="btn-ghost btn-xs" @click="add('tts')">
          <AddIcon class="icon-sm" /> TTS endpoint
        </button>
        <button
          class="btn-ghost btn-xs"
          title="Download every endpoint, profile and script setting as JSON. Keys are never included."
          @click="exportSettings"
        >
          <ExportIcon class="icon-sm" /> Export
        </button>
        <label
          class="btn-ghost btn-xs cursor-pointer"
          title="Merge a settings JSON into what is configured here"
          ><ImportIcon class="icon-sm" /> Import<input
            type="file"
            accept="application/json"
            class="hidden"
            aria-label="Import a settings file"
            @change="importSettings"
        /></label>
      </div>
    </div>

    <!-- overview strip -->
    <dl class="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <div class="card p-3">
        <dt class="label">Active requests</dt>
        <dd
          class="font-mono text-2xl leading-tight"
          :class="totals.active ? 'text-violet-500' : ''"
        >
          {{ totals.active }}
        </dd>
        <dd class="text-[11px] text-zinc-500">
          across {{ all.filter((u) => u.enabled).length }} enabled endpoint{{
            all.filter((u) => u.enabled).length === 1 ? "" : "s"
          }}
        </dd>
      </div>
      <div class="card p-3">
        <dt class="label">Waiting</dt>
        <dd class="font-mono text-2xl leading-tight">{{ totals.queued }}</dd>
        <dd class="text-[11px] text-zinc-500">queued behind concurrency, order or a cooldown</dd>
      </div>
      <div class="card p-3">
        <dt class="label">Spend today</dt>
        <dd class="font-mono text-2xl leading-tight">{{ money(spendToday.cost) }}</dd>
        <dd
          class="text-[11px]"
          :class="spendToday.unknown ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500'"
        >
          <template v-if="spendToday.unknown"
            >{{ spendToday.unknown }} request{{ spendToday.unknown === 1 ? "" : "s" }} with an
            unknown rate — the real figure is higher</template
          >
          <template v-else>recorded from usage, all endpoints</template>
        </dd>
      </div>
      <button
        class="card p-3 text-left transition-colors hover:border-violet-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        :disabled="!attention.length"
        @click="attention.length && select(attention[0].u)"
      >
        <span class="label">Needs attention</span>
        <span
          class="block font-mono text-2xl leading-tight"
          :class="attention.length ? 'text-red-500' : 'text-emerald-500'"
          >{{ attention.length }}</span
        >
        <span class="block text-[11px] text-zinc-500">
          <template v-if="attention.length"
            >{{ attention.map((a) => a.u.name).join(", ") }} — open</template
          >
          <template v-else>nothing failing, misconfigured or missing a key</template>
        </span>
      </button>
    </dl>

    <div class="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <!-- list -->
      <aside class="min-w-0 space-y-2">
        <div class="relative">
          <SearchIcon
            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 icon"
          />
          <input
            v-model="ui.search"
            class="input w-full pl-7!"
            placeholder="Search endpoints…"
            aria-label="Search endpoints by name, model or URL"
          />
        </div>
        <UiToggleGroup
          v-model="ui.kind"
          :options="KIND_FILTERS"
          block
          @update:model-value="(v) => (ui.kind = v as typeof ui.kind)"
        />
        <div class="max-h-[26rem] space-y-1.5 overflow-y-auto pr-0.5 lg:max-h-[calc(100vh-20rem)]">
          <EndpointCard
            v-for="u in list"
            :key="u.key"
            :u="u"
            :health="healthFor(u)"
            :live="liveFor(u)"
            :selected="u.key === selected?.key"
            @select="select(u)"
            @toggle="(v) => toggleEnabled(u, v)"
          />
          <p
            v-if="!list.length"
            class="rounded-lg border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500 dark:border-zinc-700"
          >
            No endpoint matches “{{ ui.search }}”{{
              ui.kind === "all" ? "" : " in " + (ui.kind === "tts" ? "TTS" : "Scripting")
            }}.
          </p>
        </div>
        <p class="text-[11px] leading-relaxed text-zinc-500">
          {{ all.filter((u) => u.kind === "scripting").length }} scripting ·
          {{ all.filter((u) => u.kind === "tts").length }} speech. Pausing one leaves the rest
          running.
        </p>
      </aside>

      <!-- detail -->
      <section v-if="selected" ref="detail" class="min-w-0">
        <div class="card p-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="truncate text-lg font-semibold">
                  {{ selected.name || "New endpoint" }}
                </h2>
                <span class="chip chip-off">{{ KIND_LABEL[selected.kind] }}</span>
                <span
                  v-if="draftDirty(selected)"
                  class="chip chip-on"
                  title="You have unsaved connection changes"
                  >unsaved</span
                >
              </div>
              <p
                class="mt-0.5 truncate font-mono text-[11px] text-zinc-500"
                :title="`${selected.model || 'model required'} · ${selected.baseUrl}`"
              >
                {{ selected.model || "model required" }} · {{ selected.baseUrl }}
              </p>
              <UiTooltip :text="health.detail">
                <p class="mt-1 flex cursor-help items-center gap-1.5 text-xs">
                  <span class="h-2 w-2 rounded-full" :class="DOT[health.tone]"></span>
                  <span :class="TEXT[health.tone]">{{ health.label }}</span>
                  <span class="text-zinc-500"
                    >· {{ live.active }} in flight, {{ live.queued }} waiting, limit
                    {{ selected.concurrency.toLocaleString() }}</span
                  >
                </p>
              </UiTooltip>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
              <button class="btn-ghost btn-xs" @click="toggleEnabled(selected, !selected.enabled)">
                <component
                  :is="selected.enabled ? PauseIcon : PlayIcon"
                  class="icon-sm icon-fill"
                />
                {{ selected.enabled ? "Pause" : "Resume" }}
              </button>
              <button
                class="btn-ghost btn-xs"
                :disabled="!busyJobs.length"
                :class="
                  busyJobs.length
                    ? 'border-red-300 text-red-600 dark:border-red-500/40 dark:text-red-400'
                    : ''
                "
                @click="confirmCancel = !confirmCancel"
              >
                <CancelIcon class="icon-sm" /> Cancel {{ busyJobs.length || "" }}
              </button>
            </div>
          </div>

          <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
            <b>Pause</b> stops new dispatches and lets requests already in flight finish.
            <b>Cancel</b> stops the jobs themselves.
          </p>

          <div
            v-if="confirmCancel && busyJobs.length"
            class="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[11px] leading-relaxed dark:border-red-500/40 dark:bg-red-500/10"
            role="alertdialog"
          >
            <p>
              <WarnIcon class="icon-sm text-red-500" />
              Cancel {{ busyJobs.length }} unfinished job{{ busyJobs.length === 1 ? "" : "s" }} on
              {{ selected.name }}:
              {{
                busyJobs
                  .map((j) => j.label)
                  .slice(0, 3)
                  .join(", ")
              }}{{ busyJobs.length > 3 ? `, +${busyJobs.length - 3} more` : "" }}.
            </p>
            <p class="mt-1 text-zinc-600 dark:text-zinc-300">
              Requests already in flight are allowed to land and stay in the history with their
              recorded cost. Queued requests are dropped; their chapters go back to what they were
              before the run. Nothing already scripted or rendered is deleted, and no spend is
              refunded or removed.
            </p>
            <div class="mt-2 flex gap-2">
              <button class="btn-ghost btn-xs" @click="confirmCancel = false">Keep running</button>
              <button
                class="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-red-500"
                @click="cancelWork(selected)"
              >
                Cancel {{ busyJobs.length }} job{{ busyJobs.length === 1 ? "" : "s" }}
              </button>
            </div>
          </div>

          <div
            v-if="live.waiting"
            class="mt-2 rounded-md bg-amber-400/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
            role="status"
          >
            {{ live.queued }} request{{ live.queued === 1 ? "" : "s" }} waiting —
            {{
              live.waiting === "paused"
                ? "this endpoint is paused"
                : live.waiting === "concurrency"
                  ? "every slot is busy"
                  : live.waiting === "cooldown"
                    ? "cooling down after a rate limit"
                    : live.waiting === "nokey"
                      ? "no credential is set"
                      : live.waiting === "budget"
                        ? "the budget can’t cover another request"
                        : "an earlier chapter is still going"
            }}.
          </div>
        </div>

        <TabsRoot v-model="tab" class="mt-3">
          <TabsList
            class="mb-3 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800"
            aria-label="Endpoint detail"
          >
            <TabsTrigger
              v-for="t in tabs"
              :key="t.id"
              :value="t.id"
              class="whitespace-nowrap border-b-2 px-2 pb-2 text-xs sm:px-3 sm:text-sm"
              :class="
                tab === t.id
                  ? 'border-violet-500 font-medium text-violet-600 dark:text-violet-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              "
            >
              {{ t.label }}
              <span
                v-if="t.id === 'connection' && draftDirty(selected)"
                class="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-violet-500 align-middle"
                aria-label="unsaved changes"
              ></span>
              <span
                v-else-if="t.id === 'voices' && noVoices"
                class="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle"
                aria-label="no voices yet"
              ></span>
              <span
                v-else-if="t.id === 'voices' && selected.endpoint"
                class="ml-1 text-[11px] text-zinc-400"
                >{{ selected.endpoint.voices.length }}</span
              >
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab
              :u="selected"
              :series="series"
              :loading="loading"
              :health="health"
              :range="ui.range"
              :metric="ui.metric"
              :window="filterOf(selected.key).window"
              @update:range="(r) => (ui.range = r)"
              @update:metric="(m) => (ui.metric = m)"
              @pick="pickBucket"
            />
          </TabsContent>
          <TabsContent value="connection">
            <ConnectionTab
              :u="selected"
              :all="all"
              :busy="busyJobs.length"
              :testing="testing"
              :probe-cost="probeCostOf(selected)"
              @test="runTest(selected)"
              @remove="remove(selected)"
            />
          </TabsContent>
          <TabsContent value="voices"
            ><VoicesTab v-if="selected.endpoint" :key="selected.key" :endpoint="selected.endpoint"
          /></TabsContent>
          <TabsContent value="requests">
            <RequestsTab
              :u="selected"
              :live="live"
              :sample="sample.text"
              :sample-label="sample.label"
            />
          </TabsContent>
          <TabsContent value="pricing">
            <PricingTab
              :u="selected"
              :totals="series?.totals ?? null"
              :range-label="rangeLabel"
              :today="spendTodayFor(selected)"
            />
          </TabsContent>
          <TabsContent value="expressions"
            ><ExpressionsTab
              v-if="selected.endpoint"
              :key="selected.key"
              :endpoint="selected.endpoint"
          /></TabsContent>
          <TabsContent value="activity">
            <ActivityTab
              :u="selected"
              :rows="activityRows"
              :loading="loading"
              :filter="filterOf(selected.key)"
              :range-label="rangeLabel"
            />
          </TabsContent>
        </TabsRoot>
      </section>

      <section v-else class="card grid place-items-center p-10 text-center text-sm text-zinc-500">
        <div>
          <EndpointIcon class="mx-auto mb-2 h-8 w-8 text-zinc-400" />
          <p>No endpoints configured.</p>
          <div class="mt-3 flex justify-center gap-2">
            <button class="btn-primary btn-xs" @click="add('scripting')">
              Add a scripting endpoint
            </button>
            <button class="btn-ghost btn-xs" @click="add('tts')">Add a TTS endpoint</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
