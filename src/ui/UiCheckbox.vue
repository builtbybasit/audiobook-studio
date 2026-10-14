<script setup lang="ts">
// modelValue: true | false | 'indeterminate'. A native box, not reka's: lists tick hundreds of rows.
// The browser flips it on click, so after the re-render it is reset to `modelValue`: a tick the
// caller does not take is not left drawn. Callers must not preventDefault the click.
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
