<script setup>
// Single-select segmented control. options: [{ value, label, class? }]
import { ToggleGroupItem, ToggleGroupRoot } from "reka-ui";
defineProps({
  modelValue: { default: undefined },
  options: { type: Array, default: () => [] },
  size: { type: String, default: "xs" },
  block: Boolean,
});
const emit = defineEmits(["update:modelValue"]);
</script>
<template>
  <ToggleGroupRoot
    :model-value="modelValue"
    type="single"
    class="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700"
    :class="block && 'grid w-full'"
    :style="block ? { gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` } : {}"
    @update:model-value="
      (v) => {
        if (v != null && v !== '') emit('update:modelValue', v);
      }
    "
  >
    <ToggleGroupItem
      v-for="o in options"
      :key="String(o.value)"
      :value="o.value"
      class="capitalize transition-colors hover:bg-zinc-100 data-[state=on]:bg-violet-600 data-[state=on]:text-white dark:hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-400"
      :class="[size === 'xs' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm', o.class]"
      >{{ o.label }}</ToggleGroupItem
    >
  </ToggleGroupRoot>
</template>
