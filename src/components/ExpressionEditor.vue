<script setup lang="ts">
// Expressions on one line, placed by clicking a gap in the line's word strip; the chips in the line
// edit what is placed. The source text is never rewritten to hold a tag. A pause needs no tags: a
// voice without a pause tag hears it as silence.
import { useCastStore } from "@/stores/cast";
import { useNarrationStore } from "@/stores/narration";

import { computed, nextTick, ref, watch } from "vue";
import { DialogClose, DialogDescription, DialogTitle } from "reka-ui";
import {
  Plus as AddIcon,
  X as CloseIcon,
  Settings2 as SettingsIcon,
  Trash2 as RemoveIcon,
  ChevronDown as ExpandIcon,
  MoveHorizontal as MoveIcon,
  Pause as PauseIcon,
} from "@lucide/vue";
import { UiCombobox, UiDialog, UiHint } from "@/ui";

import { chipText, expressionSupport, tokenFor, typedTag, validToken } from "@/lib/expressions";
import { gapLabel } from "@/lib/gaps";
import { PAUSE_STEPS, secs } from "@/lib/speech";
import ExpressionsTab from "@/views/endpoints/ExpressionsTab.vue";
import WordStrip from "@/components/WordStrip.vue";
import type { Segment, ExpressionAnnotation, PauseWord } from "@/types";

const props = defineProps<{
  bookId: string;
  chapterId: number;
  segment: Segment;
}>();
const castStore = useCastStore();
const narrationStore = useNarrationStore();

const root = ref<HTMLElement | null>(null);
const strip = ref<HTMLElement | null>(null);
const expanded = ref(false);
const settings = ref(false);

const route = computed(() => castStore.effectiveVoice(props.bookId, props.segment.speaker));
const endpoint = computed(() => route.value.endpoint);
const support = computed(() => expressionSupport(endpoint.value));
const tags = computed(() =>
  support.value === "supported" ? (endpoint.value?.expressions?.tags ?? []) : [],
);
// an open model takes any words in its brackets, not only a listed tag
const open = computed(() => support.value === "supported" && !!endpoint.value?.expressions?.open);
/** A listed tag by id, or on an open model the words typed. */
function tagFor(value: string) {
  const listed = tags.value.find((t) => t.id === value);
  if (listed || !open.value || !value.trim()) return listed;
  const tag = typedTag(value, endpoint.value!.expressions!.brackets);
  return validToken(tag.token, endpoint.value!.expressions!.brackets) ? tag : undefined;
}
const options = computed(() =>
  tags.value.map((t) => ({
    value: t.id,
    label: t.label,
    hint: t.token,
    group: t.kind === "sound" ? "Vocal sounds" : "Delivery",
  })),
);
const plan = computed(() => narrationStore.expressionRender(props.bookId, props.segment));
const issue = (id: number) => plan.value.issues.find((i) => i.annotationId === id);
const issueReason = (id: number) => issue(id)?.reason;
const skippedReason = (id: number) => plan.value.skipped.find((i) => i.annotationId === id)?.reason;
const count = computed(() => props.segment.expressions?.length ?? 0);
const pacing = computed(() => castStore.pacingOf(props.bookId));
/** its model takes tags, or it holds or is getting a pause */
const editable = computed(
  () =>
    support.value === "supported" ||
    pausing.value ||
    !!props.segment.expressions?.some((a) => a.kind === "pause"),
);
const change = (id: number, patch: Partial<ExpressionAnnotation> | null) =>
  narrationStore.updateExpression(props.bookId, props.chapterId, props.segment.id, id, patch);

const placing = ref(false);
const pausing = ref(false);
const pickAt = ref<number | null>(null);
const moving = ref<number | null>(null);
const selected = ref("");
/** the chosen gap's x within the strip */
const caretX = ref(0);
const caretAt = (el: HTMLElement) => {
  const box = strip.value?.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  caretX.value = box ? Math.max(8, r.left - box.left + r.width / 2) : 8;
};

function startPlacing(pause = false) {
  if (!pause && support.value !== "supported") {
    if (endpoint.value) settings.value = true;
    return;
  }
  pausing.value = pause;
  expanded.value = true;
  editing.value = null;
  moving.value = null;
  pickAt.value = null;
  placing.value = true;
  nextTick(() => strip.value?.querySelector<HTMLElement>(".word-strip")?.focus());
}
function onPick(at: number, el: HTMLElement) {
  caretAt(el);
  if (moving.value != null) {
    change(moving.value, { at, needsReview: false });
    moving.value = null;
    placing.value = false;
    return;
  }
  if (pausing.value) {
    const id = narrationStore.addPause(props.bookId, props.chapterId, props.segment.id, at);
    cancel();
    editing.value = id;
    return;
  }
  pickAt.value = at;
  selected.value = "";
  nextTick(() =>
    root.value
      ?.querySelector<HTMLInputElement>('.expression-picker input[role="combobox"]')
      ?.focus(),
  );
}
function insert() {
  const tag = tagFor(selected.value);
  if (!tag || pickAt.value == null) return;
  narrationStore.addExpression(props.bookId, props.chapterId, props.segment.id, tag, pickAt.value);
  cancel();
}
function cancel() {
  placing.value = false;
  pausing.value = false;
  pickAt.value = null;
  moving.value = null;
  selected.value = "";
}

const editing = ref<number | null>(null);
const current = computed(() =>
  props.segment.expressions?.find((a) => a.annotationId === editing.value),
);
function openChip(id: number, el: HTMLElement) {
  if (placing.value) return;
  caretAt(el);
  editing.value = editing.value === id ? null : id;
}
function startMove() {
  if (editing.value == null) return;
  moving.value = editing.value;
  editing.value = null;
  placing.value = true;
  nextTick(() => strip.value?.querySelector<HTMLElement>(".word-strip")?.focus());
}
function replace(value: string) {
  const tag = tagFor(value);
  if (tag && editing.value != null) change(editing.value, tag);
}
function remove() {
  if (editing.value != null) change(editing.value, null);
  editing.value = null;
}
watch(count, (n) => {
  if (!n) editing.value = null;
});
watch(expanded, (v) => {
  if (!v) {
    cancel();
    editing.value = null;
  }
});
const tokenOf = (a: ExpressionAnnotation) => tokenFor(a, endpoint.value?.expressions).token;

/** the book's short and long pauses, or one of its own */
const lengths = computed(() => [
  { word: "pause" as PauseWord, label: `short · ${secs(pacing.value.inlineShort)}` },
  { word: "long pause" as PauseWord, label: `long · ${secs(pacing.value.inlineLong)}` },
  ...PAUSE_STEPS.filter((v): v is number => !!v).map((seconds) => ({
    word: "pause" as PauseWord,
    seconds,
    label: secs(seconds),
  })),
]);
const isLength = (a: ExpressionAnnotation, l: { word: PauseWord; seconds?: number }) =>
  l.seconds != null ? a.seconds === l.seconds : a.seconds == null && a.id === l.word;
function setLength(l: { word: PauseWord; seconds?: number }) {
  if (editing.value != null)
    change(editing.value, { id: l.word, label: l.word, seconds: l.seconds });
}
</script>

<template>
  <section ref="root" class="min-w-0 text-xs" data-expression-editor>
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="flex items-center gap-1 font-medium"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <ExpandIcon class="icon-sm transition-transform" :class="!expanded && '-rotate-90'" />
        Expressions
        <span
          v-if="count"
          class="rounded bg-zinc-100 px-1 font-mono text-[10px] dark:bg-zinc-800"
          >{{ count }}</span
        >
      </button>
      <span v-if="plan.issues.length" class="text-amber-600 dark:text-amber-400"
        >{{ plan.issues.length }} need review</span
      >
      <button
        v-if="endpoint"
        class="btn-ghost btn-xs ml-auto"
        :disabled="placing"
        @click="startPlacing(true)"
      >
        <PauseIcon class="icon-sm" /> Add pause
      </button>
      <button
        v-if="support === 'supported'"
        class="btn-ghost btn-xs"
        :disabled="placing"
        @click="startPlacing()"
      >
        <AddIcon class="icon-sm" /> Add expression
      </button>
      <button v-else-if="endpoint" class="btn-ghost btn-xs" @click="settings = true">
        <SettingsIcon class="icon-sm" /> Set up expressions for {{ endpoint.model }}
      </button>
      <span v-else class="ml-auto text-zinc-400">Assign a voice to use expressions</span>
    </div>

    <div v-if="expanded" class="mt-2 space-y-2">
      <div class="flex flex-wrap items-center gap-x-2 text-zinc-500">
        <span class="min-w-0 break-words"
          >{{ segment.speaker }} → {{ endpoint?.name ?? "no voice assigned"
          }}<span v-if="endpoint"> · {{ endpoint.model }}</span
          ><span v-if="support === 'supported'"> · {{ tags.length }} tags</span></span
        ><button v-if="endpoint" class="underline hover:text-violet-600" @click="settings = true">
          configure
        </button>
      </div>

      <p
        v-if="support !== 'supported' && !editable"
        class="rounded-md bg-zinc-50 p-3 leading-relaxed text-zinc-500 dark:bg-zinc-800/50"
      >
        {{
          !endpoint
            ? "This speaker has no voice yet, so there is no model to place expressions for. Assign one in Cast."
            : support === "unsupported"
              ? `${endpoint.model} is configured without expression tags. Assign another voice in Cast, or configure this model.`
              : `${endpoint.model} has no expression tags set up yet. Models differ in syntax, so the tags are configured per model — once.`
        }}
      </p>

      <template v-if="editable">
        <div
          ref="strip"
          class="rounded-md bg-zinc-50 p-3 leading-loose transition-shadow dark:bg-zinc-800/50"
          :class="placing && 'ring-1 ring-violet-300 dark:ring-violet-500/40'"
        >
          <WordStrip
            :text="segment.text"
            mode="place"
            :gaps="placing"
            :expressions="segment.expressions"
            :issue-of="issueReason"
            :skipped-of="skippedReason"
            :moving-id="moving"
            :pacing="pacing"
            :quote="segment.type === 'dialogue' ? 'dialogue' : ''"
            verb="place"
            @pick="onPick"
            @chip="openChip"
            @cancel="cancel"
          />
        </div>
        <p v-if="placing && pickAt == null" class="text-violet-600 dark:text-violet-300">
          {{
            moving != null
              ? "Click the gap the expression should move to."
              : pausing
                ? "Click the gap where the pause goes."
                : "Click the gap where the expression goes."
          }}
          <span class="text-violet-500/70">← → walk the gaps, Enter picks.</span>
          <button class="ml-2 underline" @click="cancel">Cancel</button>
        </p>
        <p v-else-if="!placing && count" class="text-zinc-400">
          Click a chip to change, move, omit or remove it.
        </p>
        <p v-else-if="!placing" class="text-zinc-400">Nothing placed on this line yet.</p>

        <div v-if="pickAt != null" class="expression-picker relative">
          <span
            class="absolute -top-2 h-3 w-3 rotate-45 border-l border-t border-violet-300 bg-white dark:border-violet-500/40 dark:bg-zinc-900"
            :style="{ left: `${caretX - 6}px` }"
          ></span>
          <div
            class="rounded-lg border border-violet-300 bg-white p-2 shadow-lg dark:border-violet-500/40 dark:bg-zinc-900"
          >
            <div class="mb-1 text-zinc-500">Insert {{ gapLabel(segment.text, pickAt) }}</div>
            <UiCombobox
              v-model="selected"
              :options="options"
              :custom="open"
              :placeholder="open ? 'Search, or type any tag…' : 'Search this model’s expressions…'"
              block
              size="xs"
              @keydown.enter="insert"
            />
            <div class="mt-2 flex items-center justify-end gap-1">
              <button class="btn-ghost btn-xs" @click="cancel">Cancel</button>
              <button class="btn-primary btn-xs" :disabled="!tagFor(selected)" @click="insert">
                <AddIcon class="icon-sm" /> Insert
              </button>
            </div>
          </div>
        </div>

        <div v-else-if="current" class="relative">
          <span
            class="absolute -top-2 h-3 w-3 rotate-45 border-l border-t border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900"
            :style="{ left: `${caretX - 6}px` }"
          ></span>
          <div
            class="space-y-2 rounded-lg border p-2 shadow-lg dark:bg-zinc-900"
            :class="
              issue(current.annotationId)
                ? 'border-amber-300 bg-white dark:border-amber-600/50'
                : 'border-zinc-300 bg-white dark:border-zinc-700'
            "
          >
            <div v-if="current.kind === 'pause'" class="flex flex-wrap items-center gap-2">
              <b
                ><PauseIcon class="-mt-px inline size-3" aria-hidden="true" /> Pause ·
                {{ chipText(current, pacing) }}</b
              ><span class="text-zinc-400">· {{ gapLabel(segment.text, current.at) }}</span
              ><UiHint
                label="pauses"
                text="A short or long pause is as long as the book’s pacing says, and follows it when that changes. The voice is sent its own pause tag where it has one; otherwise the line is spoken in parts with this much silence between them, one more request each."
              /><button class="btn-ghost btn-xs ml-auto" @click="editing = null">Done</button>
            </div>
            <div v-else class="flex flex-wrap items-center gap-2">
              <b>{{ current.label }}</b
              ><code class="text-violet-500">{{ tokenOf(current) }}</code
              ><span class="text-zinc-400">{{
                current.kind === "sound" ? "vocal sound" : "delivery"
              }}</span
              ><span class="text-zinc-400">· {{ gapLabel(segment.text, current.at) }}</span
              ><button class="btn-ghost btn-xs ml-auto" @click="editing = null">Done</button>
            </div>
            <p v-if="skippedReason(current.annotationId)" class="text-zinc-500">
              Written by the scripting model; left out for this voice:
              {{ skippedReason(current.annotationId) }}
            </p>
            <p v-if="issue(current.annotationId)" class="text-amber-700 dark:text-amber-300">
              {{ issue(current.annotationId)!.reason }}
              <button
                v-if="current.needsReview"
                class="ml-1 underline"
                @click="change(current.annotationId, { needsReview: false })"
              >
                Keep this position
              </button>
            </p>
            <div v-if="current.kind === 'pause'" class="flex flex-wrap items-center gap-1.5">
              <span class="text-zinc-400">Length</span>
              <button
                v-for="l in lengths"
                :key="l.label"
                class="chip"
                :class="isLength(current, l) && 'chip-on'"
                @click="setLength(l)"
              >
                {{ l.label }}
              </button>
            </div>
            <div class="flex flex-wrap items-end gap-2">
              <label v-if="current.kind !== 'pause'" class="min-w-[12rem] flex-1"
                >Replace with<UiCombobox
                  :model-value="current.id"
                  :options="options"
                  :custom="open"
                  block
                  size="xs"
                  class="mt-1"
                  @update:model-value="(v) => replace(String(v))"
              /></label>
              <button
                class="btn-ghost btn-xs"
                :class="current.kind === 'pause' && 'ml-auto'"
                @click="startMove"
              >
                <MoveIcon class="icon-sm" /> Move…
              </button>
              <button
                class="btn-ghost btn-xs"
                @click="change(current.annotationId, { omitted: !current.omitted })"
              >
                {{ current.omitted ? "Include again" : "Omit from narration" }}
              </button>
              <button class="btn-ghost btn-xs text-red-600 dark:text-red-400" @click="remove">
                <RemoveIcon class="icon-sm" /> Remove
              </button>
            </div>
            <p v-if="current.omitted" class="text-zinc-500">
              Kept on the line; not sent to the model.
            </p>
          </div>
        </div>

        <details v-if="count">
          <summary class="w-fit cursor-pointer py-1 text-violet-500">
            {{
              plan.issues.length
                ? "Outgoing preview unavailable until issues are resolved"
                : "Preview the exact text sent to the model"
            }}
          </summary>
          <template v-if="!plan.issues.length"
            ><p class="mb-2 text-zinc-500">
              Includes pronunciation replacements and the placed expressions. The book text stays
              unchanged.
            </p>
            <pre
              class="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-3 font-mono dark:bg-zinc-800/50"
              >{{ plan.text }}</pre>
          </template>
        </details>
      </template>
    </div>

    <UiDialog
      v-model:open="settings"
      class="max-h-[90dvh] w-[min(680px,96vw)] overflow-y-auto rounded-xl bg-white p-4 dark:bg-zinc-950"
      data-expression-editor
      ><div class="mb-2 flex items-center gap-2">
        <DialogTitle class="font-semibold">Expressions for {{ endpoint?.model }}</DialogTitle
        ><DialogClose class="btn-ghost btn-xs ml-auto" aria-label="Close model expressions"
          ><CloseIcon class="icon"
        /></DialogClose>
      </div>
      <DialogDescription class="mb-3 text-xs text-zinc-500"
        >Tags are configured once per model — {{ endpoint?.name }} · {{ endpoint?.model }} — and
        every line read by it can then use them. Nothing here changes the book.</DialogDescription
      ><ExpressionsTab v-if="endpoint" :key="endpoint.id" :endpoint="endpoint"
    /></UiDialog>
  </section>
</template>
