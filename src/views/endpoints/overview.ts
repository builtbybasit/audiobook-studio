// What the Endpoints page knows about every endpoint at once: the unified list, each one's history,
// health and live load, and the strip across the top — spend today, what is running, what needs
// attention. The page lays it out and handles what is pressed; this is what it reads.
//
// Where the numbers come from:
//   · what is running now  — the queue in the store (`live.ts`)
//   · everything historical — `useEndpointHistory`: the rows of the server's ledger, each a
//     request a job really sent (a simulated endpoint's marked simulated)
//   · a book's spending — the jobs store, which holds the server's figures
import { computed, watch } from "vue";
import { useNow } from "@vueuse/core";
import { keyInPlace } from "@/services/endpointSettings";
import { probeCost, seriesFrom, RANGES } from "@/services/endpoints";
import type { EndpointDescriptor } from "@/services/endpoints";
import { useEndpointHistory, useEndpointLive, useLibrarySpend } from "@/queries";
import { billingOf, endpointErrors, healthOf, rateCardOf, unifiedOf } from "@/lib/endpoints";
import type { Health, UnifiedEndpoint } from "@/lib/endpoints";
import { scriptTelemetry } from "@/lib/scriptActivity";
import { useEndpointsStore } from "@/stores/endpoints";
import { useEndpointActivity } from "@/views/endpoints/live";
import { ui } from "@/views/endpoints/state";
import type { RequestRecord } from "@/types";

export function useEndpointOverview() {
  const endpointsStore = useEndpointsStore();
  const { jobsUsing, liveActivity, liveRequests } = useEndpointActivity();
  // health, "today" and the activity window all move with the clock
  const clock = useNow({ interval: 1000 });
  const now = computed(() => clock.value.getTime());
  // the busy slots, waiting lines and cooldowns are the server's gate's, read while narration runs
  useEndpointLive();

  // ---------- the unified list ----------
  const all = computed<UnifiedEndpoint[]>(() => unifiedOf(endpointsStore));
  const list = computed(() => {
    const q = ui.search.trim().toLowerCase();
    return all.value.filter((u) => {
      if (ui.kind !== "all" && u.kind !== ui.kind) return false;
      if (!q) return true;
      return `${u.name} ${u.model} ${u.baseUrl}`.toLowerCase().includes(q);
    });
  });

  // ---------- history ----------
  // One pull of the widest range per endpoint; every shorter range is bucketed from it locally.
  const describe = (u: UnifiedEndpoint): EndpointDescriptor => {
    const { base, config } = rateCardOf(u);
    return {
      key: u.key,
      id: u.id,
      kind: u.kind,
      pricing: { base, config },
      // only a speech probe is priced on its billing model; the others have their own
      billing: u.endpoint ? billingOf(u.endpoint) : undefined,
    };
  };

  const history = useEndpointHistory(() => all.value.map(describe));
  const histories = history.histories;
  const loading = computed(() => history.status.value === "pending");
  // the budget table and the wait reasons set each book's spending against its cap
  useLibrarySpend();

  const rangeLabel = computed(() => RANGES.find((r) => r.value === ui.range)!.label);

  /**
   * Every settled request against this endpoint: the rows of the server's append-only ledger, which
   * keeps a request once it has settled whatever later happens to what it produced.
   */
  const settledFor = (u: UnifiedEndpoint): RequestRecord[] => histories.value[u.key] ?? [];

  /** Buckets for one endpoint over one range, folded from its records. */
  const seriesFor = (u: UnifiedEndpoint, range = ui.range) =>
    seriesFrom(settledFor(u), u.kind, range, now.value);

  const liveFor = (u: UnifiedEndpoint) => liveActivity(u);

  /** What a scripting endpoint's recent requests at its reasoning level spent thinking, once one said. */
  const reasoningFor = (u: UnifiedEndpoint) =>
    u.profile ? scriptTelemetry(settledFor(u), u.profile).reasoning : undefined;

  function healthFor(u: UnifiedEndpoint): Health {
    const rows = histories.value[u.key] ?? [];
    return healthOf(u, {
      hasKey: keyInPlace(u.entry),
      errors: endpointErrors(u),
      now: now.value,
      totals: loading.value ? null : seriesFor(u).totals,
      lastSeen: rows.length ? (rows[0].finishedAt ?? rows[0].queuedAt) : null,
      tested: !!ui.tests[u.key]?.ok,
    });
  }

  /**
   * What pressing Test would cost, priced the same way the test itself prices it: through the shared
   * engine, at the rates in force now. Working it out from the base rates here and from the engine
   * there would disagree with itself the moment an off-peak window opened or a promotion started.
   */
  const probeCostOf = (u: UnifiedEndpoint): number | null => probeCost(describe(u), now.value);

  // ---------- the selected endpoint ----------
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

  /** In flight now, then what has settled — newest first. */
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
  /** What one endpoint has been charged since midnight. */
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

  return {
    all,
    list,
    loading,
    rangeLabel,
    settledFor,
    liveFor,
    reasoningFor,
    healthFor,
    probeCostOf,
    jobsUsing,
    selected,
    series,
    live,
    health,
    busyJobs,
    activityRows,
    spendToday,
    spendTodayFor,
    totals,
    attention,
  };
}
