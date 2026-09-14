<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { UiNumber, UiSlider } from "@/ui";
const props = withDefaults(
  defineProps<{
    modelValue: number;
    label: string;
    min?: number;
    initialMax?: number;
    unit?: string;
  }>(),
  { min: 0, initialMax: 100, unit: "" },
);
const emit = defineEmits<{ "update:modelValue": [number] }>();
const scale = ref(props.initialMax);
watch(
  () => props.modelValue,
  (value) => {
    if (Number.isFinite(value) && value > scale.value)
      scale.value = Math.min(Number.MAX_SAFE_INTEGER, Math.pow(10, Math.ceil(Math.log10(value))));
  },
  { immediate: true },
);
const value = computed({ get: () => props.modelValue, set: (v) => emit("update:modelValue", v) });
/** these are counts and limits — whole numbers only */
function commit(n: number | null) {
  if (n != null && Number.isFinite(n))
    emit("update:modelValue", Math.max(props.min, Math.round(n)));
}
</script>
<template>
  <div>
    <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
      <span class="text-sm font-medium">{{ label }}</span>
      <div class="flex items-center gap-2">
        <UiNumber
          class="w-28"
          :model-value="modelValue"
          :min="min"
          :step="1"
          :unit="unit"
          :label="label"
          @update:model-value="commit"
        />
      </div>
    </div>
    <UiSlider v-model="value" :min="min" :max="scale" :step="1" :label="label + ' slider'" />
    <div class="mt-1 flex justify-between text-[10px] text-zinc-400">
      <span>{{ min.toLocaleString() }}</span
      ><span>{{ scale.toLocaleString() }} · range expands with typed values</span>
    </div>
  </div>
</template>
