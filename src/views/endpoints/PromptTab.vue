<script setup lang="ts">
// A scripting endpoint's say over the prompt: none (the library's default, or a book's own), an
// addition to whatever it is given, or a prompt of its own.
//
// An addition is for a model's quirks — they hold whichever book it reads, so it is added after a
// book's own prompt too. A replacement is not: a book's prompt is about the text, and wins over it.
// The preview is the endpoint's prompt resolved against the library's saved default, filled in for
// a made-up book, which is what a book without a prompt of its own would send.
//
// Staged like a connection edit, and for more reason: a prompt half-typed is often not one at all.
import { computed } from "vue";
import { Info as InfoIcon } from "@lucide/vue";
import PromptEditor from "@/components/PromptEditor.vue";
import { UiToggleGroup } from "@/ui";
import {
  libraryPrompt,
  promptProblems,
  renderPrompt,
  resolvePrompt,
  sampleVars,
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

const MODES = [
  { value: "default", label: "Default" },
  { value: "append", label: "Append" },
  { value: "replace", label: "Replace" },
];
const ABOUT: Record<ProfilePrompt["mode"], string> = {
  default: "Sends the library’s default prompt, or a book’s own where it has one.",
  append:
    "Adds your text after whichever prompt this endpoint is given — for a model’s quirks, such as keeping paragraphs apart.",
  replace: "Sends your prompt in place of the library’s default.",
};

const draft = computed(() => profilePromptOf(props.u)!);
const dirty = computed(() => profilePromptDirty(props.u));
const problems = computed(() =>
  draft.value.mode === "default"
    ? []
    : promptProblems(draft.value, draft.value.mode === "append" ? "append" : "whole"),
);
const simulated = computed(() => isSimulated(props.u.baseUrl));

const resolved = computed(() =>
  resolvePrompt({ library: endpointsStore.prompt, profile: draft.value }),
);
const preview = computed(() =>
  renderPrompt(
    resolved.value,
    sampleVars(PROMPT_SAMPLE, { name: props.u.name, model: props.u.model }),
  ),
);

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
          <template v-if="problems.length">Fix the prompt below to save it.</template>
          <template v-else>Nothing is using this prompt yet.</template>
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

    <section class="card space-y-3 p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="label">This endpoint’s prompt</h3>
        <UiToggleGroup
          :model-value="draft.mode"
          :options="MODES"
          aria-label="How this endpoint uses the prompt"
          @update:model-value="setMode"
        />
      </div>
      <p class="text-xs text-zinc-600 dark:text-zinc-300">{{ ABOUT[draft.mode] }}</p>
      <p class="text-[11px] leading-relaxed text-zinc-500">
        A book with a prompt of its own sends it in place of an endpoint’s Replace; an endpoint’s
        Append is still added after it. The library’s default is edited under
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
        kind="whole"
        :preview="preview"
        readonly
      />
      <PromptEditor
        v-else
        :key="draft.mode"
        :system="draft.system"
        :user="draft.user"
        :kind="draft.mode === 'append' ? 'append' : 'whole'"
        :preview="preview"
        @update:system="(system) => editProfilePrompt(u, { system })"
        @update:user="(user) => editProfilePrompt(u, { user })"
      />
      <p v-if="draft.mode === 'append'" class="text-[11px] leading-relaxed text-zinc-500">
        Each message you fill in is added after the one it is given, a blank line between. Either
        may stay empty.
      </p>
    </section>
  </div>
</template>
