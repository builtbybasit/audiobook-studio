<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useScriptsStore } from "@/stores/scripts";

import { computed, ref } from "vue";
import { Plus as AddIcon, Trash2 as RemoveIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import { UiHint, UiSelect } from "@/ui";

import { configErrors, expressionId, validToken } from "@/lib/expressions";
import { tagSyntaxOf } from "@/lib/providers";
import { expressionDraft, resetExpressionDraft } from "@/views/endpoints/expressionState";
import type { Endpoint, ExpressionTag } from "@/types";
const props = defineProps<{ endpoint: Endpoint }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const scriptsStore = useScriptsStore();
const draft = computed(() => expressionDraft(props.endpoint));
const label = ref("");
const token = ref("");
const kind = ref<ExpressionTag["kind"]>("sound");
const attempted = ref(false);
const error = ref("");
// the tag syntax is the provider's, for the model and base URL on the page now
const syntax = computed(() => tagSyntaxOf(props.endpoint));
const example = computed(() => syntax.value?.example ?? "[laughter]");
const kinds = computed(() =>
  [
    { value: "sound", label: "Vocal sound" },
    { value: "delivery", label: "Delivery instruction" },
  ].filter((k) => syntax.value?.kinds.includes(k.value as ExpressionTag["kind"]) ?? true),
);
// held to the model it will be saved for, which is the endpoint's now, not the one it was drafted for
const errors = computed(() =>
  configErrors({ ...draft.value, model: props.endpoint.model, baseUrl: props.endpoint.baseUrl }),
);
const modelChanged = computed(
  () =>
    draft.value.model !== props.endpoint.model || draft.value.baseUrl !== props.endpoint.baseUrl,
);
const affected = computed(() =>
  Object.entries(scriptsStore.segments).reduce(
    (n, [key, segs]) =>
      n +
      segs.filter(
        (s) =>
          s.expressions?.some((a) => !a.omitted) &&
          castStore.effectiveVoice(key.split(":")[0], s.speaker).endpoint?.id === props.endpoint.id,
      ).length,
    0,
  ),
);
function add() {
  error.value = "";
  if (!label.value.trim() || !validToken(token.value.trim(), syntax.value)) {
    error.value = `Enter a name and a complete tag, such as ${example.value}.`;
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
  if (endpointsStore.saveExpressionConfig(props.endpoint.id, draft.value)) {
    resetExpressionDraft(props.endpoint);
    attempted.value = false;
  }
}
</script>

<template>
  <section class="card space-y-4 p-4 text-sm" data-expression-editor>
    <h3 class="font-semibold">
      Expression support
      <UiHint
        label="expression support"
        :text="`What ${endpoint.model} understands, declared here: saved tags become choices for every speaker on this model, and nothing is assumed of the provider.`"
      />
    </h3>
    <p
      v-if="modelChanged"
      class="rounded-md bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
    >
      <WarnIcon class="icon-sm" /> The model or server changed; expressions are blocked until this
      list is confirmed for {{ endpoint.model }}.
    </p>
    <p v-if="!syntax" class="text-xs text-zinc-500">
      {{ endpoint.model }} takes no expression tags — a tag sent to it would be read out as words.
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
      <p class="text-xs text-zinc-500">
        {{ syntax?.hint ?? "This model takes no expression tags." }}
        <UiHint label="tag syntax"
          >Copy the exact syntax from the provider’s documentation: a name such as “Laughter” maps
          to <code>{{ example }}</code> here and to a different tag on another model.</UiHint
        >
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
              :placeholder="example"
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
      Plain narration still works; annotated lines need review before rendering.
    </p>
    <div class="border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <p class="mb-3 text-xs text-zinc-500">
        {{ affected }} annotated {{ affected === 1 ? "line uses" : "lines use" }} this endpoint.
        <UiHint
          label="saving expressions"
          text="Changes apply to future requests; rendered audio whose expressions differ is marked stale, and audio in flight keeps its tags."
        />
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
