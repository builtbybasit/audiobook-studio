<script setup lang="ts">
// modelValue: true | false | 'indeterminate'
// A native box, not reka's: lists tick hundreds of rows, and a reka checkbox is four components.
// The box flips itself on a click before anyone hears of it, so once the click has been told and the
// page has re-rendered, it is set back to what `modelValue` says — a tick the caller does not take
// is not left drawn. Callers must not preventDefault the click: the browser would undo the flip
// after this has already put it right.
import { nextTick } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue?: boolean | "indeterminate";
    disabled?: boolean;
    size?: "xs" | "sm";
  }>(),
  { modelValue: false, size: "sm" },
);
const emit = defineEmits<{
  "update:modelValue": [boolean | "indeterminate"];
  click: [MouseEvent];
}>();
function onClick(e: MouseEvent) {
  const box = e.currentTarget as HTMLInputElement;
  emit("click", e);
  // as reka did: an indeterminate box ticks
  emit("update:modelValue", props.modelValue !== true);
  void nextTick(() => {
    box.checked = props.modelValue === true;
    box.indeterminate = props.modelValue === "indeterminate";
  });
}
</script>
<template>
  <!-- Enter is kept from submitting a form, as reka's box did; it still bubbles to a row's keys -->
  <input
    type="checkbox"
    class="shrink-0 accent-violet-600 scheme-light disabled:opacity-40 dark:scheme-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
    :class="size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4'"
    :checked="modelValue === true"
    :indeterminate="modelValue === 'indeterminate'"
    :disabled="disabled"
    @click="onClick"
    @keydown.enter.prevent
  />
</template>
