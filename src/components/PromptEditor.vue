<script setup lang="ts">
// The two messages of a scripting prompt, edited as text with `{{tags}}`. The parent owns the
// texts, their saving and the preview; the rules shown are `@/lib/prompt`'s. The fixed output
// format is shown too, since a prompt read without it seems to ask for nothing.
import { computed, nextTick, ref, useId } from "vue";
import { RotateCcw as ResetIcon } from "@lucide/vue";
import {
  PROMPT_MAX_CHARS,
  PROMPT_TAGS,
  SCRIPT_MARKERS,
  lineEffectsOf,
  outputFormat,
  promptProblems,
  promptWarnings,
} from "@/lib/prompt";
import { useEffects } from "@/queries";
import type { PromptTemplate, RenderedPrompt } from "@/types";
import { UiHint } from "@/ui";

/** a literal `{{…}}` in the template would be read as interpolation */
const EXPRESSIONS_TAG = "{{expressions}}";

const props = withDefaults(
  defineProps<{
    system: string;
    user: string;
    /** the messages as they would be sent, rendered by the parent; none hides the preview */
    preview?: RenderedPrompt | null;
    /** what the reset button puts back; none hides the button */
    resetTo?: PromptTemplate | null;
    /** the reset button's words, for a `resetTo` that is not the built-in prompt */
    resetLabel?: string;
    readonly?: boolean;
  }>(),
  { preview: null, resetTo: null, resetLabel: "Reset to built-in", readonly: false },
);
const emit = defineEmits<{ "update:system": [string]; "update:user": [string] }>();

const id = useId();
/** For the cursor a chip inserts at. Not state: nothing renders from them. */
const els: Record<"system" | "user", HTMLTextAreaElement | null> = { system: null, user: null };
/** the textarea last focused; a tag chip inserts there */
const last = ref<"system" | "user">("user");

const { effects } = useEffects();
const lineEffects = computed(() => lineEffectsOf(effects.value));
const format = computed(() => outputFormat(SCRIPT_MARKERS[0], lineEffects.value));

const template = computed<PromptTemplate>(() => ({ system: props.system, user: props.user }));
const problems = computed(() => promptProblems(template.value));
const warnings = computed(() => promptWarnings(template.value));
const atReset = computed(
  () =>
    !!props.resetTo && props.resetTo.system === props.system && props.resetTo.user === props.user,
);

function set(which: "system" | "user", value: string) {
  if (which === "system") emit("update:system", value);
  else emit("update:user", value);
}

/** Put `{{name}}` at the cursor of the last-focused textarea and hand the focus back after it. */
async function insert(name: string) {
  const which = last.value;
  const el = els[which];
  const text = which === "system" ? props.system : props.user;
  const tag = tagOf(name);
  const start = el?.selectionStart ?? text.length;
  const end = el?.selectionEnd ?? text.length;
  set(which, text.slice(0, start) + tag + text.slice(end));
  await nextTick();
  if (!el) return;
  el.focus();
  el.setSelectionRange(start + tag.length, start + tag.length);
}

function reset() {
  if (!props.resetTo) return;
  emit("update:system", props.resetTo.system);
  emit("update:user", props.resetTo.user);
}

/** Built here: a literal pair of braces in the template would end the interpolation. */
const tagOf = (name: string) => `{{${name}}}`;

const count = (n: number) => n.toLocaleString("en");
/** ~4 characters of English per token */
const tokens = (n: number) => count(Math.ceil(n / 4));
const previewChars = computed(() =>
  props.preview ? props.preview.system.length + props.preview.user.length : 0,
);

const FIELDS = [
  {
    which: "system",
    label: "System prompt",
    hint: "The instructions: what the model is and the rules it follows. Sent once per request, before the text.",
  },
  {
    which: "user",
    label: "User message",
    hint: "What is asked of this request, with the text to script in it.",
  },
] as const;
</script>

<template>
  <div class="space-y-3 text-xs">
    <div v-for="f in FIELDS" :key="f.which" class="space-y-1">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <label :for="`${id}-${f.which}`" class="label">{{ f.label }}</label>
        <span
          class="font-mono text-[10px]"
          :class="
            (f.which === 'system' ? system : user).length > PROMPT_MAX_CHARS
              ? 'text-red-600 dark:text-red-400'
              : 'text-zinc-400'
          "
          >{{ count((f.which === "system" ? system : user).length) }} /
          {{ count(PROMPT_MAX_CHARS) }}</span
        >
      </div>
      <textarea
        :id="`${id}-${f.which}`"
        :ref="(el) => (els[f.which] = el as HTMLTextAreaElement | null)"
        :value="f.which === 'system' ? system : user"
        :readonly="readonly"
        :rows="f.which === 'system' ? 10 : 5"
        :aria-describedby="`${id}-${f.which}-hint ${id}-problems`"
        spellcheck="false"
        class="input w-full resize-y font-mono text-xs leading-relaxed"
        :class="readonly && 'bg-zinc-50 text-zinc-600 dark:bg-zinc-950/50 dark:text-zinc-300'"
        @focus="last = f.which"
        @input="set(f.which, ($event.target as HTMLTextAreaElement).value)"
      ></textarea>
      <p :id="`${id}-${f.which}-hint`" class="text-[11px] text-zinc-500">{{ f.hint }}</p>
    </div>

    <div v-if="!readonly" class="space-y-1">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span :id="`${id}-tags`" class="label"
          >Insert a tag into the {{ last === "system" ? "system prompt" : "user message" }}</span
        >
        <button
          v-if="resetTo"
          type="button"
          class="btn-ghost btn-xs"
          :disabled="atReset"
          :data-tip="`${resetLabel}: both messages put back`"
          @click="reset"
        >
          <ResetIcon class="icon-sm" /> {{ resetLabel }}
        </button>
      </div>
      <div class="flex flex-wrap gap-1" role="group" :aria-labelledby="`${id}-tags`">
        <!-- mousedown is held back so a click leaves the cursor where it was in the textarea -->
        <button
          v-for="t in PROMPT_TAGS"
          :key="t.name"
          type="button"
          class="chip font-mono"
          :data-tip="t.about"
          :aria-label="`Insert ${tagOf(t.name)}: ${t.about}`"
          @mousedown.prevent
          @click="insert(t.name)"
        >
          {{ tagOf(t.name) }}
        </button>
      </div>
      <p class="text-[11px] text-zinc-500">
        A line whose tags all come out empty is left out, so
        <code class="font-mono">Notes on this book: {{ tagOf("book.notes") }}</code> disappears for
        a book with no notes.
      </p>
    </div>

    <!-- what stops a save, and what is only costly -->
    <div :id="`${id}-problems`" aria-live="polite" class="space-y-1">
      <ul
        v-if="problems.length"
        class="space-y-0.5 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300"
      >
        <li v-for="p in problems" :key="p">{{ p }}</li>
      </ul>
      <ul
        v-if="warnings.length"
        class="space-y-0.5 rounded-md bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
      >
        <li v-for="w in warnings" :key="w">{{ w }}</li>
      </ul>
    </div>

    <details class="rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/60">
      <summary class="cursor-pointer select-none text-[11px] text-zinc-600 dark:text-zinc-300">
        Always sent after the system prompt
      </summary>
      <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
        The output format can’t be edited: the app reads the answer as this JSON and checks it word
        for word against the text, so a prompt without it would fail every request.
      </p>
      <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
        Expression tags are written only when the prompt asks for them.
        <UiHint label="asking for expression tags"
          >Add a line such as “Add a tag for a sigh, laugh or gasp the prose shows, at most one per
          line, from: <code class="font-mono">{{ EXPRESSIONS_TAG }}</code
          >”. The model writes plain words; each voice gets them in its own brackets, and a tag a
          voice can’t take is left out.</UiHint
        >
      </p>
      <p class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
        {{
          lineEffects.length
            ? `Line effects offered, for all books: ${lineEffects.map((e) => e.name).join(", ")}.`
            : "No line effects are offered."
        }}
        <UiHint label="line effects"
          >An effect with a “Use when” sentence is offered to the model, which may put it on a line
          the text calls for, such as a voice heard over a phone. Set them under Line effects on any
          book’s Cast page; they are the same for every book.</UiHint
        >
      </p>
      <pre
        class="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-950/50 dark:text-zinc-300"
        >{{ format }}</pre>
    </details>

    <details v-if="preview" class="rounded-lg bg-zinc-50 p-2.5 dark:bg-zinc-800/60">
      <summary class="cursor-pointer select-none text-[11px] text-zinc-600 dark:text-zinc-300">
        Preview
        <span class="text-zinc-400"
          >· {{ count(previewChars) }} characters, ≈ {{ tokens(previewChars) }} tokens</span
        >
      </summary>
      <div v-for="m in ['system', 'user'] as const" :key="m" class="mt-2">
        <div class="flex items-baseline justify-between gap-2">
          <span class="label">{{ m === "system" ? "System" : "User" }}</span>
          <span class="font-mono text-[10px] text-zinc-400"
            >{{ count(preview[m].length) }} chars · ≈ {{ tokens(preview[m].length) }} tokens</span
          >
        </div>
        <pre
          class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-[11px] leading-relaxed dark:bg-zinc-950/50"
          >{{ preview[m] }}</pre>
      </div>
    </details>
  </div>
</template>
