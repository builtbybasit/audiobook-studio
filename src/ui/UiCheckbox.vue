<script setup>
// modelValue: true | false | 'indeterminate'
import { CheckboxIndicator, CheckboxRoot } from "reka-ui";
defineProps({
  modelValue: { default: false },
  disabled: Boolean,
  size: { type: String, default: "sm" },
});
const emit = defineEmits(["update:modelValue", "click"]);
</script>
<template>
  <CheckboxRoot
    :model-value="modelValue"
    :disabled="disabled"
    class="grid shrink-0 place-items-center rounded border border-zinc-400 bg-white transition-colors data-[state=checked]:border-violet-600 data-[state=checked]:bg-violet-600 data-[state=indeterminate]:border-violet-600 data-[state=indeterminate]:bg-violet-600 disabled:opacity-40 dark:border-zinc-600 dark:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
    :class="size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4'"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @click="(e) => emit('click', e)"
  >
    <CheckboxIndicator
      class="text-white leading-none"
      :class="size === 'xs' ? 'text-[9px]' : 'text-[11px]'"
    >
      <template v-if="modelValue === 'indeterminate'">−</template><template v-else>✓</template>
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
