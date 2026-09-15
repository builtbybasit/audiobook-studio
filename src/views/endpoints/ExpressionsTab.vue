<script setup lang="ts">
import { computed, ref } from "vue";
import { Plus as AddIcon, Trash2 as RemoveIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import { UiSelect } from "@/ui";
import { useApp } from "@/stores/app";
import { configErrors, expressionId, validToken } from "@/lib/expressions";
import { expressionDraft, resetExpressionDraft } from "./expressionState";
import type { Endpoint, ExpressionTag } from "@/types";
const props = defineProps<{ endpoint: Endpoint }>();
const app = useApp();
const draft = computed(() => expressionDraft(props.endpoint));
const label = ref("");
const token = ref("");
const kind = ref<ExpressionTag["kind"]>("sound");
const attempted = ref(false);
const error = ref("");
const kinds = [
  { value: "sound", label: "Vocal sound" },
  { value: "delivery", label: "Delivery instruction" },
];
const errors = computed(() => configErrors(draft.value));
const modelChanged = computed(
  () =>
    draft.value.model !== props.endpoint.model || draft.value.baseUrl !== props.endpoint.baseUrl,
);
const affected = computed(() =>
  Object.entries(app.segments).reduce(
    (n, [key, segs]) =>
      n +
      segs.filter(
        (s) =>
          s.expressions?.some((a) => !a.omitted) &&
          app.effectiveVoice(key.split(":")[0], s.speaker).endpoint?.id === props.endpoint.id,
      ).length,
    0,
  ),
);
function add() {
  error.value = "";
  if (!label.value.trim() || !validToken(token.value.trim())) {
    error.value = "Enter a name and a complete tag, such as [laughter].";
    return;
  }
  const id = expressionId(label.value);
  if (
    draft.value.tags.some(
      (t) => t.id === id || expressionId(t.label) === id || t.token === token.value.trim(),
    )
  ) {
    error.value = "That name or tag is already in the list.";
    return;
  }
  draft.value.tags.push({
    id,
    label: label.value.trim(),
    token: token.value.trim(),
    kind: kind.value,
  });
  label.value = "";
  token.value = "";
}
function save() {
  attempted.value = true;
  if (errors.value.length) return;
  if (app.saveExpressionConfig(props.endpoint.id, draft.value)) {
    resetExpressionDraft(props.endpoint);
    attempted.value = false;
  }
}
</script>

<template>
  <section class="card space-y-4 p-4 text-sm" data-expression-editor>
    <div>
      <h3 class="font-semibold">Expression support</h3>
      <p class="mt-1 text-xs leading-relaxed text-zinc-500">
        Declare what <b class="break-all">{{ endpoint.model }}</b> understands. Saved tags become
        choices for every speaker using this model. No provider support is assumed.
      </p>
    </div>
    <p
      v-if="modelChanged"
      class="rounded-md bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
    >
      <WarnIcon class="icon-sm" /> The model or server changed. Review this list, then save to
      confirm it for {{ endpoint.model }}. Expressions are blocked until reviewed.
    </p>
    <label class="block text-xs text-zinc-500"
      >This model supports
      <UiSelect
        v-model="draft.status"
        class="mt-1"
        block
        :options="[
          { value: 'unknown', label: 'Not configured' },
          { value: 'unsupported', label: 'No expression tags' },
          { value: 'supported', label: 'A specific set of tags' },
        ]"
      />
    </label>
    <template v-if="draft.status === 'supported'">
      <p class="text-xs leading-relaxed text-zinc-500">
        Copy exact syntax from your model’s documentation. For example, a name such as “Laughter”
        can map to <code>[laughter]</code> on one model and a different tag on another. Vocal sounds
        and delivery instructions have separate groups.
      </p>
      <div v-if="draft.tags.length" class="space-y-3">
        <div
          v-for="(tag, index) in draft.tags"
          :key="tag.id"
          class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
        >
          <label class="min-w-0 text-xs text-zinc-500"
            >Name<input
              v-model="tag.label"
              :aria-label="`Expression ${index + 1} name`"
              class="input mt-1 w-full"
          /></label>
          <label class="min-w-0 text-xs text-zinc-500"
            >Exact syntax<input
              v-model="tag.token"
              :aria-label="`Expression ${index + 1} syntax`"
              class="input mt-1 w-full font-mono"
              spellcheck="false"
          /></label>
          <button
            class="btn-ghost btn-xs self-end"
            :aria-label="`Remove ${tag.label}`"
            @click="draft.tags.splice(index, 1)"
          >
            <RemoveIcon class="icon-sm" />
          </button>
          <UiSelect
            v-model="tag.kind"
            :aria-label="`Expression ${index + 1} category`"
            :options="kinds"
            class="col-span-2"
            size="xs"
          />
        </div>
      </div>
      <form class="space-y-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50" @submit.prevent="add">
        <div class="label">Add a supported expression</div>
        <div class="grid grid-cols-2 gap-2">
          <label class="text-xs text-zinc-500"
            >Name<input
              v-model="label"
              class="input mt-1 w-full"
              placeholder="Laughter"
              aria-label="New expression name" /></label
          ><label class="text-xs text-zinc-500"
            >Exact syntax<input
              v-model="token"
              class="input mt-1 w-full font-mono"
              placeholder="[laughter]"
              aria-label="New expression syntax"
              spellcheck="false"
          /></label>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UiSelect
            v-model="kind"
            :options="kinds"
            size="xs"
            aria-label="New expression category"
          /><button type="submit" class="btn-ghost btn-xs ml-auto">
            <AddIcon class="icon-sm" /> Add to list
          </button>
        </div>
        <p v-if="error" role="alert" class="text-xs text-red-500">{{ error }}</p>
      </form>
    </template>
    <p v-else class="text-xs text-zinc-500">
      Plain narration still works. Lines with active expression annotations will need review before
      rendering.
    </p>
    <div class="border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <p class="mb-3 text-xs text-zinc-500">
        {{ affected }} annotated {{ affected === 1 ? "line uses" : "lines use" }} this endpoint.
        Changes apply to future requests; rendered audio is marked stale when its expressions
        differ. In-flight audio keeps its original tags.
      </p>
      <p
        v-for="message in attempted ? errors : []"
        :key="message"
        role="alert"
        class="mb-2 text-xs text-red-500"
      >
        {{ message }}
      </p>
      <div class="flex gap-2">
        <button class="btn-primary btn-xs" @click="save">
          {{ modelChanged ? "Confirm for this model" : "Save expression support" }}</button
        ><button
          class="btn-ghost btn-xs"
          @click="
            resetExpressionDraft(endpoint);
            attempted = false;
            error = '';
          "
        >
          Discard edits
        </button>
      </div>
    </div>
  </section>
</template>
