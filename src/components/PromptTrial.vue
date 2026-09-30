<script setup lang="ts">
// Try a scripting prompt on one chunk of a real chapter before it is saved or run: the drafts the
// page is editing, sent to one endpoint, and what came back — the lines, the word-for-word check a
// run would hold them to, what it took and cost, and the two messages exactly as sent.
//
// Mounted beside every place a prompt is edited: an endpoint's Prompt tab (a book and a chapter
// picked here) and a book's scripting settings (the book and the chapter given). The request is
// real and billed to the book like any other; nothing is written to its script. See
// `@/lib/promptTrial` for which layers are sent and `POST /api/books/:id/script-trial` for the rest.
//
// The last answer stays until the next one. When anything it was made from changes — a draft, the
// part, the endpoint — it is marked as made from an earlier prompt rather than cleared, so an
// edit can be read against what the previous wording did.
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { LoaderCircle as BusyIcon, Check as OkIcon, X as BadIcon } from "@lucide/vue";
import { useChapterText } from "@/queries";
import { useScriptActivity } from "@/queries/scriptActivity";
import { keyInPlace } from "@/services/endpointSettings";
import { ApiError } from "@/services/http";
import { isSimulated } from "@/lib/providers/simulated";
import { resolvePrompt } from "@/lib/prompt";
import {
  fidelitySummary,
  trialLayers,
  trialRequest,
  trialTime,
  trialTokens,
  type TrialDrafts,
} from "@/lib/promptTrial";
import { scriptTelemetry } from "@/lib/scriptActivity";
import { profileErrors, scriptParts, tokenEstimate } from "@/lib/scripting";
import { NARRATOR } from "@/lib/cast";
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useLibraryStore } from "@/stores/library";
import { UiSelect } from "@/ui";
import { money } from "@/lib/pricing";
import type { PromptTrialResult } from "@/types";

const props = withDefaults(
  defineProps<{
    /** the book to try it on; null lets the person pick one */
    bookId: string | null;
    /** the chapter; null lets the person pick one (the book's first until they do) */
    chapterId: number | null;
    /** the scripting endpoint to send it to */
    profileId: string;
    /** drafts in place of what is saved, layer by layer; a layer left out is sent as saved */
    drafts: TrialDrafts;
    disabled?: boolean;
    /** why it is disabled, e.g. the draft has problems */
    disabledReason?: string;
  }>(),
  { disabled: false, disabledReason: "" },
);

const id = useId();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const libraryStore = useLibraryStore();
// the endpoint's recent requests, for how much it thinks per input token
const activity = useScriptActivity();

// ---- which chunk ----

const pickedBook = ref<string | null>(null);
const pickedChapter = ref<number | null>(null);
const bookId = computed(() => props.bookId ?? pickedBook.value);
const book = computed(() => (bookId.value ? libraryStore.bookById(bookId.value) : undefined));
const chapters = computed(() => (bookId.value ? libraryStore.chaptersOf(bookId.value) : []));
const chapterId = computed<number | null>(
  () =>
    props.chapterId ??
    (chapters.value.some((c) => c.id === pickedChapter.value) ? pickedChapter.value : null) ??
    chapters.value.find((c) => !c.excluded)?.id ??
    chapters.value[0]?.id ??
    null,
);
const chapter = computed(() =>
  bookId.value && chapterId.value != null
    ? libraryStore.chapter(bookId.value, chapterId.value)
    : undefined,
);

const bookOptions = computed(() =>
  libraryStore.shelved.map((b) => ({ value: b.id, label: b.title, hint: b.author })),
);
const chapterOptions = computed(() =>
  chapters.value.map((c) => ({
    value: c.id,
    label: `${c.id}. ${c.title}`,
    hint: c.excluded ? "skipped" : undefined,
  })),
);

onMounted(() => {
  if (props.bookId !== null) return;
  void libraryStore.load();
});
// the page's own book until somebody picks another, else the first on the shelf
watch(
  () => [props.bookId, libraryStore.book?.id, libraryStore.shelved[0]?.id] as const,
  ([given, current, first]) => {
    if (given === null && !pickedBook.value) pickedBook.value = current ?? first ?? null;
  },
  { immediate: true },
);
// the shelf lists books; only opening one brings its chapters
watch(
  bookId,
  (id) => {
    if (id && !libraryStore.chapters[id]) void libraryStore.loadBook(id);
  },
  { immediate: true },
);

const profile = computed(() => endpointsStore.profiles.find((p) => p.id === props.profileId));
const { text, isLoading: textLoading } = useChapterText(
  () => bookId.value ?? "",
  () => (bookId.value ? chapterId.value : null),
  "plain",
);
/** The chapter as the endpoint cuts it; a chapter it does not cut is one request, as the server has it. */
const parts = computed(() => {
  const p = profile.value;
  if (!p || profileErrors(p).length || !text.value.trim()) return [];
  const cut = scriptParts(text.value, p);
  return cut.length ? cut : [text.value];
});
const part = ref(1);
watch([bookId, chapterId], () => (part.value = 1));
watch(
  () => parts.value.length,
  (n) => {
    if (n && part.value > n) part.value = n;
  },
);
const partOptions = computed(() =>
  parts.value.map((t, i) => ({
    value: i + 1,
    label: `Part ${i + 1} of ${parts.value.length}`,
    hint: `${t.length.toLocaleString("en")} chars`,
  })),
);

// ---- what it would send, and cost ----

const layers = computed(() =>
  trialLayers(props.drafts, {
    library: endpointsStore.prompt,
    profilePrompt: profile.value?.prompt,
    book: book.value?.prompt,
  }),
);
const resolved = computed(() => resolvePrompt(layers.value));
const simulated = computed(() => !!profile.value && isSimulated(String(profile.value.baseUrl)));
const reasoning = computed(() => {
  const p = profile.value;
  return p ? scriptTelemetry(activity.rowsOf(p.id), p).reasoning : undefined;
});
const estimate = computed(() => {
  const p = profile.value;
  const chunk = parts.value[part.value - 1];
  if (!p || !chunk) return null;
  return tokenEstimate(chunk, p, Date.now(), {
    prompt: resolved.value,
    reasoningPerInputToken: reasoning.value?.perInputToken,
  });
});

/** Why Try cannot be pressed; empty when it can. */
const blocked = computed(() => {
  const p = profile.value;
  if (props.disabled) return props.disabledReason || "Fix the prompt's problems first.";
  if (!p) return "Choose a scripting endpoint.";
  if (profileErrors(p).length) return `${p.name}'s settings need fixing first.`;
  if (p.needsKey && !keyInPlace(p)) return `Add an API key to ${p.name} first.`;
  if (!bookId.value)
    return libraryStore.shelved.length ? "Choose a book." : "No books to try it on.";
  if (chapterId.value == null) return "Choose a chapter.";
  if (!parts.value.length)
    return textLoading.value ? "Reading the chapter…" : "This chapter has no text.";
  return "";
});

// ---- the trial ----

/** Everything an answer depends on; an answer made from other inputs is stale. */
const inputs = computed(() =>
  JSON.stringify([
    bookId.value,
    chapterId.value,
    part.value,
    props.profileId,
    profile.value?.model,
    profile.value?.reasoning ?? null,
    resolved.value.system,
    resolved.value.user,
    layers.value.book?.notes ?? "",
    layers.value.profile?.notes ?? "",
  ]),
);

const running = ref(false);
let controller: AbortController | null = null;
const result = ref<{ of: string; bookId: string; answer: PromptTrialResult } | null>(null);
/** what stopped the last trial short of an answer: a refusal, a failure, or Cancel */
const failure = ref<{ text: string; cancelled: boolean } | null>(null);
const status = ref("");
const stale = computed(() => !!result.value && result.value.of !== inputs.value);

async function run() {
  const p = profile.value;
  if (blocked.value || running.value || !p || !bookId.value || chapterId.value == null) return;
  const forBook = bookId.value;
  const of = inputs.value;
  const request = trialRequest(p.id, chapterId.value, part.value, props.drafts);
  controller = new AbortController();
  running.value = true;
  failure.value = null;
  status.value = `Sending part ${part.value} of ${parts.value.length} to ${p.name}…`;
  try {
    const answer = await libraryStore.tryPrompt(forBook, request, controller.signal);
    result.value = { of, bookId: forBook, answer };
    status.value = answer.error
      ? `${p.name} answered, but not with a script.`
      : `${p.name} answered in ${trialTime(answer.ms)}. ${fidelitySummary(answer.fidelity).text}.`;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      failure.value = {
        text: "Cancelled. If the request had already reached the model it may still be billed; its answer is not shown.",
        cancelled: true,
      };
      status.value = failure.value.text;
      return;
    }
    const api = cause instanceof ApiError ? cause : null;
    const text = api
      ? [api.message, api.detail].filter(Boolean).join(" — ")
      : cause instanceof Error
        ? cause.message
        : "The trial could not be sent.";
    failure.value = { text, cancelled: false };
    status.value = `The trial failed: ${text}`;
  } finally {
    running.value = false;
    controller = null;
  }
}

function cancel() {
  controller?.abort();
}
onBeforeUnmount(cancel);

// ---- showing it ----

const n = (v: number) => v.toLocaleString("en");

const fidelity = computed(() =>
  result.value ? fidelitySummary(result.value.answer.fidelity) : null,
);
const colorOf = (name: string): string =>
  name === NARRATOR
    ? "#71717a"
    : (castStore.charactersOf(result.value?.bookId ?? "").find((c) => c.name === name)?.color ??
      "#71717a");
</script>
<template>
  <section class="space-y-2 text-xs" aria-label="Try the prompt on one chunk">
    <div>
      <span class="font-medium">Try it on one chunk</span>
      <p class="text-[11px] leading-snug text-zinc-500">
        Sends one part of a chapter with the prompt as it stands here, saved or not, and shows what
        comes back. Nothing is written to the script.
      </p>
    </div>

    <div class="flex flex-wrap gap-1.5">
      <UiSelect
        v-if="props.bookId === null"
        :model-value="bookId"
        :options="bookOptions"
        size="xs"
        placeholder="Choose a book…"
        aria-label="Book to try it on"
        class="min-w-0 flex-1"
        @update:model-value="
          (v) => ((pickedBook = v == null ? null : String(v)), (pickedChapter = null))
        "
      />
      <UiSelect
        v-if="props.chapterId === null && bookId"
        :model-value="chapterId"
        :options="chapterOptions"
        size="xs"
        placeholder="Choose a chapter…"
        aria-label="Chapter to try it on"
        class="min-w-0 flex-1"
        @update:model-value="(v) => (pickedChapter = v == null ? null : Number(v))"
      />
      <UiSelect
        v-if="parts.length > 1"
        :model-value="part"
        :options="partOptions"
        size="xs"
        aria-label="Which part of the chapter"
        @update:model-value="(v) => (part = Number(v) || 1)"
      />
    </div>
    <p v-if="parts.length === 1 && chapter" class="text-[11px] leading-snug text-zinc-500">
      {{ profile?.name }} sends {{ chapter.title }} as one request.
    </p>

    <p v-if="estimate" class="text-[11px] leading-snug text-zinc-500">
      About {{ n(estimate.inputTokens) }} tokens in and {{ n(estimate.outputTokens) }} out<span
        v-if="estimate.reasoningTokens"
      >
        (~{{ n(estimate.reasoningTokens) }} of them thinking)</span
      >
      · ~{{ money(estimate.cost) }}
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <button
        v-if="!running"
        type="button"
        class="btn-primary btn-xs"
        :disabled="!!blocked"
        :aria-describedby="`${id}-note`"
        @click="run"
      >
        Try
      </button>
      <template v-else>
        <span class="flex items-center gap-1 text-zinc-500"
          ><BusyIcon class="icon-sm animate-spin" aria-hidden="true" /> Waiting for
          {{ profile?.name }}…</span
        >
        <button type="button" class="btn-ghost btn-xs" @click="cancel">Cancel</button>
      </template>
      <span :id="`${id}-note`" class="text-[11px] leading-snug text-zinc-500">
        <template v-if="blocked && !running">{{ blocked }}</template>
        <template v-else-if="simulated"
          >A simulated endpoint: nothing is sent or billed; the cost shown is what a real request
          would come to.</template
        >
        <template v-else
          >A real request, billed to {{ book?.title ?? "the book" }} and held to its
          budget.</template
        >
      </span>
    </div>

    <p class="sr-only" role="status" aria-live="polite">{{ status }}</p>
    <p
      v-if="failure && !running"
      class="text-[11px] leading-snug"
      :class="failure.cancelled ? 'text-zinc-500' : 'text-red-700 dark:text-red-300'"
    >
      {{ failure.text }}
    </p>

    <div
      v-if="result"
      class="space-y-2 rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/60"
      :class="stale && 'opacity-70'"
    >
      <p v-if="stale" class="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
        Made with an earlier prompt, part or endpoint. Try again to see what this one does.
      </p>
      <p v-if="result.answer.error" class="text-[11px] leading-snug text-red-700 dark:text-red-300">
        {{ result.answer.error }}
      </p>
      <p
        v-if="fidelity && result.answer.lines.length"
        class="flex gap-1.5 text-[11px] leading-snug"
        :class="
          fidelity.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-300'
        "
      >
        <OkIcon v-if="fidelity.ok" class="icon-sm mt-px shrink-0" aria-hidden="true" />
        <BadIcon v-else class="icon-sm mt-px shrink-0" aria-hidden="true" />
        <span>{{ fidelity.text }}.</span>
      </p>
      <p class="text-[11px] leading-snug text-zinc-500">
        Part {{ result.answer.part }} of {{ result.answer.parts }} ·
        {{ trialTime(result.answer.ms) }}
        <template v-if="result.answer.usage"> · {{ trialTokens(result.answer.usage) }}</template>
        ·
        {{ result.answer.cost == null ? "not priced" : money(result.answer.cost) }}
      </p>

      <ol v-if="result.answer.lines.length" class="max-h-72 space-y-1 overflow-auto">
        <li
          v-for="(line, i) in result.answer.lines"
          :key="i"
          class="flex items-baseline gap-2 text-[11px] leading-snug"
        >
          <span
            class="max-w-[9rem] shrink-0 truncate rounded-full px-1.5 py-px font-medium"
            :style="{ background: colorOf(line.speaker) + '26', color: colorOf(line.speaker) }"
            :title="`${line.speaker} · ${line.type}`"
            ><span v-if="line.type !== 'narration'" class="opacity-70" aria-hidden="true">{{
              line.type === "thought" ? "…" : "“"
            }}</span>
            {{ line.speaker }}</span
          >
          <span
            class="min-w-0"
            :class="line.type === 'thought' && 'text-zinc-600 dark:text-zinc-300'"
            >{{ line.text
            }}<span v-if="line.direction" class="ml-1 italic text-zinc-500"
              >— {{ line.direction }}</span
            ></span
          >
        </li>
      </ol>

      <details>
        <summary class="cursor-pointer select-none text-[11px] text-zinc-600 dark:text-zinc-300">
          The two messages as sent
        </summary>
        <div v-for="m in ['system', 'user'] as const" :key="m" class="mt-2">
          <span class="label">{{ m === "system" ? "System" : "User" }}</span>
          <pre
            class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] leading-relaxed dark:bg-zinc-950/50"
            >{{ result.answer.prompt[m] }}</pre>
        </div>
      </details>
    </div>
  </section>
</template>
