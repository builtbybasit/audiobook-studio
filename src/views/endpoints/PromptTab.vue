<script setup lang="ts">
// A scripting endpoint's say over the prompt: notes for its model, and either the library's default
// (or a book's own) or a prompt of its own.
//
// The notes are for a model's quirks — "keep paragraphs apart" — which hold whichever book it
// reads, so they are kept whatever the mode and placed wherever the prompt that is sent says
// `{{endpoint.notes}}`. A prompt without the tag does not send them, and the tab says so beside
// them rather than leaving them to vanish. A replacement is not like the notes: a book's prompt is
// about the text, and wins over it. The preview is the endpoint's prompt resolved against the
// library's saved default, filled in for a made-up book with the notes as typed, which is what a
// book without a prompt of its own would send.
//
// Staged like a connection edit, and for more reason: a prompt half-typed is often not one at all.
// The notes are staged with it, under the same Save.
import { computed, useId } from "vue";
import { Info as InfoIcon } from "@lucide/vue";
import PromptEditor from "@/components/PromptEditor.vue";
import PromptTrial from "@/components/PromptTrial.vue";
import { UiToggleGroup } from "@/ui";
import {
  NOTES_MAX_CHARS,
  libraryPrompt,
  notesProblems,
  profilePromptProblems,
  renderPrompt,
  resolvePrompt,
  sampleVars,
  unplacedNotes,
} from "@/lib/prompt";
import { isSimulated } from "@/lib/providers";
import type { UnifiedEndpoint } from "@/lib/endpoints";
import { useEndpointsStore } from "@/stores/endpoints";
import { useUiStore } from "@/stores/ui";
import {
  PROMPT_SAMPLE,
  discardProfilePrompt,
  editProfilePrompt,
  profilePromptDirty,
  profilePromptOf,
  ui,
} from "@/views/endpoints/state";
import type { ProfilePrompt } from "@/types";

const props = defineProps<{ u: UnifiedEndpoint }>();

const endpointsStore = useEndpointsStore();
const uiStore = useUiStore();
const id = useId();

const MODES = [
  { value: "default", label: "Default" },
  { value: "replace", label: "Replace" },
];
const ABOUT: Record<ProfilePrompt["mode"], string> = {
  default: "Sends the library’s default prompt, or a book’s own where it has one.",
  replace: "Sends your prompt in place of the library’s default.",
};
/** Written here: a pair of braces in the template would end the interpolation it sits in. */
const NOTES_TAG = "{{endpoint.notes}}";

const draft = computed(() => profilePromptOf(props.u)!);
const dirty = computed(() => profilePromptDirty(props.u));
const problems = computed(() => profilePromptProblems(draft.value));
const notesTrouble = computed(() => notesProblems(draft.value.notes));
const simulated = computed(() => isSimulated(props.u.baseUrl));

/** What this endpoint sends for a book without a prompt of its own: its Replace, else the default. */
const resolved = computed(() =>
  resolvePrompt({ library: endpointsStore.prompt, profile: draft.value }),
);
/** The notes are typed, and the prompt this endpoint sends by default has nowhere to put them. */
const notesDropped = computed(() =>
  unplacedNotes(resolved.value, { endpoint: draft.value.notes }).includes("endpoint"),
);
const preview = computed(() => {
  const vars = sampleVars(PROMPT_SAMPLE, { name: props.u.name, model: props.u.model });
  return renderPrompt(resolved.value, {
    ...vars,
    endpoint: { ...vars.endpoint, notes: draft.value.notes },
  });
});

function setMode(v: string | number | null) {
  const mode = v as ProfilePrompt["mode"];
  // a replacement starts from the prompt it replaces, rather than from nothing, which is no prompt
  if (mode === "replace" && !draft.value.system.trim() && !draft.value.user.trim()) {
    const from = libraryPrompt(endpointsStore.prompt);
    editProfilePrompt(props.u, { mode, system: from.system, user: from.user });
  } else editProfilePrompt(props.u, { mode });
}

function save() {
  if (problems.value.length) return;
  if (!endpointsStore.setProfilePrompt(props.u.id, draft.value)) return;
  discardProfilePrompt(props.u);
  uiStore.toast(`${props.u.name} prompt saved`, {
    kind: "success",
    description:
      "The next run on this endpoint uses it. A run already queued keeps the prompt it was queued with.",
  });
}

const count = (n: number) => n.toLocaleString("en");
</script>

<template>
  <div class="space-y-3">
    <!-- staged edits -->
    <div
      v-if="dirty"
      class="rounded-lg border border-violet-300 bg-violet-50 px-3 py-2 text-xs dark:border-violet-500/50 dark:bg-violet-500/10"
      role="status"
    >
      <div class="flex flex-wrap items-center gap-2">
        <b class="text-violet-700 dark:text-violet-300">Unsaved changes</b>
        <span class="text-zinc-600 dark:text-zinc-300">
          <template v-if="problems.length"
            >Fix the notes or the prompt below to save them.</template
          >
          <template v-else>Nothing is using them yet.</template>
        </span>
        <span class="ml-auto flex gap-2">
          <button class="btn-ghost btn-xs" @click="discardProfilePrompt(u)">Discard</button>
          <button class="btn-primary btn-xs" :disabled="problems.length > 0" @click="save">
            Save prompt
          </button>
        </span>
      </div>
    </div>

    <p
      v-if="simulated"
      class="rounded-md bg-zinc-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-500 dark:bg-zinc-800/60"
    >
      <InfoIcon class="icon-sm" />
      A simulated endpoint scripts from the text alone and ignores the prompt. What is set here is
      kept, and sent once the endpoint points at a real model.
    </p>

    <!-- notes: kept whatever the mode, so above it -->
    <section class="card space-y-1.5 p-3 text-xs">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <label :for="`${id}-notes`" class="label">Notes for this model</label>
        <span
          class="font-mono text-[10px]"
          :class="
            draft.notes.length > NOTES_MAX_CHARS
              ? 'text-red-600 dark:text-red-400'
              : 'text-zinc-400'
          "
          >{{ count(draft.notes.length) }} / {{ count(NOTES_MAX_CHARS) }}</span
        >
      </div>
      <textarea
        :id="`${id}-notes`"
        :value="draft.notes"
        rows="3"
        placeholder="e.g. Keep paragraphs apart; never merge two paragraphs into one line."
        :aria-describedby="`${id}-notes-hint ${id}-notes-status`"
        class="input w-full resize-y text-xs leading-relaxed"
        @input="editProfilePrompt(u, { notes: ($event.target as HTMLTextAreaElement).value })"
      ></textarea>
      <p :id="`${id}-notes-hint`" class="text-[11px] leading-relaxed text-zinc-500">
        Sent where the prompt says <code class="font-mono">{{ NOTES_TAG }}</code
        >, whichever prompt this endpoint sends. A book with a prompt of its own sends them only if
        that prompt has the tag.
      </p>
      <div :id="`${id}-notes-status`" aria-live="polite" class="space-y-1">
        <p
          v-if="notesDropped"
          class="rounded-md bg-amber-400/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
        >
          <template v-if="draft.mode === 'replace'"
            >This endpoint’s prompt below has no <code class="font-mono">{{ NOTES_TAG }}</code
            >, so these notes are not sent. Add the tag where they should go.</template
          >
          <template v-else
            >The library’s default prompt has no <code class="font-mono">{{ NOTES_TAG }}</code
            >, so these notes are not sent. Add the tag to the
            <button
              type="button"
              class="text-violet-600 underline-offset-2 hover:underline dark:text-violet-400"
              @click="ui.showLibraryPrompt = true"
            >
              Default prompt</button
            >, or switch to Replace.</template
          >
        </p>
        <ul
          v-if="notesTrouble.length"
          class="space-y-0.5 rounded-md bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300"
        >
          <li v-for="p in notesTrouble" :key="p">{{ p }}</li>
        </ul>
      </div>
    </section>

    <section class="card space-y-3 p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="label">This endpoint’s prompt</h3>
        <UiToggleGroup
          :model-value="draft.mode"
          :options="MODES"
          aria-label="Which prompt this endpoint sends"
          @update:model-value="setMode"
        />
      </div>
      <p class="text-xs text-zinc-600 dark:text-zinc-300">{{ ABOUT[draft.mode] }}</p>
      <p class="text-[11px] leading-relaxed text-zinc-500">
        A book with a prompt of its own sends it in place of this endpoint’s Replace. The library’s
        default is edited under
        <button
          type="button"
          class="text-violet-600 underline-offset-2 hover:underline dark:text-violet-400"
          @click="ui.showLibraryPrompt = true"
        >
          Default prompt</button
        >.
      </p>

      <PromptEditor
        v-if="draft.mode === 'default'"
        :system="resolved.system"
        :user="resolved.user"
        :preview="preview"
        readonly
      />
      <PromptEditor
        v-else
        :system="draft.system"
        :user="draft.user"
        :preview="preview"
        @update:system="(system) => editProfilePrompt(u, { system })"
        @update:user="(user) => editProfilePrompt(u, { user })"
      />
    </section>

    <!-- the draft as typed, on a chapter of any book: what this endpoint makes of it before Save -->
    <section class="card p-3">
      <PromptTrial
        :book-id="null"
        :chapter-id="null"
        :profile-id="u.id"
        :drafts="{ profilePrompt: draft }"
        :disabled="problems.length > 0"
        disabled-reason="Fix the problems above to try this prompt."
      />
    </section>
  </div>
</template>
