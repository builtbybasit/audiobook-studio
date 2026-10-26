<script setup lang="ts">
// A short list of words as chips: type and Enter (or comma) adds, × or Backspace on empty removes.
import { ref } from "vue";
import { X as RemoveIcon } from "@lucide/vue";

const props = withDefaults(
  defineProps<{ modelValue?: string[]; label: string; placeholder?: string; max?: number }>(),
  { modelValue: () => [], placeholder: "", max: 12 },
);
const emit = defineEmits<{ "update:modelValue": [string[]] }>();
const draft = ref("");

function add() {
  const word = draft.value.trim().slice(0, 80);
  draft.value = "";
  if (!word || props.modelValue.includes(word) || props.modelValue.length >= props.max) return;
  emit("update:modelValue", [...props.modelValue, word]);
}
const remove = (i: number) =>
  emit(
    "update:modelValue",
    props.modelValue.filter((_, j) => j !== i),
  );
function key(e: KeyboardEvent) {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    add();
  } else if (e.key === "Backspace" && !draft.value && props.modelValue.length)
    remove(props.modelValue.length - 1);
}
</script>

<template>
  <div
    class="input flex min-h-8 flex-wrap items-center gap-1 py-1 focus-within:ring-2 focus-within:ring-violet-400"
  >
    <span v-for="(w, i) in modelValue" :key="w" class="chip chip-on gap-0.5 pr-1">
      {{ w }}
      <button
        type="button"
        class="rounded-full hover:text-red-500"
        :aria-label="`Remove ${w}`"
        @click="remove(i)"
      >
        <RemoveIcon class="icon-sm" />
      </button>
    </span>
    <input
      v-if="modelValue.length < max"
      v-model="draft"
      class="min-w-24 flex-1 bg-transparent text-xs outline-none"
      :placeholder="modelValue.length ? '' : placeholder"
      :aria-label="label"
      maxlength="80"
      @keydown="key"
      @blur="add"
    />
  </div>
</template>
