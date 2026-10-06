<script setup lang="ts">
import { useCastStore } from "@/stores/cast";
import { useEndpointsStore } from "@/stores/endpoints";
import { useScriptsStore } from "@/stores/scripts";

import { computed, ref } from "vue";
import { Plus as AddIcon, X as RemoveIcon, TriangleAlert as WarnIcon } from "@lucide/vue";
import { UiHint, UiToggleGroup } from "@/ui";

import { configErrors, tagToken, tagWords, typedTag, validToken } from "@/lib/expressions";
import { tagSyntaxOf } from "@/lib/providers";
import {
  expressionDirty,
  expressionDraft,
  resetExpressionDraft,
} from "@/views/endpoints/expressionState";
import type { Endpoint, TagBracket } from "@/types";
const props = defineProps<{ endpoint: Endpoint }>();
const castStore = useCastStore();
const endpointsStore = useEndpointsStore();
const scriptsStore = useScriptsStore();
const draft = computed(() => expressionDraft(props.endpoint));
const dirty = computed(() => expressionDirty(props.endpoint));
const typed = ref("");
const attempted = ref(false);
const error = ref("");
// what the provider's docs say, for the model and base URL on the page now
const syntax = computed(() => tagSyntaxOf(props.endpoint));
const BRACKET_LABELS: Record<TagBracket, string> = { round: "( )", square: "[ ]", angle: "< >" };
const BRACKET_OPTIONS = Object.entries(BRACKET_LABELS).map(([value, label]) => ({
  value,
  label,
  class: "font-mono",
}));
const example = computed(() =>
  syntax.value && validToken(syntax.value.example, draft.value.brackets)
    ? syntax.value.example
    : tagToken("laughs", draft.value.brackets),
);
const status = computed(() => (draft.value.brackets.length ? "supported" : "unsupported"));
// held to the model it will be saved for, which is the endpoint's now, not the one it was drafted for
const errors = computed(() =>
  configErrors({
    ...draft.value,
    status: status.value,
    model: props.endpoint.model,
    baseUrl: props.endpoint.baseUrl,
  }),
);
const modelChanged = computed(
  () =>
    draft.value.model !== props.endpoint.model || draft.value.baseUrl !== props.endpoint.baseUrl,
);
// never saved: the provider's brackets are only a starting point until confirmed
const unconfirmed = computed(() => !props.endpoint.expressions);
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
function setBrackets(v: unknown) {
  const brackets = v as TagBracket[];
  draft.value.brackets = brackets;
  error.value = "";
  // a tag in brackets no longer chosen moves into the first one that is
  if (brackets.length)
    for (const t of draft.value.tags)
      if (!validToken(t.token, brackets)) t.token = tagToken(tagWords(t.token), brackets);
}
function add() {
  error.value = "";
  const tag = typedTag(typed.value, draft.value.brackets);
  if (!tag.label || !validToken(tag.token, draft.value.brackets)) {
    error.value = `This model's tags are in ${draft.value.brackets.map((b) => BRACKET_LABELS[b]).join(" or ")}, such as ${example.value}.`;
    return;
  }
  if (draft.value.tags.some((t) => t.id === tag.id || t.token === tag.token)) {
    error.value = "That tag is already in the list.";
    return;
  }
  draft.value.tags.push(tag);
  typed.value = "";
}
function save() {
  attempted.value = true;
  if (errors.value.length) return;
  if (
    endpointsStore.saveExpressionConfig(props.endpoint.id, { ...draft.value, status: status.value })
  ) {
    resetExpressionDraft(props.endpoint);
    attempted.value = false;
  }
}
function discard() {
  resetExpressionDraft(props.endpoint);
  attempted.value = false;
  error.value = "";
}
</script>

<template>
  <section class="card space-y-4 p-4 text-sm" data-expression-editor>
    <h3 class="font-semibold">
      Expression tags
      <UiHint
        label="expression tags"
        :text="`${syntax?.hint ?? `${endpoint.model}'s docs list no tags; one it doesn't know is read out as words.`} Saved tags become choices for every speaker on this model.`"
      />
    </h3>
    <p
      v-if="modelChanged"
      class="rounded-md bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
    >
      <WarnIcon class="icon-sm" /> The model or server changed; expressions are blocked until these
      tags are confirmed for {{ endpoint.model }}.
    </p>
    <div class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 text-xs">
      <span class="text-zinc-500">Brackets</span>
      <div class="flex flex-wrap items-center gap-2">
        <UiToggleGroup
          :model-value="draft.brackets"
          multiple
          :options="BRACKET_OPTIONS"
          aria-label="Brackets this model's tags are written in"
          @update:model-value="setBrackets"
        />
        <span v-if="!draft.brackets.length" class="text-zinc-500"
          >None: lines are sent as plain words.</span
        >
      </div>
      <template v-if="draft.brackets.length">
        <span class="text-zinc-500">Tags</span>
        <div class="flex items-center gap-2">
          <UiToggleGroup
            :model-value="draft.open ? 'open' : 'fixed'"
            :options="[
              { value: 'fixed', label: 'Fixed list' },
              { value: 'open', label: 'Any words' },
            ]"
            aria-label="Which tags this model takes"
            @update:model-value="draft.open = $event === 'open'"
          />
          <UiHint
            label="fixed or open tags"
            text="Fixed list: a line takes only these tags. Any words: these are suggestions, and a tag can be typed on the line itself."
          />
        </div>
      </template>
    </div>
    <div v-if="draft.brackets.length" class="space-y-2">
      <div class="label">{{ draft.open ? "Suggestions" : "Tags" }}</div>
      <form class="flex flex-wrap items-center gap-1.5" @submit.prevent="add">
        <span
          v-for="(tag, index) in draft.tags"
          :key="tag.id"
          :title="tag.label"
          class="inline-flex items-center gap-0.5 rounded-full border border-zinc-200 py-0.5 pl-2.5 pr-1 font-mono text-xs dark:border-zinc-700"
          >{{ tag.token
          }}<button
            type="button"
            class="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-500 dark:hover:bg-zinc-800"
            :aria-label="`Remove ${tag.token}`"
            @click="draft.tags.splice(index, 1)"
          >
            <RemoveIcon class="icon-sm" /></button
        ></span>
        <span class="inline-flex items-center gap-1"
          ><input
            v-model="typed"
            class="input w-52 py-0.5 font-mono text-xs"
            :placeholder="example"
            aria-label="New tag"
            spellcheck="false"
          /><button type="submit" class="btn-ghost btn-xs" :disabled="!typed.trim()">
            <AddIcon class="icon-sm" /> Add
          </button></span
        >
      </form>
      <p v-if="error" role="alert" class="text-xs text-red-500">{{ error }}</p>
    </div>
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
      <div class="flex items-center gap-2">
        <button
          class="btn-primary btn-xs"
          :disabled="!dirty && !modelChanged && !unconfirmed"
          @click="save"
        >
          {{ modelChanged || unconfirmed ? "Confirm for this model" : "Save" }}</button
        ><button class="btn-ghost btn-xs" :disabled="!dirty" @click="discard">Discard</button
        ><span v-if="dirty" class="text-xs text-amber-600 dark:text-amber-400"
          >Unsaved changes</span
        >
      </div>
    </div>
  </section>
</template>
