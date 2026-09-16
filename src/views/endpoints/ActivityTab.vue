<script setup lang="ts">
import { useLibraryStore } from "@/stores/library";
import { useUiStore } from "@/stores/ui";

// Every request this endpoint has handled or is about to, in one filterable list.
//
// Two columns that usually get merged are kept apart: `queue` is how long we made the request wait
// for one of our own slots, `response` is how long the provider took. A row that is still waiting
// says why in words — paused, concurrency full, cooling down, no credential, out of budget — rather
// than sitting at "queued" and leaving you to guess.
//
// Click a row for its audit trail: the same strip of labelled facts on every row — model, the three
// legs of the request (waited for a slot, dispatched, answered), attempts, usage, cost and where the
// cost figure came from — with the wait reason or the provider's error stacked above it. They stack
// rather than replace each other, because the timings are most worth reading on the rows that failed.
//
// Error bodies are redacted before they are shown or copied.
import { computed, ref } from "vue";

import { UiSelect, UiToggleGroup } from "@/ui";
import StatusDot from "@/components/StatusDot.vue";
import {
  ChevronRight as ExpandIcon,
  Copy as CopyIcon,
  Hourglass as WaitIcon,
  X as ClearIcon,
} from "@lucide/vue";
import {
  COST_BASIS_DETAIL,
  WAIT_DETAIL,
  WAIT_LABEL,
  compact,
  duration,
  clockOf,
  maybeMoney,
  sanitize,
} from "@/lib/endpoints";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import type { ActivityFilter } from "@/views/endpoints/state";
import type { RequestRecord } from "@/types";

const props = defineProps<{
  u: UnifiedEndpoint;
  rows: RequestRecord[];
  loading: boolean;
  filter: ActivityFilter;
  rangeLabel: string;
}>();

const libraryStore = useLibraryStore();
const uiStore = useUiStore();
const expanded = ref(new Set<string>());
const limit = ref(50);

const STATUS_OPTS = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Waiting" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];
const bookOpts = computed(() => [
  { value: "__all__", label: "Every book" },
  ...libraryStore.books.map((b) => ({ value: b.id, label: b.title })),
]);

const shown = computed(() => {
  const f = props.filter;
  const q = f.search.trim().toLowerCase();
  return props.rows.filter((r) => {
    if (f.status !== "all" && r.status !== f.status) return false;
    if (f.bookId && r.bookId !== f.bookId) return false;
    if (f.window) {
      const t = r.finishedAt ?? r.startedAt ?? r.queuedAt;
      if (t < f.window.from || t > f.window.to) return false;
    }
    if (q) {
      const hay = `${r.label} ${r.error?.message ?? ""} ${r.error?.code ?? ""} ${r.chapterId ?? ""}`;
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });
});
const visible = computed(() => shown.value.slice(0, limit.value));
const filtered = computed(
  () =>
    props.filter.status !== "all" ||
    !!props.filter.bookId ||
    !!props.filter.window ||
    !!props.filter.search.trim(),
);

function toggle(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}
const bookTitle = (id: string | null) => (id ? (libraryStore.bookById(id)?.title ?? id) : "—");
/** hour and minute only — the seconds live in the row's detail strip, and the column is tight */
const hhmm = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const usageOf = (r: RequestRecord): string => {
  const u = r.usage;
  if (r.kind === "scripting")
    return u.inputTokens
      ? `${compact(u.inputTokens)} in / ${compact(u.outputTokens ?? 0)} out`
      : "—";
  if (!u.chars) return "—";
  return `${compact(u.chars)} ch${u.audioSeconds ? ` → ${(u.audioSeconds / 60).toFixed(1)}m` : ""}`;
};

interface Fact {
  label: string;
  value: string;
  mono?: boolean;
  /** a second, muted line under the value: where the number came from, not another number */
  hint?: string;
  /** takes the rest of the line — for the one fact whose hint is a whole phrase */
  wide?: boolean;
  tone?: "warn";
}

const FINISH_LABEL: Partial<Record<RequestRecord["status"], string>> = {
  done: "answered",
  failed: "failed at",
  cancelled: "cancelled at",
};

/** The audit trail for one request, as labelled facts. Every row gets the same strip, whatever its
 *  status — a row that is still waiting shows how long it has waited so far rather than a blank. */
function facts(r: RequestRecord): Fact[] {
  const queued = r.status === "queued";
  const out: Fact[] = [
    { label: "model", value: props.u.model || "—", mono: true },
    { label: "request", value: r.id, mono: true },
    { label: "queued", value: clockOf(r.queuedAt), mono: true },
    {
      label: "waited for a slot",
      value: queued
        ? r.queueMs
          ? duration(r.queueMs) + " so far"
          : "just queued"
        : duration(r.queueMs),
      mono: true,
    },
    {
      label: "dispatched",
      value: r.startedAt ? clockOf(r.startedAt) : "not sent yet",
      mono: !!r.startedAt,
    },
  ];
  if (r.startedAt)
    out.push({
      label: "provider took",
      value: duration(r.responseMs) + (r.status === "running" ? " so far" : ""),
      mono: true,
    });
  if (r.finishedAt)
    out.push({
      label: FINISH_LABEL[r.status] ?? "settled",
      value: clockOf(r.finishedAt),
      mono: true,
    });
  out.push({
    label: "attempts",
    value: !r.attempts
      ? "none yet"
      : r.attempts === 1
        ? "first try"
        : `${r.attempts} · retried ${r.attempts - 1}×`,
    tone: r.attempts > 1 ? "warn" : undefined,
  });

  const u = r.usage;
  if (r.kind === "scripting") {
    if (u.inputTokens || u.outputTokens) {
      out.push({ label: "tokens in", value: compact(u.inputTokens ?? 0), mono: true });
      out.push({ label: "tokens out", value: compact(u.outputTokens ?? 0), mono: true });
    } else out.push({ label: "tokens", value: "not reported yet" });
  } else if (u.chars) {
    out.push({ label: "characters", value: compact(u.chars), mono: true });
    if (u.audioSeconds)
      out.push({
        label: "audio",
        value: (u.audioSeconds / 60).toFixed(1) + " min",
        mono: true,
      });
  } else out.push({ label: "characters", value: "not reported yet" });

  out.push({
    label: "cost",
    value: queued || r.status === "running" ? "pending" : maybeMoney(r.cost),
    mono: true,
    hint: COST_BASIS_DETAIL[r.costBasis],
    wide: true,
    tone: r.cost == null && !queued && r.status !== "running" ? "warn" : undefined,
  });
  return out;
}

async function copyDiagnostics(r: RequestRecord) {
  const payload = {
    endpoint: {
      name: props.u.name,
      kind: props.u.kind,
      model: props.u.model,
      baseUrl: props.u.baseUrl,
    },
    request: {
      id: r.id,
      book: r.bookId,
      chapter: r.chapterId,
      status: r.status,
      attempts: r.attempts,
      queuedAt: new Date(r.queuedAt).toISOString(),
      queueMs: Math.round(r.queueMs),
      responseMs: Math.round(r.responseMs),
      usage: r.usage,
      cost: r.cost,
      costBasis: r.costBasis,
    },
    error: r.error
      ? { code: r.error.code, message: r.error.message, body: sanitize(r.error.body) }
      : null,
    note: "Prototype: this row is simulated. No provider was called and no key is included.",
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    uiStore.toast("Diagnostics copied", {
      kind: "success",
      description: "Redacted — no API key is included.",
      timeout: 2500,
    });
  } catch {
    uiStore.toast("Could not copy diagnostics", { kind: "error" });
  }
}

function clearAll() {
  props.filter.status = "all";
  props.filter.bookId = null;
  props.filter.search = "";
  props.filter.window = null;
}
</script>

<template>
  <div class="space-y-2">
    <!-- filters -->
    <div class="flex flex-wrap items-center gap-2">
      <UiToggleGroup
        :model-value="filter.status"
        :options="STATUS_OPTS"
        @update:model-value="(v) => (filter.status = v as ActivityFilter['status'])"
      />
      <UiSelect
        :model-value="filter.bookId ?? '__all__'"
        :options="bookOpts"
        size="xs"
        class="w-40"
        @update:model-value="(v) => (filter.bookId = v === '__all__' ? null : String(v))"
      />
      <input
        v-model="filter.search"
        class="input w-40 py-0.5 text-xs"
        placeholder="Search label or error…"
        aria-label="Search requests"
      />
      <span v-if="filter.window" class="chip chip-on"
        >{{ clockOf(filter.window.from) }}–{{ clockOf(filter.window.to) }}
        <button
          class="ml-1 hover:text-red-500"
          aria-label="Clear the time filter from the chart"
          @click="filter.window = null"
        >
          <ClearIcon class="icon-sm" /></button
      ></span>
      <span class="ml-auto text-[11px] text-zinc-500">
        {{ shown.length }} of {{ rows.length }} · {{ rangeLabel }}
        <button v-if="filtered" class="ml-2 text-violet-500 hover:underline" @click="clearAll">
          clear filters
        </button>
      </span>
    </div>

    <div v-if="loading" class="card grid h-32 place-items-center text-xs text-zinc-500">
      Loading requests…
    </div>
    <div
      v-else-if="!rows.length"
      class="card grid place-items-center p-8 text-center text-sm text-zinc-500"
    >
      <p>
        Nothing has gone through {{ u.name }} in the last {{ rangeLabel }}.<br />
        <span class="text-[11px]"
          >Widen the range on the Overview tab, or start a run to see live requests here.</span
        >
      </p>
    </div>
    <div
      v-else-if="!shown.length"
      class="card grid place-items-center p-8 text-center text-sm text-zinc-500"
    >
      <p>
        No requests match these filters.<br />
        <button class="text-[11px] text-violet-500 hover:underline" @click="clearAll">
          Clear them
        </button>
      </p>
    </div>

    <div v-else class="card overflow-x-auto">
      <table class="w-full min-w-[620px] text-xs">
        <thead class="text-zinc-500">
          <tr class="border-b border-zinc-200 dark:border-zinc-800">
            <th class="w-6 py-2 pl-3"><span class="sr-only">Status</span></th>
            <th class="py-2 pr-3 text-left font-normal">Request</th>
            <th class="py-2 text-left font-normal">Book · chapter</th>
            <th class="px-2 py-2 text-right font-normal">Queue</th>
            <th class="px-2 py-2 text-right font-normal">Response</th>
            <th class="px-2 py-2 text-right font-normal">Usage</th>
            <th class="px-2 py-2 text-right font-normal">Cost</th>
            <th class="whitespace-nowrap py-2 pr-3 text-right font-normal">When</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in visible" :key="r.id">
            <tr
              tabindex="0"
              class="cursor-pointer border-b border-zinc-100 outline-none last:border-0 hover:bg-zinc-50 focus-visible:bg-zinc-100 dark:border-zinc-800/70 dark:hover:bg-zinc-800/40 dark:focus-visible:bg-zinc-800"
              :class="expanded.has(r.id) && 'bg-zinc-50 dark:bg-zinc-800/40'"
              :aria-expanded="expanded.has(r.id)"
              title="click for the request's audit trail"
              @click="toggle(r.id)"
              @keydown.enter.prevent="toggle(r.id)"
              @keydown.space.prevent="toggle(r.id)"
            >
              <td class="py-1.5 pl-3">
                <StatusDot
                  :status="
                    r.status === 'cancelled'
                      ? 'none'
                      : r.status === 'running'
                        ? 'generating'
                        : r.status
                  "
                />
              </td>
              <td class="py-1.5 pr-3">
                <span class="inline-block max-w-[190px] truncate align-middle" :title="r.label">
                  <ExpandIcon
                    class="icon-sm text-zinc-400 transition-transform"
                    :class="expanded.has(r.id) && 'rotate-90'"
                  />{{ r.label }}
                </span>
                <!-- a dot rather than a word: this column is the narrow one, and the marker only
                     has to separate "this session" from the fixture backlog -->
                <span
                  v-if="!r.simulated"
                  class="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-violet-500 align-middle"
                  title="Produced this session"
                  ><span class="sr-only">produced this session</span></span
                >
                <span
                  v-if="r.waiting"
                  class="ml-1 rounded bg-amber-400/15 px-1 text-[10px] text-amber-700 dark:text-amber-300"
                  >{{ WAIT_LABEL[r.waiting] }}</span
                >
                <span
                  v-else-if="r.rateLimited"
                  class="ml-1 rounded bg-amber-400/15 px-1 text-[10px] text-amber-700 dark:text-amber-300"
                  >429</span
                >
                <span
                  v-if="r.attempts > 1"
                  class="ml-1 rounded bg-amber-400/15 px-1 text-[10px] text-amber-700 dark:text-amber-300"
                  :title="`${r.attempts} attempts — retried ${r.attempts - 1}×`"
                  >×{{ r.attempts }}</span
                >
              </td>
              <td class="max-w-[140px] py-1.5 text-zinc-500">
                <RouterLink
                  v-if="r.bookId && r.chapterId"
                  :to="`/book/${r.bookId}/${u.kind === 'scripting' ? 'scripting' : 'narration'}?ch=${r.chapterId}`"
                  class="block truncate hover:text-violet-500"
                  :title="`${bookTitle(r.bookId)} · chapter ${r.chapterId}`"
                  @click.stop
                  >{{ bookTitle(r.bookId) }} · ch {{ r.chapterId }}</RouterLink
                >
                <span v-else>{{ bookTitle(r.bookId) }}</span>
              </td>
              <td class="px-2 py-1.5 text-right font-mono text-zinc-500">
                <!-- a request that has not been dispatched has no queue *time* yet, only a reason -->
                {{
                  r.status === "queued"
                    ? r.queueMs
                      ? duration(r.queueMs) + "…"
                      : "—"
                    : duration(r.queueMs)
                }}
              </td>
              <td class="px-2 py-1.5 text-right font-mono">
                {{
                  r.status === "queued"
                    ? "—"
                    : duration(r.responseMs) + (r.status === "running" ? "…" : "")
                }}
              </td>
              <td class="whitespace-nowrap px-2 py-1.5 text-right font-mono text-zinc-500">
                {{ usageOf(r) }}
              </td>
              <td
                class="px-2 py-1.5 text-right font-mono"
                :class="r.cost == null && 'text-amber-600 dark:text-amber-400'"
              >
                {{
                  r.status === "queued" || r.status === "running" ? "pending" : maybeMoney(r.cost)
                }}
              </td>
              <td
                class="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-zinc-400"
                :title="clockOf(r.finishedAt ?? r.startedAt ?? r.queuedAt)"
              >
                {{ hhmm(r.finishedAt ?? r.startedAt ?? r.queuedAt) }}
              </td>
            </tr>
            <tr v-if="expanded.has(r.id)" class="border-b border-zinc-100 dark:border-zinc-800/70">
              <td colspan="8" class="bg-zinc-50 px-3 py-2.5 dark:bg-zinc-900/60">
                <div class="border-l-2 border-violet-400 pl-3 dark:border-violet-500">
                  <!-- why it has not gone out yet -->
                  <div
                    v-if="r.waiting"
                    class="mb-2 flex items-start gap-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
                  >
                    <WaitIcon class="icon-sm mt-0.5 shrink-0" />
                    <span class="min-w-0 flex-1"
                      ><b>{{ WAIT_LABEL[r.waiting] }}</b> — {{ WAIT_DETAIL[r.waiting] }}</span
                    >
                  </div>

                  <!-- what the provider said back -->
                  <div
                    v-if="r.error"
                    class="mb-2 rounded border border-red-300 bg-red-500/5 px-2 py-1.5 text-[11px] dark:border-red-500/40"
                  >
                    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <b class="text-red-600 dark:text-red-400">{{
                        r.error.code ? "HTTP " + r.error.code : "not sent"
                      }}</b>
                      <span class="min-w-0 flex-1">{{ r.error.message }}</span>
                      <span v-if="r.error.retryAfter" class="shrink-0 text-zinc-500"
                        >retry-after {{ r.error.retryAfter }}s</span
                      >
                    </div>
                    <pre
                      v-if="r.error.body"
                      class="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-[10px] text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400"
                      >{{ sanitize(r.error.body) }}</pre>
                    <p v-if="r.error.body" class="mt-1 text-zinc-500">
                      Redacted before display: anything key-shaped in the provider’s reply is
                      replaced with <code class="font-mono">[redacted]</code>.
                    </p>
                  </div>

                  <!-- what the request was sent as, and what each leg of it took -->
                  <div class="flex items-start gap-3">
                    <div class="flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-1.5">
                      <div
                        v-for="f in facts(r)"
                        :key="f.label"
                        class="min-w-0"
                        :class="f.wide ? 'min-w-[12rem] flex-1' : 'max-w-[220px]'"
                      >
                        <div class="text-[9px] uppercase tracking-wider text-zinc-400">
                          {{ f.label }}
                        </div>
                        <div
                          class="truncate text-[11px]"
                          :class="[
                            f.mono && 'font-mono',
                            f.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
                          ]"
                          :title="f.value"
                        >
                          {{ f.value }}
                        </div>
                        <div
                          v-if="f.hint"
                          class="text-[10px] text-zinc-400"
                          :class="f.wide ? 'leading-snug' : 'truncate'"
                          :title="f.hint"
                        >
                          {{ f.hint }}
                        </div>
                      </div>
                    </div>
                    <button
                      class="shrink-0 text-[11px] text-violet-600 hover:underline dark:text-violet-400"
                      title="this request as JSON, with the error body redacted"
                      @click.stop="copyDiagnostics(r)"
                    >
                      <CopyIcon class="icon-sm" /> Copy
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <div
        v-if="shown.length > visible.length"
        class="border-t border-zinc-100 px-3 py-2 text-center dark:border-zinc-800"
      >
        <button class="btn-ghost btn-xs" @click="limit += 100">
          Show more ({{ shown.length - visible.length }} left)
        </button>
      </div>
    </div>

    <p class="text-[11px] leading-relaxed text-zinc-500">
      A <span class="inline-block h-1.5 w-1.5 rounded-full bg-violet-500 align-middle"></span> marks
      a request this session produced; the rest is sample history from the fixture service, shown so
      the page has something to read. Nothing here was billed.
    </p>
  </div>
</template>
