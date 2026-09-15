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
// Error bodies are redacted before they are shown or copied.
import { computed, ref } from "vue";

import { UiSelect, UiToggleGroup } from "@/ui";
import StatusDot from "@/components/StatusDot.vue";
import { ChevronRight as ExpandIcon, Copy as CopyIcon, X as ClearIcon } from "@lucide/vue";
import {
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
const usageOf = (r: RequestRecord): string => {
  const u = r.usage;
  if (r.kind === "scripting")
    return u.inputTokens
      ? `${compact(u.inputTokens)} in / ${compact(u.outputTokens ?? 0)} out`
      : "—";
  if (!u.chars) return "—";
  return `${compact(u.chars)} ch${u.audioSeconds ? ` → ${(u.audioSeconds / 60).toFixed(1)}m` : ""}`;
};

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
      <table class="w-full min-w-[700px] text-xs">
        <thead class="text-zinc-500">
          <tr class="border-b border-zinc-200 dark:border-zinc-800">
            <th class="w-6 py-2 pl-3"><span class="sr-only">Status</span></th>
            <th class="py-2 text-left font-normal">Request</th>
            <th class="py-2 text-left font-normal">Book · chapter</th>
            <th class="px-2 py-2 text-right font-normal">Attempts</th>
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
              class="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/70 dark:hover:bg-zinc-800/40"
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
              <td class="py-1.5">
                <button
                  class="max-w-[190px] truncate text-left align-middle hover:text-violet-500"
                  :aria-expanded="expanded.has(r.id)"
                  :title="r.label"
                  @click="toggle(r.id)"
                >
                  <ExpandIcon
                    class="icon-sm text-zinc-400 transition-transform"
                    :class="expanded.has(r.id) && 'rotate-90'"
                  />{{ r.label }}
                </button>
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
              </td>
              <td class="max-w-[170px] py-1.5 text-zinc-500">
                <RouterLink
                  v-if="r.bookId && r.chapterId"
                  :to="`/book/${r.bookId}/${u.kind === 'scripting' ? 'scripting' : 'narration'}?ch=${r.chapterId}`"
                  class="block truncate hover:text-violet-500"
                  :title="`${bookTitle(r.bookId)} · chapter ${r.chapterId}`"
                  >{{ bookTitle(r.bookId) }} · ch {{ r.chapterId }}</RouterLink
                >
                <span v-else>{{ bookTitle(r.bookId) }}</span>
              </td>
              <td
                class="px-2 py-1.5 text-right font-mono"
                :class="r.attempts > 1 && 'text-amber-600 dark:text-amber-400'"
              >
                {{ r.attempts || "—" }}
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
              <td class="px-2 py-1.5 text-right font-mono text-zinc-500">{{ usageOf(r) }}</td>
              <td
                class="px-2 py-1.5 text-right font-mono"
                :class="r.cost == null && 'text-amber-600 dark:text-amber-400'"
              >
                {{
                  r.status === "queued" || r.status === "running" ? "pending" : maybeMoney(r.cost)
                }}
              </td>
              <td class="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-zinc-400">
                {{ clockOf(r.finishedAt ?? r.startedAt ?? r.queuedAt) }}
              </td>
            </tr>
            <tr v-if="expanded.has(r.id)" class="border-b border-zinc-100 dark:border-zinc-800/70">
              <td colspan="9" class="bg-zinc-50 px-3 py-2 dark:bg-zinc-900/60">
                <div v-if="r.waiting" class="text-[11px] leading-relaxed">
                  <b class="text-amber-700 dark:text-amber-300">{{ WAIT_LABEL[r.waiting] }}</b> —
                  {{ WAIT_DETAIL[r.waiting] }}
                </div>
                <div v-else-if="r.error" class="text-[11px]">
                  <div class="flex flex-wrap items-center gap-2">
                    <b class="text-red-600 dark:text-red-400"
                      >HTTP {{ r.error.code || "—" }} · {{ r.error.message }}</b
                    >
                    <span v-if="r.error.retryAfter" class="text-zinc-500"
                      >retry-after {{ r.error.retryAfter }}s</span
                    >
                    <span v-if="r.attempts > 1" class="text-zinc-500"
                      >{{ r.attempts }} attempts</span
                    >
                    <button
                      class="ml-auto text-violet-600 hover:underline dark:text-violet-400"
                      @click="copyDiagnostics(r)"
                    >
                      <CopyIcon class="icon-sm" /> Copy diagnostics
                    </button>
                  </div>
                  <pre
                    class="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-[10px] text-zinc-600 dark:bg-zinc-950 dark:text-zinc-400"
                    >{{ sanitize(r.error.body) }}</pre>
                  <p class="mt-1 text-zinc-500">
                    Redacted before display: anything key-shaped in the provider’s reply is replaced
                    with <code class="font-mono">[redacted]</code>.
                  </p>
                </div>
                <div
                  v-else
                  class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500"
                >
                  <span
                    >queued {{ clockOf(r.queuedAt) }} · waited {{ duration(r.queueMs) }} for a
                    slot</span
                  >
                  <span v-if="r.startedAt">dispatched {{ clockOf(r.startedAt) }}</span>
                  <span v-if="r.finishedAt"
                    >answered in {{ duration(r.responseMs) }} at {{ clockOf(r.finishedAt) }}</span
                  >
                  <span>cost basis: {{ r.costBasis }}</span>
                  <button
                    class="ml-auto text-violet-600 hover:underline dark:text-violet-400"
                    @click="copyDiagnostics(r)"
                  >
                    <CopyIcon class="icon-sm" /> Copy diagnostics
                  </button>
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
