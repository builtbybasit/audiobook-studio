<script setup lang="ts">
// The Scripting page's endpoint panel: which endpoint runs go to, how it is doing, and how it would
// cut the chapter you are about to run. Its connection, limits and pricing are edited on the
// Endpoints page, with a draft and Save — the link goes straight to its Connection tab — and so is
// the settings file, which that page exports and imports for the whole library.
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { useScriptingStore } from "@/stores/scripting";

import { computed, ref, watch } from "vue";
import { useNow } from "@vueuse/core";
import { keyInPlace } from "@/services/endpointSettings";
import {
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  ArrowUpRight as ArrowIcon,
} from "@lucide/vue";
import {
  profileErrors,
  reasoningEstimateNote,
  scriptParts,
  tokenEstimate,
  scriptingHealth,
} from "@/lib/scripting";
import { money } from "@/lib/pricing";
import { plural } from "@/lib/contents";
import { resolvePrompt } from "@/lib/prompt";
import { scriptTelemetry } from "@/lib/scriptActivity";
import { isSimulated } from "@/lib/providers";
import { useChapterText } from "@/queries";
import { useScriptActivity } from "@/queries/scriptActivity";
import EndpointActivity from "@/views/scripting/EndpointActivity.vue";
import ScriptProfileSelect from "@/views/scripting/ScriptProfileSelect.vue";

const props = defineProps<{ bookId: string; selected: number[] }>();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
const scriptingStore = useScriptingStore();
const clock = useNow({ interval: 500 });
const now = computed(() => clock.value.getTime());
// what each profile has been through is its rows in the server's ledger, read once for the panel
const activity = useScriptActivity();
const p = computed(() => scriptingStore.runProfile);
const health = computed(() =>
  p.value && activity.data.value === undefined
    ? { label: "Reading its requests…", tone: "muted" }
    : p.value
      ? scriptingHealth(
          p.value,
          scriptTelemetry(activity.rowsOf(p.value.id), p.value),
          keyInPlace(p.value),
          now.value,
        )
      : null,
);
const tone = computed(
  () =>
    ({ good: "bg-emerald-500", warn: "bg-amber-500", muted: "bg-zinc-400" })[
      health.value?.tone ?? "muted"
    ],
);
const errors = computed(() => (p.value ? profileErrors(p.value) : []));

// ---------- the chunk preview: the chapter a run would start on, cut the way the endpoint cuts it
const sampleChapter = computed(
  () =>
    libraryStore
      .chaptersOf(props.bookId)
      .find((c) => props.selected.includes(c.id) && !c.excluded) ??
    libraryStore.chaptersOf(props.bookId).find((c) => !c.excluded),
);
/** a kept chapter, so it always has its reading number */
const sampleNumber = computed(
  () => sampleChapter.value && libraryStore.numberOf(props.bookId, sampleChapter.value.id),
);
const sample = useChapterText(
  () => props.bookId,
  () => sampleChapter.value?.id,
  "plain",
);
/** the sample's text is in: until then there is nothing to cut, which is not the same as no chunks */
const sampleRead = computed(() => sample.data.value !== undefined);
const parts = computed(() => (p.value ? scriptParts(sample.text.value, p.value) : []));
const previewPart = ref(0);
watch([p, sampleChapter], () => (previewPart.value = 0));
const preview = computed(
  () => parts.value[Math.min(previewPart.value, parts.value.length - 1)] ?? "",
);
/** What the endpoint's recent requests at its reasoning level spent thinking, if any said. */
const reasoningSeen = computed(() =>
  p.value && !isSimulated(p.value.baseUrl)
    ? scriptTelemetry(activity.rowsOf(p.value.id), p.value).reasoning
    : undefined,
);
const tokens = computed(() =>
  p.value && preview.value
    ? tokenEstimate(preview.value, p.value, now.value, {
        // with the prompt this book's run would send, as the run's estimate is
        prompt: resolvePrompt({
          library: endpointsStore.prompt,
          profile: p.value.prompt,
          book: libraryStore.bookById(props.bookId)?.prompt,
        }),
        reasoningPerInputToken: reasoningSeen.value?.perInputToken,
      })
    : null,
);
const thinkingNote = computed(() =>
  p.value && tokens.value && !isSimulated(p.value.baseUrl)
    ? reasoningEstimateNote(p.value.reasoning, reasoningSeen.value, tokens.value.reasoningTokens)
    : null,
);
</script>
<template>
  <div class="min-w-0 space-y-3 p-3 sm:p-4">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span class="label">Runs go to</span>
      <ScriptProfileSelect class="w-72 max-w-full" :block="false" size="sm" />
      <span
        v-if="health"
        class="flex items-center gap-1.5 text-[11px]"
        :class="
          health.tone === 'good'
            ? 'text-emerald-600 dark:text-emerald-400'
            : health.tone === 'warn'
              ? 'text-amber-700 dark:text-amber-400'
              : 'text-zinc-500'
        "
        ><span class="h-1.5 w-1.5 rounded-full" :class="tone"></span>{{ health.label }}</span
      >
      <RouterLink
        :to="
          p
            ? { path: '/endpoints', query: { endpoint: `scripting:${p.id}`, tab: 'connection' } }
            : '/endpoints'
        "
        class="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-xs text-violet-600 hover:underline dark:text-violet-400"
        :title="
          p
            ? `${p.name}'s connection, limits and pricing, with its request history`
            : 'Add a scripting endpoint'
        "
        >{{ p ? "Edit on the Endpoints page" : "Add one on the Endpoints page" }}
        <ArrowIcon class="icon-sm"
      /></RouterLink>
    </div>
    <p v-if="!p" class="text-sm text-zinc-500">
      {{ scriptingStore.runBlockers[0] }}
    </p>
    <template v-else>
      <p class="font-mono text-[11px] text-zinc-500">
        {{ p.model || "Model required" }} · {{ money(p.inPrice) }} in / {{ money(p.outPrice) }} out
        per 1M tokens ·
        {{ p.maxChars ? `${p.maxChars.toLocaleString("en")} chars / chunk` : "whole chapters" }}
      </p>
      <EndpointActivity
        :profile="p"
        :rows="activity.rowsOf(p.id)"
        :loaded="activity.data.value !== undefined"
        :now="now"
      />
      <div
        v-if="errors.length"
        class="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
        role="status"
      >
        <p v-for="error in errors" :key="error">{{ error }}</p>
      </div>
      <div
        class="min-w-0 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-950/50"
      >
        <div class="label">Chunk preview</div>
        <p class="my-2 text-xs text-zinc-500">
          <template v-if="!sampleChapter">No chapter to preview.</template>
          <template v-else-if="!sampleRead">Reading chapter {{ sampleNumber }}’s text…</template>
          <template v-else-if="errors.length"
            >Chapter {{ sampleNumber }} · fix the settings above to see how it is cut</template
          >
          <template v-else
            >Chapter {{ sampleNumber }} · {{ plural(parts.length, "request") }}</template
          >
        </p>
        <template v-if="parts.length">
          <div class="mb-3 flex items-center justify-between gap-2">
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
            >{{ preview }}</pre>
          <p
            v-if="tokens"
            class="mt-3 border-t border-zinc-200 pt-3 text-[11px] text-zinc-500 dark:border-zinc-700"
          >
            ~{{ tokens.inputTokens.toLocaleString() }} input + ~{{
              tokens.outputTokens.toLocaleString()
            }}
            output tokens · {{ money(tokens.cost) }}
            <span v-if="thinkingNote" class="block text-zinc-400">{{ thinkingNote }}</span>
          </p>
        </template>
      </div>
    </template>
  </div>
</template>
