<script setup>
import { computed } from 'vue'
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'
const props = defineProps({ modelValue: Number, min: { type: Number, default: 0 }, max: { type: Number, default: 100 }, step: { type: Number, default: 1 }, disabled: Boolean, label: String })
const emit = defineEmits(['update:modelValue'])
const arr = computed({ get: () => [props.modelValue ?? props.min], set: (v) => emit('update:modelValue', v[0]) })
</script>
<template>
  <SliderRoot v-model="arr" :min="min" :max="max" :step="step" :disabled="disabled" class="relative flex h-5 w-full touch-none select-none items-center" :class="disabled && 'opacity-40'">
    <SliderTrack class="relative h-1.5 grow rounded-full bg-zinc-200 dark:bg-zinc-700">
      <SliderRange class="absolute h-full rounded-full bg-violet-500" />
    </SliderTrack>
    <SliderThumb class="block h-4 w-4 rounded-full border-2 border-violet-500 bg-white shadow transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 dark:bg-zinc-900" :aria-label="label" />
  </SliderRoot>
</template>
