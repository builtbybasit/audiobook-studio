<script setup lang="ts">
// The library's default scripting prompt: what every scripting endpoint sends for every book, until
// an endpoint replaces it (its Prompt tab), or a book brings its own (the book's Scripting page).
// The built-in prompt until somebody edits it here, and again after Reset. An endpoint's notes and a
// book's go where this says `{{endpoint.notes}}` and `{{book.notes}}`; a draft without a tag says
// whose notes it would stop sending.
//
// Staged and saved with a button, like an endpoint's own prompt; see `state.ts` for why.
import { computed } from "vue";
import PromptEditor from "@/components/PromptEditor.vue";
import { UiHint } from "@/ui";
import {
  BUILT_IN_PROMPT,
  promptProblems,
  renderPrompt,
  sampleVars,
  unplacedNotes,
} from "@/lib/prompt";
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import {
  PROMPT_SAMPLE,
  editLibraryPrompt,
  libraryPromptDirty,
  libraryPromptOf,
  ui,
} from "@/views/endpoints/state";

const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();

const draft = computed(() => libraryPromptOf(endpointsStore.prompt));
const dirty = computed(() => libraryPromptDirty(endpointsStore.prompt));
const problems = computed(() => promptProblems(draft.value));
const builtIn = computed(
  () => draft.value.system === BUILT_IN_PROMPT.system && draft.value.user === BUILT_IN_PROMPT.user,
);

/** Written here: a pair of braces in the template would end the interpolation it sits in. */
const NOTES_TAG = "{{book.notes}}";
const ENDPOINT_NOTES_TAG = "{{endpoint.notes}}";

/** The endpoints that send a prompt of their own instead of this one. */
const replacing = computed(() =>
  endpointsStore.profiles.filter((p) => p.prompt?.mode === "replace").map((p) => p.name),
);
/**
 * The endpoints that send this prompt and have notes it would not place: saved notes, since a
 * draft on an endpoint's tab is not sent by anything yet.
 */
const notesDropped = computed(() =>
  endpointsStore.profiles
    .filter(
      (p) =>
        p.prompt?.mode !== "replace" &&
        unplacedNotes(draft.value, { endpoint: p.prompt?.notes }).includes("endpoint"),
    )
    .map((p) => p.name),
);

/** Filled in for the first scripting endpoint, so `{{model}}` and its notes show something real. */
const preview = computed(() => {
  const p = endpointsStore.profiles[0];
  const vars = sampleVars(PROMPT_SAMPLE, {
    name: p?.name ?? "An endpoint",
    model: p?.model ?? "a-model-id",
  });
  return renderPrompt(draft.value, {
    ...vars,
    endpoint: { ...vars.endpoint, notes: p?.prompt?.notes },
  });
});

function save() {
  if (problems.value.length) return;
  if (!endpointsStore.setLibraryPrompt(draft.value)) return;
  ui.libraryPrompt = null;
  uiStore.toast(builtIn.value ? "Default prompt reset to built-in" : "Default prompt saved", {
    kind: "success",
    description:
      "The next run uses it, on every endpoint that does not replace it and for every book without a prompt of its own. A run already queued keeps the prompt it was queued with.",
  });
}
</script>

<template>
  <div class="space-y-3">
    <div class="card p-3">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-lg font-semibold">
          Default prompt
          <UiHint label="the default prompt" side="bottom"
            >What every scripting endpoint sends unless it replaces it or a book has its own; notes
            go where it says <code class="font-mono">{{ ENDPOINT_NOTES_TAG }}</code> or
            <code class="font-mono">{{ NOTES_TAG }}</code
            >.</UiHint
          >
        </h2>
        <span class="chip chip-off">{{ endpointsStore.prompt ? "edited" : "built-in" }}</span>
        <span v-if="dirty" class="chip chip-on" title="You have unsaved prompt changes"
          >unsaved</span
        >
      </div>
      <p v-if="replacing.length" class="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
        Replaced on {{ replacing.join(", ") }}.
      </p>
      <p
        v-if="notesDropped.length"
        class="mt-1.5 rounded-md bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
        role="status"
      >
        This prompt has no <code class="font-mono">{{ ENDPOINT_NOTES_TAG }}</code
        >, so it would not send the notes for {{ notesDropped.join(", ") }}.
      </p>
    </div>

    <!-- staged edits -->
    <div
      v-if="dirty"
      class="rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs dark:border-violet-500/50 dark:bg-violet-500/10"
      role="status"
    >
      <div class="flex flex-wrap items-center gap-2">
        <b class="text-violet-700 dark:text-violet-300">Unsaved changes</b>
        <span class="text-zinc-600 dark:text-zinc-300">
          <template v-if="problems.length">Fix the prompt below to save it.</template>
          <template v-else>Nothing is using this prompt yet.</template>
        </span>
        <span class="ml-auto flex gap-2">
          <button class="btn-ghost btn-xs" @click="ui.libraryPrompt = null">Discard</button>
          <button class="btn-primary btn-xs" :disabled="problems.length > 0" @click="save">
            Save prompt
          </button>
        </span>
      </div>
    </div>

    <section class="card p-3">
      <PromptEditor
        :system="draft.system"
        :user="draft.user"
        :reset-to="BUILT_IN_PROMPT"
        :preview="preview"
        @update:system="(system) => editLibraryPrompt(endpointsStore.prompt, { system })"
        @update:user="(user) => editLibraryPrompt(endpointsStore.prompt, { user })"
      />
    </section>
  </div>
</template>
