<script setup lang="ts" generic="T extends string | number | null | (string | number)[]">
// Segmented control. options: [{ value, label, class? }]. Single-select, or with `multiple` a set
// of values (an array, which may be empty).
import { ToggleGroupItem, ToggleGroupRoot } from "reka-ui";
import type { UiOption } from "@/ui/types";
const props = withDefaults(
  defineProps<{
    modelValue?: T;
    options?: UiOption[];
    size?: "xs" | "sm";
    block?: boolean;
    multiple?: boolean;
  }>(),
  { modelValue: undefined, options: () => [], size: "xs" },
);
const emit = defineEmits<{ "update:modelValue": [T] }>();
function update(v: unknown) {
  if (props.multiple) emit("update:modelValue", (v ?? []) as T);
  else if (v != null && v !== "") emit("update:modelValue", v as T);
}
</script>
<template>
  <ToggleGroupRoot
    :model-value="modelValue"
    :type="multiple ? 'multiple' : 'single'"
    class="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700"
    :class="block && 'grid w-full'"
    :style="block ? { gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` } : {}"
    @update:model-value="update"
  >
    <ToggleGroupItem
      v-for="o in options"
      :key="String(o.value)"
      :value="o.value"
      class="capitalize transition-colors hover:bg-zinc-100 data-[state=on]:bg-violet-600 data-[state=on]:text-white dark:hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-400"
      :class="[size === 'xs' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm', o.class]"
      ><component v-if="o.icon" :is="o.icon" class="icon-sm" />{{ o.label }}</ToggleGroupItem
    >
  </ToggleGroupRoot>
</template>
