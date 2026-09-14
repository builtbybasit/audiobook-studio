<script setup lang="ts">
// Endpoint pool as master/detail: a compact list on the left (health, voices, on/off), the selected
// endpoint's full settings on the right — connection, key (kept in the keyring, not the store),
// price, concurrency, per-request limit + cut strategy with a preview, the voice list, last error.
// Settings export/import writes a JSON without keys.
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useApp, keyring } from "@/stores/app";
import { speak } from "@/composables/usePlayer";
import { UiSlider, UiSelect, UiSwitch, UiTooltip } from "@/ui";
import { SPLIT_MODES, splitText } from "@/lib/split";
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui";
import type { Endpoint, Gender, Segment, SplitMode, Voice } from "@/types";
const props = defineProps<{ bookId: string }>();
const app = useApp();
const now = ref(Date.now());
let t: ReturnType<typeof setInterval>;
onMounted(() => {
  t = setInterval(() => (now.value = Date.now()), 500);
});
onUnmounted(() => clearInterval(t));
const selectedId = ref<string | null>(app.endpoints[0]?.id ?? null);
const e = computed(() => app.endpoints.find((x) => x.id === selectedId.value) ?? app.endpoints[0]);
watch(
  () => app.endpoints.length,
  () => {
    if (!app.endpoints.some((x) => x.id === selectedId.value))
      selectedId.value = app.endpoints.at(-1)?.id ?? null;
  },
);

/** Per-endpoint "add a voice" form state, kept out of the store. */
interface VoiceDraft {
  id: string;
  label: string;
  gender: Gender;
  open: boolean;
}
const draft = reactive<Record<string, VoiceDraft>>({});
const form = (e: Endpoint): VoiceDraft =>
  (draft[e.id] ??= { id: "", label: "", gender: "n", open: false });
const GENDERS: { value: Gender; label: string }[] = [
  { value: "f", label: "female" },
  { value: "m", label: "male" },
  { value: "n", label: "neutral" },
];
const LIMITS = [
  { value: 0, label: "no limit" },
  { value: 300, label: "300" },
  { value: 500, label: "500" },
  { value: 1000, label: "1,000" },
  { value: 2000, label: "2,000" },
  { value: 4096, label: "4,096" },
];
const MODE_OPTS = SPLIT_MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint }));
const AT: Record<SplitMode, string> = {
  sentence: "sentence end",
  clause: "clause",
  word: "word",
  char: "hard cut",
};
function submit(e: Endpoint) {
  const f = form(e);
  if (app.addVoice(e, f)) {
    f.id = "";
    f.label = "";
  }
}
const usedBy = (e: Endpoint, v: Voice) =>
  (app.characters[props.bookId] ?? [])
    .filter((c) => c.voice === `${e.id}/${v.id}`)
    .map((c) => c.name);
const inUse = computed(() => {
  const m: Record<string, number> = {};
  for (const c of app.characters[props.bookId] ?? [])
    if (c.voice) m[c.voice.split("/")[0]] = (m[c.voice.split("/")[0]] ?? 0) + 1;
  return m;
});
const GENDER_CH: Partial<Record<Gender, string>> = { m: "♂", f: "♀", n: "◦" };
const splitOf = (e: Endpoint) => app.splitCount(props.bookId, e);
const longest = (e: Endpoint): Segment | null => {
  let best: Segment | null = null;
  for (const k of Object.keys(app.segments))
    if (k.startsWith(props.bookId + ":"))
      for (const s of app.segments[k])
        if (
          app.effectiveVoice(props.bookId, s.speaker).endpoint?.id === e.id &&
          (!best || s.text.length > best.text.length)
        )
          best = s;
  return best;
};
const preview = (e: Endpoint) => {
  const s = longest(e);
  return s ? { seg: s, parts: splitText(s.text, e.maxChars, e.splitAt) } : null;
};
const cutPreview = computed(() => preview(e.value));

function spark(e: Endpoint) {
  const h = (e.history ?? []).slice(-30);
  if (!h.length) return "";
  const max = Math.max(...h.map((x) => x.ms)) || 1;
  return h
    .map(
      (x, i) =>
        `${((i / Math.max(1, h.length - 1)) * 100).toFixed(1)},${(28 - (x.ms / max) * 26).toFixed(1)}`,
    )
    .join(" ");
}
const avg = (e: Endpoint) => {
  const h = (e.history ?? []).slice(-30);
  return h.length ? Math.round(h.reduce((a, x) => a + x.ms, 0) / h.length) : null;
};
const okRate = (e: Endpoint) => {
  const h = (e.history ?? []).slice(-30);
  return h.length ? Math.round((h.filter((x) => x.ok).length / h.length) * 100) : null;
};
const backoff = (e: Endpoint) => Math.max(0, Math.ceil((e.backoffUntil - now.value) / 1000));
const health = (e: Endpoint) =>
  !e.enabled
    ? "paused"
    : backoff(e)
      ? "backing off"
      : (okRate(e) ?? 100) < 85
        ? "degraded"
        : "healthy";
const healthCls: Record<string, string> = {
  healthy: "text-emerald-500",
  degraded: "text-amber-500",
  "backing off": "text-violet-500",
  paused: "text-zinc-400",
};
const dotCls: Record<string, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  "backing off": "bg-violet-500 animate-pulse",
  paused: "bg-zinc-400",
};
const ago = (ts: number) => {
  const s = Math.round((now.value - ts) / 1000);
  return s < 60
    ? `${s}s ago`
    : s < 3600
      ? `${Math.round(s / 60)}m ago`
      : `${Math.round(s / 3600)}h ago`;
};

// settings file: endpoints + profiles + script settings, never keys
function exportSettings() {
  const blob = new Blob([JSON.stringify(app.exportSettings(), null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "audiobook-studio-settings.json";
  a.click();
  URL.revokeObjectURL(a.href);
  app.toast("Settings exported", {
    kind: "success",
    description: "audiobook-studio-settings.json — API keys are never included.",
    timeout: 4000,
  });
}
function importSettings(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  f.text().then((txt: string) => {
    try {
      app.importSettings(JSON.parse(txt));
    } catch (err) {
      app.toast("Could not import settings", {
        kind: "error",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  });
  input.value = "";
}
function copyErr(e: Endpoint) {
  navigator.clipboard?.writeText(
    JSON.stringify(
      { endpoint: e.baseUrl + "/audio/speech", model: e.model, lastError: e.lastError },
      null,
      2,
    ),
  );
  app.toast("Copied", {
    kind: "success",
    description: "Last error and request details are on the clipboard.",
    timeout: 2500,
  });
}
</script>
<template>
  <div class="grid gap-3 p-3 lg:grid-cols-[260px_minmax(0,1fr)]">
    <!-- list -->
    <div class="flex flex-col gap-1">
      <div class="mb-1 flex items-center gap-1 text-[11px]">
        <span class="label">Endpoints</span>
        <span class="ml-auto flex gap-2">
          <button
            class="text-zinc-400 hover:text-violet-500"
            title="download endpoints + profiles as JSON (no keys)"
            @click="exportSettings"
          >
            ⤓ export
          </button>
          <label
            class="cursor-pointer text-zinc-400 hover:text-violet-500"
            title="import a settings JSON"
            >⤒ import<input
              type="file"
              accept="application/json"
              class="hidden"
              @change="importSettings"
          /></label>
        </span>
      </div>
      <button
        v-for="x in app.endpoints"
        :key="x.id"
        class="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm"
        :class="
          x.id === e?.id
            ? 'border-violet-400 bg-violet-50 dark:bg-violet-500/10'
            : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/60'
        "
        @click="selectedId = x.id"
      >
        <span class="h-2 w-2 shrink-0 rounded-full" :class="dotCls[health(x)]"></span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium" :class="!x.enabled && 'text-zinc-400'">{{
            x.name
          }}</span>
          <span class="block truncate text-[11px] text-zinc-500"
            >{{ x.voices.length }} voices<span v-if="inUse[x.id]"> · {{ inUse[x.id] }} in use</span>
            · {{ x.price ? "$" + x.price + "/1M" : "free"
            }}<span v-if="x.needsKey && !keyring.has(x.id)" class="text-red-500"> · no key</span
            ><span v-if="x.maxChars"> · ≤{{ x.maxChars }}</span></span
          >
        </span>
        <UiSwitch
          :model-value="x.enabled"
          @update:model-value="(v) => (x.enabled = v)"
          @click.stop
        />
      </button>
      <button
        class="rounded-lg border border-dashed border-zinc-300 py-2 text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
        @click="selectedId = app.addEndpoint().id"
      >
        ＋ Add endpoint
      </button>
    </div>

    <!-- detail -->
    <div
      v-if="e"
      class="min-w-0 rounded-lg border p-3 text-sm"
      :class="e.enabled ? 'border-emerald-400/60' : 'border-zinc-200 dark:border-zinc-800'"
    >
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <span class="h-2 w-2 rounded-full" :class="dotCls[health(e)]"></span>
        <input
          v-model="e.name"
          class="min-w-0 flex-1 bg-transparent font-medium focus:outline-none"
        />
        <span class="text-[11px] font-semibold capitalize" :class="healthCls[health(e)]"
          >{{ health(e)
          }}<span v-if="backoff(e)" class="ml-1 font-mono font-normal text-zinc-400"
            >{{ backoff(e) }}s</span
          ></span
        >
        <button class="btn-ghost btn-xs" @click="e.enabled = !e.enabled">
          {{ e.enabled ? "❚❚ Pause" : "▶ Resume" }}
        </button>
        <button
          class="text-[11px] text-zinc-400 hover:text-red-500"
          @click="app.removeEndpoint(e.id)"
        >
          remove
        </button>
      </div>
      <div
        v-if="!e.enabled && inUse[e.id]"
        class="mb-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
      >
        {{ inUse[e.id] }} speaker{{ inUse[e.id] === 1 ? "" : "s" }} in this book use a voice from
        this endpoint — their lines can’t render while it’s paused.
      </div>

      <div
        class="mb-3 flex items-center gap-3 rounded-md bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800/60"
      >
        <svg viewBox="0 0 100 30" class="h-7 w-24 shrink-0" preserveAspectRatio="none">
          <polyline
            :points="spark(e)"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            class="text-violet-500"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <div class="grid flex-1 grid-cols-3 gap-2 text-[11px] leading-tight">
          <div>
            <div class="text-zinc-400">latency</div>
            <div class="font-mono">{{ avg(e) ? (avg(e)! / 1000).toFixed(1) + "s" : "—" }}</div>
          </div>
          <div>
            <div class="text-zinc-400">ok rate</div>
            <div class="font-mono" :class="(okRate(e) ?? 100) < 85 && 'text-amber-500'">
              {{ okRate(e) != null ? okRate(e) + "%" : "—" }}
            </div>
          </div>
          <div>
            <div class="text-zinc-400">failed · 429</div>
            <div class="font-mono">{{ e.failures ?? 0 }} · {{ e.rateLimits ?? 0 }}</div>
          </div>
        </div>
      </div>
      <div
        v-if="e.lastError"
        class="mb-3 rounded-md border border-red-300 bg-red-500/5 px-2 py-1.5 text-[11px] dark:border-red-500/40"
      >
        <div class="flex items-center gap-2">
          <b class="text-red-600">last error · HTTP {{ e.lastError.code || "—" }}</b
          ><span>{{ e.lastError.message }}</span
          ><span v-if="e.lastError.retryAfter" class="text-zinc-500"
            >· retry-after {{ e.lastError.retryAfter }}s</span
          ><span class="ml-auto text-zinc-400">{{ e.lastError.at ? ago(e.lastError.at) : "" }}</span
          ><button class="text-violet-500 hover:underline" @click="copyErr(e)">copy</button>
        </div>
        <pre
          v-if="e.lastError.body"
          class="mt-1 max-h-16 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-1.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
          >{{ e.lastError.body }}</pre>
      </div>

      <div class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
        <span class="text-zinc-500">Base URL</span
        ><input v-model="e.baseUrl" class="input py-0.5 font-mono" />
        <span class="text-zinc-500">API key</span>
        <div class="flex items-center gap-2">
          <input
            :value="keyring.get(e.id)"
            type="password"
            class="input min-w-0 flex-1 py-0.5 font-mono"
            :placeholder="
              e.needsKey ? 'paste key — kept in memory, never saved or exported' : 'not needed'
            "
            @input="keyring.set(e.id, ($event.target as HTMLInputElement).value)"
          />
          <span
            v-if="e.needsKey && !keyring.has(e.id)"
            class="rounded bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-500"
            >no key</span
          >
          <UiSwitch
            :model-value="e.needsKey"
            label="required"
            @update:model-value="(v) => (e.needsKey = v)"
          />
        </div>
        <span class="text-zinc-500">Model</span
        ><input v-model="e.model" class="input py-0.5 font-mono" />
        <span class="text-zinc-500">Price</span>
        <div class="flex items-center gap-1">
          <span>$</span
          ><input v-model.number="e.price" type="number" class="input w-20 py-0.5" /><span
            class="text-zinc-400"
            >per 1M chars</span
          >
        </div>
        <span class="text-zinc-500">Concurrency</span>
        <div class="flex items-center gap-2">
          <UiSlider v-model="e.concurrency" :min="1" :max="8" label="Concurrency" /><span
            class="w-4 font-mono"
            >{{ e.concurrency }}</span
          >
        </div>
        <span class="self-center text-zinc-500">Max chars / request</span>
        <div class="flex flex-wrap items-center gap-2">
          <input
            v-model.number="e.maxChars"
            type="number"
            min="0"
            step="50"
            class="input w-20 py-0.5 font-mono"
            placeholder="0"
          />
          <UiSelect
            :model-value="LIMITS.some((l) => l.value === e.maxChars) ? e.maxChars : undefined"
            :options="LIMITS"
            placeholder="preset"
            size="xs"
            class="w-24"
            @update:model-value="(v) => (e.maxChars = Number(v))"
          />
          <UiTooltip
            text="Segments longer than this are cut, sent as several requests, and the audio joined. 0 = send whole segments."
          >
            <span class="text-zinc-400">
              <template v-if="!e.maxChars">whole segments</template>
              <template v-else-if="splitOf(e)"
                ><span class="text-amber-600"
                  >{{ splitOf(e) }} segment{{ splitOf(e) === 1 ? "" : "s" }} in this book would be
                  split</span
                ></template
              >
              <template v-else>nothing in this book exceeds it</template>
            </span>
          </UiTooltip>
        </div>
        <template v-if="e.maxChars">
          <span class="self-center text-zinc-500">Cut at</span>
          <div class="flex flex-wrap items-center gap-2">
            <UiSelect v-model="e.splitAt" :options="MODE_OPTS" size="xs" class="w-36" /><span
              class="text-zinc-400"
              >falls back to the next finer boundary when none fits</span
            >
          </div>
        </template>
      </div>
      <CollapsibleRoot
        v-if="e.maxChars && (cutPreview?.parts.length ?? 0) > 1"
        class="mt-2 text-xs"
      >
        <CollapsibleTrigger
          class="text-zinc-400 hover:text-violet-500 data-[state=open]:text-violet-500"
          >▸ preview: longest routed segment ({{ cutPreview!.seg.text.length }} chars,
          {{ cutPreview!.seg.speaker }}) →
          {{ cutPreview!.parts.length }} requests</CollapsibleTrigger
        >
        <CollapsibleContent>
          <ol class="mt-1 space-y-1">
            <li
              v-for="(pt, i) in cutPreview!.parts"
              :key="i"
              class="rounded border border-zinc-200 px-2 py-1 dark:border-zinc-800"
            >
              <div class="mb-0.5 flex gap-2 font-mono text-[10px] text-zinc-400">
                <span>part {{ i + 1 }}</span
                ><span>{{ pt.text.length }} ch</span
                ><span v-if="pt.at" :class="pt.fallback && 'text-amber-600'"
                  >cut at {{ AT[pt.at]
                  }}{{ pt.fallback ? " (no " + AT[e.splitAt] + " in range)" : "" }}</span
                >
              </div>
              <div class="line-clamp-2 text-zinc-600 dark:text-zinc-400">{{ pt.text }}</div>
            </li>
          </ol>
        </CollapsibleContent>
      </CollapsibleRoot>

      <!-- voices -->
      <div class="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
        <div class="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
          <b>Voices</b><span class="text-zinc-400">{{ e.voices.length }}</span>
          <span v-if="inUse[e.id]" class="text-zinc-400">· {{ inUse[e.id] }} in use here</span>
          <span class="ml-auto flex gap-1">
            <button class="btn-ghost btn-xs" :disabled="e.fetching" @click="app.fetchVoices(e)">
              {{ e.fetching ? "fetching…" : "⇣ Fetch from server" }}
            </button>
            <button class="btn-ghost btn-xs" @click="form(e).open = !form(e).open">
              {{ form(e).open ? "close" : "＋ Add voice" }}
            </button>
          </span>
        </div>
        <div
          v-if="!e.voices.length"
          class="rounded border border-dashed border-zinc-300 px-2 py-2 text-[11px] text-zinc-400 dark:border-zinc-700"
        >
          No voices yet — fetch the server’s list or add one by its id. Characters can only pick
          voices that exist here.
        </div>
        <div class="flex flex-wrap gap-1">
          <span
            v-for="v in e.voices"
            :key="v.id"
            class="group inline-flex items-center gap-1 rounded-full border border-zinc-200 py-0.5 pl-2 pr-1 text-[11px] dark:border-zinc-700"
            :class="
              usedBy(e, v).length ? 'border-violet-400 bg-violet-50 dark:bg-violet-500/10' : ''
            "
            :title="usedBy(e, v).length ? 'used by ' + usedBy(e, v).join(', ') : v.id"
          >
            <span class="text-zinc-400">{{ GENDER_CH[v.gender] ?? "◦" }}</span>
            <span>{{ v.label }}</span
            ><span v-if="v.label !== v.id" class="font-mono text-[9px] text-zinc-400">{{
              v.id
            }}</span>
            <span
              v-if="usedBy(e, v).length"
              class="rounded bg-violet-500/15 px-1 font-mono text-[9px] text-violet-600 dark:text-violet-300"
              >{{ usedBy(e, v).length }}</span
            >
            <button
              class="rounded px-1 text-zinc-400 hover:bg-zinc-100 hover:text-violet-500 dark:hover:bg-zinc-800"
              title="demo (browser voice)"
              @click="
                speak('The mountain mist thinned as dawn crept over the outer sect grounds.', v.id)
              "
            >
              ▶
            </button>
            <button
              class="rounded px-1 text-zinc-400 hover:bg-red-500/10 hover:text-red-500"
              :title="
                usedBy(e, v).length
                  ? 'remove — ' + usedBy(e, v).length + ' speaker(s) will show a missing voice'
                  : 'remove'
              "
              @click="app.removeVoice(e, v.id)"
            >
              ✕
            </button>
          </span>
        </div>
        <form
          v-if="form(e).open"
          class="mt-2 flex flex-wrap items-center gap-1.5 text-xs"
          @submit.prevent="submit(e)"
        >
          <input
            v-model="form(e).id"
            class="input w-28 py-0.5 font-mono"
            placeholder="voice id"
            required
          />
          <input v-model="form(e).label" class="input w-24 py-0.5" placeholder="label (optional)" />
          <UiSelect v-model="form(e).gender" :options="GENDERS" size="xs" class="w-24" />
          <button class="btn-primary btn-xs" type="submit">Add</button>
          <span
            v-if="form(e).id && e.voices.some((v) => v.id === form(e).id.trim())"
            class="text-amber-600"
            >already exists</span
          >
        </form>
      </div>
    </div>
    <div
      v-else
      class="grid place-items-center rounded-lg border border-dashed border-zinc-300 p-8 text-sm text-zinc-500 dark:border-zinc-700"
    >
      No endpoints. Add one to start.
    </div>
  </div>
</template>
