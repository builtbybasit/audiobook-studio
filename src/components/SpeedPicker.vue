<script setup lang="ts">
// A speed as text that opens a slider. Saved once, as the popover closes: each save asks about
// lines read at the old pace, so it must not fire on every step of a drag. Blank (null) follows
// `fallback`; Reset goes back to blank.
import { ref } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { SPEAKER_SPEED } from "@/lib/providers";
import { UiSlider } from "@/ui";

const props = withDefaults(
  defineProps<{
    modelValue: number | null;
    label: string;
    fallback?: number;
    resetLabel?: string;
  }>(),
  { fallback: 1, resetLabel: "Reset to 1×" },
);
const emit = defineEmits<{ "update:modelValue": [number | null] }>();

const draft = ref(1);
const blank = ref(true);
function toggled(open: boolean) {
  if (open) {
    draft.value = props.modelValue ?? props.fallback;
    blank.value = props.modelValue == null;
    return;
  }
  // a slider step can land a hair off the hundredth
  const speed = blank.value ? null : Math.round(draft.value * 100) / 100;
  if (speed !== props.modelValue) emit("update:modelValue", speed);
}
function reset() {
  draft.value = props.fallback;
  blank.value = true;
}
</script>

<template>
  <PopoverRoot @update:open="toggled">
    <PopoverTrigger
      class="input w-14 shrink-0 cursor-pointer px-1.5! text-center tabular-nums data-[state=open]:border-violet-400"
      :class="modelValue == null && 'text-zinc-400'"
      :aria-label="label"
      >{{ modelValue ?? fallback }}×</PopoverTrigger
    >
    <PopoverPortal>
      <PopoverContent align="start" :side-offset="6" class="ui-popup w-60 p-3 text-xs">
        <div class="mb-2 flex items-center justify-between">
          <span class="label">Speed</span>
          <span class="font-mono tabular-nums" :class="blank && 'text-zinc-400'"
            >{{ draft.toFixed(2) }}×</span
          >
        </div>
        <UiSlider
          :model-value="draft"
          :min="SPEAKER_SPEED.min"
          :max="SPEAKER_SPEED.max"
          :step="0.05"
          :label="label"
          @update:model-value="(v) => ((draft = v), (blank = false))"
        />
        <div class="mt-1 flex items-center justify-between text-[10px] text-zinc-400">
          <span>{{ SPEAKER_SPEED.min }}×</span>
          <button class="btn-ghost btn-xs" :disabled="blank" @click="reset">
            {{ resetLabel }}
          </button>
          <span>{{ SPEAKER_SPEED.max }}×</span>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
