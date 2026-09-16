<script setup lang="ts">
// Expressions on one line, edited on the line itself. "Add expression" turns the line into a
// strip of words with its gaps showing; click the gap where the expression goes and a picker
// opens there with this model's tags. The chips in the line are the controls for what is already
// placed: click one to replace, move, omit or remove it. There is no position dropdown, and the
// source text is never rewritten to hold a tag.
//
// When the speaker's model has no tags configured, the button says so and opens the configuration
// in place, since that is the only thing that can happen next.
import { useCastStore } from "@/stores/cast";
import { useNarrationStore } from "@/stores/narration";

import { computed, nextTick, ref, watch } from "vue";
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "reka-ui";
import {
  Plus as AddIcon,
  X as CloseIcon,
  Settings2 as SettingsIcon,
  Trash2 as RemoveIcon,
  ChevronDown as ExpandIcon,
  MoveHorizontal as MoveIcon,
} from "@lucide/vue";
import { UiCombobox } from "@/ui";

import { expressionSupport } from "@/lib/expressions";
import { gapLabel } from "@/lib/gaps";
import ExpressionsTab from "@/views/endpoints/ExpressionsTab.vue";
import WordStrip from "@/components/WordStrip.vue";
import type { Segment, ExpressionAnnotation } from "@/types";

const props = defineProps<{
  bookId: string;
  chapterId: number;
  segment: Segment;
  startOpen?: boolean;
}>();
const castStore = useCastStore();
const narrationStore = useNarrationStore();

const root = ref<HTMLElement | null>(null);
const strip = ref<HTMLElement | null>(null);
const expanded = ref(!!props.startOpen);
const settings = ref(false);

const route = computed(() => castStore.effectiveVoice(props.bookId, props.segment.speaker));
const endpoint = computed(() => route.value.endpoint);
const support = computed(() => expressionSupport(endpoint.value));
const tags = computed(() =>
  support.value === "supported" ? (endpoint.value?.expressions?.tags ?? []) : [],
);
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
const count = computed(() => props.segment.expressions?.length ?? 0);
const change = (id: number, patch: Partial<ExpressionAnnotation> | null) =>
  narrationStore.updateExpression(props.bookId, props.chapterId, props.segment.id, id, patch);

// ---- placing: a gap is chosen on the strip, then a tag in the picker that opens under it
const placing = ref(false);
const pickAt = ref<number | null>(null);
const moving = ref<number | null>(null);
const selected = ref("");
/** where the caret under the picker points: the chosen gap's x within the strip */
const caretX = ref(0);
const caretAt = (el: HTMLElement) => {
  const box = strip.value?.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  caretX.value = box ? Math.max(8, r.left - box.left + r.width / 2) : 8;
};

function startPlacing() {
  if (support.value !== "supported") {
    if (endpoint.value) settings.value = true;
    return;
  }
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
  pickAt.value = at;
  selected.value = "";
  nextTick(() =>
    root.value
      ?.querySelector<HTMLInputElement>('.expression-picker input[role="combobox"]')
      ?.focus(),
  );
}
function insert() {
  const tag = tags.value.find((t) => t.id === selected.value);
  if (!tag || pickAt.value == null) return;
  narrationStore.addExpression(props.bookId, props.chapterId, props.segment.id, tag, pickAt.value);
  cancel();
}
function cancel() {
  placing.value = false;
  pickAt.value = null;
  moving.value = null;
  selected.value = "";
}

// ---- a chip: replace, move, omit, remove
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
  const tag = tags.value.find((t) => t.id === value);
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
const tokenOf = (a: ExpressionAnnotation) =>
  endpoint.value?.expressions?.tags.find((t) => t.id === a.id)?.token ?? a.token;
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
        v-if="support === 'supported'"
        class="btn-ghost btn-xs ml-auto"
        :disabled="placing"
        @click="startPlacing"
      >
        <AddIcon class="icon-sm" /> Add expression
      </button>
      <button v-else-if="endpoint" class="btn-ghost btn-xs ml-auto" @click="settings = true">
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
        v-if="support !== 'supported'"
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

      <template v-else>
        <!-- the line itself, as a strip of words; gaps show while placing -->
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
            :moving-id="moving"
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
              : "Click the gap where the expression goes."
          }}
          <span class="text-violet-500/70">← → walk the gaps, Enter picks.</span>
          <button class="ml-2 underline" @click="cancel">Cancel</button>
        </p>
        <p v-else-if="!placing && count" class="text-zinc-400">
          Click a chip to replace, move, omit or remove it.
        </p>
        <p v-else-if="!placing" class="text-zinc-400">Nothing placed on this line yet.</p>

        <!-- the picker, under the gap that was chosen -->
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
              placeholder="Search this model’s expressions…"
              block
              size="xs"
              @keydown.enter="insert"
            />
            <div class="mt-2 flex items-center justify-end gap-1">
              <button class="btn-ghost btn-xs" @click="cancel">Cancel</button>
              <button
                class="btn-primary btn-xs"
                :disabled="!tags.some((t) => t.id === selected)"
                @click="insert"
              >
                <AddIcon class="icon-sm" /> Insert
              </button>
            </div>
          </div>
        </div>

        <!-- a chip's controls, under the chip -->
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
            <div class="flex flex-wrap items-center gap-2">
              <b>{{ current.label }}</b
              ><code class="text-violet-500">{{ tokenOf(current) }}</code
              ><span class="text-zinc-400">{{
                current.kind === "sound" ? "vocal sound" : "delivery"
              }}</span
              ><span class="text-zinc-400">· {{ gapLabel(segment.text, current.at) }}</span
              ><button class="btn-ghost btn-xs ml-auto" @click="editing = null">Done</button>
            </div>
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
            <div class="flex flex-wrap items-end gap-2">
              <label class="min-w-[12rem] flex-1"
                >Replace with<UiCombobox
                  :model-value="current.id"
                  :options="options"
                  block
                  size="xs"
                  class="mt-1"
                  @update:model-value="(v) => replace(String(v))"
              /></label>
              <button class="btn-ghost btn-xs" @click="startMove">
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

    <DialogRoot v-model:open="settings"
      ><DialogPortal
        ><DialogOverlay class="fixed inset-0 z-50 bg-black/40" /><DialogContent
          class="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(680px,96vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-4 shadow-2xl focus:outline-none dark:bg-zinc-950"
          data-expression-editor
          ><div class="mb-2 flex items-center gap-2">
            <DialogTitle class="font-semibold">Expressions for {{ endpoint?.model }}</DialogTitle
            ><DialogClose class="btn-ghost btn-xs ml-auto" aria-label="Close model expressions"
              ><CloseIcon class="icon"
            /></DialogClose>
          </div>
          <DialogDescription class="mb-3 text-xs text-zinc-500"
            >Tags are configured once per model — {{ endpoint?.name }} · {{ endpoint?.model }} — and
            every line read by it can then use them. Nothing here changes the
            book.</DialogDescription
          ><ExpressionsTab
            v-if="endpoint"
            :key="endpoint.id"
            :endpoint="endpoint" /></DialogContent></DialogPortal
    ></DialogRoot>
  </section>
</template>
