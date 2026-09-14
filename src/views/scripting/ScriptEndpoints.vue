<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useApp, keyring } from "@/stores/app";
import { UiNumber, UiSelect, UiSwitch } from "@/ui";
import NumberSlider from "@/components/NumberSlider.vue";
import {
  Check as CheckIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Download as ExportIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  Plus as AddIcon,
  Upload as ImportIcon,
  ArrowUpRight as ArrowIcon,
} from "@lucide/vue";
import { profileErrors, scriptParts, tokenEstimate, scriptingHealth } from "@/lib/scripting";
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from "reka-ui";
import EndpointActivity from "@/views/scripting/EndpointActivity.vue";
import type { Profile, SettingsFile } from "@/types";
import { SPLIT_MODES } from "@/lib/split";
const props = defineProps<{ bookId: string; selected: number[] }>();
const app = useApp();
const selectedId = ref(app.scriptSettings.profile);
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval>;
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 500);
});
onUnmounted(() => clearInterval(clock));
const endpointList = ref<HTMLElement | null>(null);
const health = (ep: Profile) =>
  scriptingHealth(ep, app.scriptTelemetry[ep.id], keyring.has("profile:" + ep.id), now.value);
const tone = (ep: Profile) =>
  ({ good: "bg-emerald-500", warn: "bg-amber-500", muted: "bg-zinc-400" })[health(ep).tone];
watch(selectedId, async () => {
  previewPart.value = 0;
  await nextTick();
  const list = endpointList.value;
  const selected = list?.querySelector<HTMLElement>('[data-selected="true"]');
  if (list && selected) {
    list.scrollTop = selected.offsetTop - list.offsetTop;
    list.scrollLeft = selected.offsetLeft - list.offsetLeft;
  }
});
const p = computed(() => app.profiles.find((p) => p.id === selectedId.value));
const section = ref("connection");
const errors = computed(() => (p.value ? profileErrors(p.value) : []));
const sampleChapter = computed(
  () =>
    app.chaptersOf(props.bookId).find((c) => props.selected.includes(c.id) && !c.excluded) ??
    app.chaptersOf(props.bookId).find((c) => !c.excluded),
);
const parts = computed(() =>
  p.value && sampleChapter.value
    ? scriptParts(app.rawText(props.bookId, sampleChapter.value.id), p.value)
    : [],
);
const previewPart = ref(0);
const preview = computed(
  () => parts.value[Math.min(previewPart.value, parts.value.length - 1)] ?? "",
);
const tokens = computed(() =>
  p.value && preview.value ? tokenEstimate(preview.value, p.value) : null,
);
const money = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 6 });
function exportSettings() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(app.exportSettings(), null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "audiobook-settings.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importSettings(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    app.importSettings(JSON.parse(await file.text()) as SettingsFile);
  } catch (error) {
    app.toast("Could not import settings", {
      kind: "error",
      description: error instanceof Error ? error.message : "Invalid settings file",
    });
  }
  input.value = "";
}
function add() {
  selectedId.value = app.addScriptProfile();
  section.value = "connection";
}
function remove() {
  if (p.value) app.removeScriptProfile(p.value.id);
  if (!p.value) selectedId.value = app.profiles[0]?.id ?? "";
}
</script>
<template>
  <div class="grid grid-cols-1 min-w-0 md:grid-cols-[260px_minmax(0,1fr)]">
    <div
      class="min-w-0 border-b border-zinc-200 p-3 md:sticky md:top-0 md:self-start md:border-b-0 md:border-r dark:border-zinc-800"
    >
      <div class="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <!-- the section heading is itself the way out to the full endpoint page: "all endpoints"
             spelled out alongside export/import cost more width than this column has. -->
        <RouterLink
          to="/endpoints"
          class="label inline-flex items-center gap-1 whitespace-nowrap hover:text-violet-500!"
          title="health, spend and request history for every endpoint"
          aria-label="All endpoints — health, spend and request history"
          >Endpoints <ArrowIcon class="icon-sm"
        /></RouterLink>
        <span class="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <button
            class="inline-flex items-center gap-1 whitespace-nowrap text-zinc-400 hover:text-violet-500"
            title="download endpoints + profiles as JSON (no keys)"
            @click="exportSettings"
          >
            <ExportIcon class="icon-sm" /> export
          </button>
          <label
            class="cursor-pointer inline-flex items-center gap-1 whitespace-nowrap text-zinc-400 hover:text-violet-500"
            title="import a settings JSON"
            ><ImportIcon class="icon-sm" /> import<input
              type="file"
              accept="application/json"
              class="hidden"
              aria-label="Import settings"
              @change="importSettings"
          /></label>
        </span>
      </div>
      <div
        ref="endpointList"
        class="relative flex gap-1 overflow-x-auto md:max-h-[320px] md:flex-col md:overflow-y-auto"
      >
        <div
          v-for="ep in app.profiles"
          :key="ep.id"
          :data-selected="selectedId === ep.id"
          class="relative min-w-56 shrink-0 rounded-lg border transition-colors md:min-w-0"
          :class="
            selectedId === ep.id
              ? 'border-violet-400 bg-violet-50 dark:border-violet-500 dark:bg-violet-500/10'
              : 'border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/60'
          "
        >
          <button
            class="block w-full px-2.5 py-2 text-left"
            :aria-pressed="selectedId === ep.id"
            @click="selectedId = ep.id"
          >
            <span class="flex items-center gap-1.5 pr-9"
              ><span
                class="h-2 w-2 shrink-0 rounded-full"
                :class="tone(ep)"
                :title="health(ep).label"
              ></span
              ><span class="truncate text-sm font-medium" :class="!ep.enabled && 'text-zinc-400'">{{
                ep.name || "Untitled endpoint"
              }}</span
              ><span
                v-if="app.scriptSettings.profile === ep.id"
                class="shrink-0 text-[10px] font-medium text-violet-600 dark:text-violet-400"
                title="runs use this endpoint"
                ><CheckIcon class="icon-sm" /> runs</span
              ></span
            >
            <span class="block truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{{
              ep.model || "Model required"
            }}</span>
            <span class="block truncate text-[11px] text-zinc-500 dark:text-zinc-400"
              >{{ money(ep.inPrice) }} in / {{ money(ep.outPrice) }} out · per 1M tokens</span
            >
          </button>
          <div class="absolute right-2 top-2">
            <UiSwitch v-model="ep.enabled"
              ><span class="sr-only">Enable {{ ep.name }}</span></UiSwitch
            >
          </div>
        </div>
        <button
          class="min-w-56 shrink-0 rounded-lg border border-dashed border-zinc-300 py-2 text-xs text-zinc-500 hover:border-violet-400 hover:text-violet-500 md:min-w-0 dark:border-zinc-700"
          @click="add"
        >
          <AddIcon class="icon-sm" /> Add endpoint
        </button>
      </div>
      <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Choose an endpoint for each run. Jobs keep their model and pricing when you switch.
      </p>
    </div>
    <div v-if="p" class="min-w-0 p-3 sm:p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold">{{ p.name || "New endpoint" }}</h2>
          <p class="mt-0.5 text-[11px] text-zinc-500">OpenAI-compatible · session activity</p>
        </div>
        <div class="flex items-center gap-2">
          <span
            class="flex items-center gap-1.5 text-[11px]"
            :class="
              health(p).tone === 'good'
                ? 'text-emerald-600 dark:text-emerald-400'
                : health(p).tone === 'warn'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-zinc-500'
            "
            ><span class="h-1.5 w-1.5 rounded-full" :class="tone(p)"></span
            >{{ health(p).label }}</span
          >
          <button class="btn-ghost btn-xs" @click="p.enabled = !p.enabled">
            <component :is="p.enabled ? PauseIcon : PlayIcon" class="icon-sm icon-fill" />
            {{ p.enabled ? "Pause" : "Enable" }}</button
          ><button
            v-if="app.scriptSettings.profile !== p.id"
            class="btn-primary btn-xs"
            :disabled="!!errors.length || !p.enabled"
            @click="app.scriptSettings.profile = p.id"
          >
            Use for runs</button
          ><span v-else class="text-xs font-medium text-violet-600 dark:text-violet-400"
            ><CheckIcon class="icon-sm" /> Selected for runs</span
          >
        </div>
      </div>
      <EndpointActivity :profile="p" :now="now" />
      <TabsRoot v-model="section"
        ><TabsList
          class="sticky top-0 z-10 mb-3 mt-3 flex gap-1 border-b bg-white pt-1 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800"
          aria-label="Endpoint settings"
        >
          <TabsTrigger
            v-for="tab in [
              { id: 'connection', label: 'Connection' },
              { id: 'limits', label: 'Requests & chunking' },
              { id: 'pricing', label: 'Token pricing' },
            ]"
            :key="tab.id"
            :value="tab.id"
            class="border-b-2 px-2 pb-2 text-xs sm:px-3 sm:text-sm"
            :class="
              section === tab.id
                ? 'border-violet-500 font-medium text-violet-600 dark:text-violet-400'
                : 'border-transparent text-zinc-500'
            "
          >
            {{ tab.label }}</TabsTrigger
          >
        </TabsList>
        <TabsContent value="connection" class="space-y-3">
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="space-y-1 text-xs font-medium"
              ><span>Endpoint name</span
              ><input v-model="p.name" class="input w-full" placeholder="My DeepSeek" /></label
            ><label class="space-y-1 text-xs font-medium"
              ><span>Model ID</span
              ><input
                v-model="p.model"
                class="input w-full font-mono"
                placeholder="deepseek-chat"
                spellcheck="false"
            /></label>
          </div>
          <label class="block space-y-1 text-xs font-medium"
            ><span>Base URL</span
            ><input
              v-model.trim="p.baseUrl"
              type="url"
              class="input w-full font-mono"
              placeholder="https://your-provider.com/v1"
              spellcheck="false"
            /><span class="block text-[11px] font-normal text-zinc-500"
              >Requests append /chat/completions. Include /v1 only if your provider requires
              it.</span
            ></label
          >
          <div class="space-y-2">
            <UiSwitch v-model="p.needsKey" label="Requires an API key" /><label
              v-if="p.needsKey"
              class="block space-y-1 text-xs font-medium"
              ><span>API key</span
              ><input
                :value="keyring.get('profile:' + p.id)"
                type="password"
                autocomplete="off"
                class="input w-full font-mono"
                placeholder="Paste your API key"
                @input="keyring.set('profile:' + p!.id, ($event.target as HTMLInputElement).value)"
              /><span class="block text-[11px] font-normal text-zinc-500"
                >Kept in memory only. Excluded from settings exports.</span
              ></label
            >
          </div>
        </TabsContent>
        <TabsContent value="limits" class="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div class="space-y-3">
            <div>
              <NumberSlider
                v-model="p.concurrency"
                label="Concurrency"
                :min="1"
                :initial-max="32"
                unit="requests"
              />
              <p class="mt-2 text-[11px] leading-relaxed text-zinc-500">
                Shared across books. Chunks run in parallel; chapters stay ordered.
              </p>
            </div>
            <div>
              <NumberSlider
                v-model="p.maxChars"
                label="Max characters"
                :initial-max="12000"
                unit="/ chunk"
              />
              <p class="mt-2 text-[11px] text-zinc-500">
                0 sends the whole chapter. Prompt and context are additional input tokens.
              </p>
            </div>
            <label class="flex items-center justify-between gap-3 text-sm"
              ><span>Cut at</span><UiSelect v-model="p.splitAt" :options="SPLIT_MODES" class="w-44"
            /></label>
            <p class="text-[11px] text-zinc-500">
              Falls back to finer boundaries when needed. Original text and whitespace are
              preserved.
            </p>
            <NumberSlider
              v-model="p.maxOutputTokens"
              label="Max output tokens"
              :min="1"
              :initial-max="16384"
              unit="/ request"
            />
          </div>
          <div
            class="min-w-0 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-950/50"
          >
            <div class="label">Chunk preview</div>
            <p class="my-2 text-xs text-zinc-500">
              Chapter {{ sampleChapter?.index ?? "—" }} · {{ parts.length }} requests
            </p>
            <div v-if="parts.length" class="mb-3 flex items-center justify-between gap-2">
              <button
                class="btn-ghost btn-xs"
                :disabled="previewPart <= 0"
                aria-label="Previous chunk"
                @click="previewPart = Math.max(0, previewPart - 1)"
              >
                <ChevronLeftIcon class="icon-sm" /></button
              ><span class="text-xs"
                >Chunk {{ Math.min(previewPart + 1, parts.length) }} of {{ parts.length }} ·
                {{ preview.length.toLocaleString() }} chars</span
              ><button
                class="btn-ghost btn-xs"
                :disabled="previewPart >= parts.length - 1"
                aria-label="Next chunk"
                @click="previewPart++"
              >
                <ChevronRightIcon class="icon-sm" />
              </button>
            </div>
            <pre
              class="max-h-48 overflow-auto whitespace-pre-wrap break-words font-serif text-sm leading-relaxed"
              >{{ preview || "Add valid settings to preview the first available chapter." }}</pre>
            <p
              v-if="tokens"
              class="mt-3 border-t border-zinc-200 pt-3 text-[11px] text-zinc-500 dark:border-zinc-700"
            >
              ~{{ tokens.inputTokens.toLocaleString() }} input + ~{{
                tokens.outputTokens.toLocaleString()
              }}
              output tokens · {{ money(tokens.cost) }}
            </p>
          </div>
        </TabsContent>
        <TabsContent value="pricing" class="space-y-3">
          <p class="text-sm text-zinc-500">
            Enter your provider’s rates in USD per 1 million tokens.
          </p>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="space-y-2 text-sm font-medium"
              ><span>Input token price</span>
              <UiNumber
                v-model="p.inPrice"
                class="w-full"
                prefix="$"
                :min="0"
                :step="0.05"
                label="Input token price"
              />
              <span class="block text-xs font-normal text-zinc-500"
                >Source text, prompt, and carried context.</span
              ></label
            ><label class="space-y-2 text-sm font-medium"
              ><span>Output token price</span>
              <UiNumber
                v-model="p.outPrice"
                class="w-full"
                prefix="$"
                :min="0"
                :step="0.05"
                label="Output token price"
              />
              <span class="block text-xs font-normal text-zinc-500"
                >Generated script, speaker labels, and directions.</span
              ></label
            >
          </div>
        </TabsContent></TabsRoot
      >
      <div
        v-if="errors.length"
        class="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
        role="status"
      >
        <p v-for="error in errors" :key="error">{{ error }}</p>
      </div>
      <div
        class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800"
      >
        <span class="text-[11px] text-zinc-500"
          >Changes apply to new jobs. Enable/pause and concurrency apply live.</span
        ><button class="text-xs text-red-600 hover:underline dark:text-red-400" @click="remove">
          Remove endpoint
        </button>
      </div>
    </div>
    <div v-else class="grid place-content-center gap-3 p-8 text-center">
      <p class="text-sm text-zinc-500">Add a scripting endpoint to get started.</p>
      <button class="btn-primary" @click="add"><AddIcon class="icon" /> Add endpoint</button>
    </div>
  </div>
</template>
