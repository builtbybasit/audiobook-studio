<script setup>
import { SwitchRoot, SwitchThumb } from 'reka-ui'
defineProps({ modelValue: Boolean, disabled: Boolean, label: String })
const emit = defineEmits(['update:modelValue'])
</script>
<template>
  <label class="inline-flex cursor-pointer items-center gap-2 text-xs" :class="disabled && 'opacity-40'">
    <SwitchRoot :model-value="modelValue" :disabled="disabled" class="relative h-4 w-7 shrink-0 rounded-full bg-zinc-300 transition-colors data-[state=checked]:bg-violet-600 dark:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400" @update:model-value="v => emit('update:modelValue', v)">
      <SwitchThumb class="block h-3 w-3 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-3.5" />
    </SwitchRoot>
    <span v-if="label || $slots.default"><slot>{{ label }}</slot></span>
  </label>
</template>
