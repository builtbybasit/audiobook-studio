<script setup lang="ts">
// Compact numeric field. No spinner arrows: at this size they eat a third of the box, fire on a
// stray scroll, and every one of these values is typed or nudged with ↑/↓ anyway (shift = ×10).
// The field holds a draft while it is being typed and commits on blur or Enter, so a half-typed
// "0." never reaches the store; an out-of-range or unreadable value snaps back on commit.
// `empty` makes a blank field mean something (null = "no cap"); without it, clearing reverts.
import { computed, ref, watch } from "vue";
const props = withDefaults(
  defineProps<{
    modelValue: number | null;
    min?: number;
    max?: number;
    step?: number;
    /** what a blank field commits; leave unset to make blank invalid */
    empty?: number | null;
    /** sits inside the field, before the number ($) */
    prefix?: string;
    /** sits inside the field, after the number (s, ×, per 1M) */
    unit?: string;
    placeholder?: string;
    label?: string;
    align?: "left" | "right";
    mono?: boolean;
    disabled?: boolean;
  }>(),
  { step: 1, align: "right", mono: true },
);
const emit = defineEmits<{ "update:modelValue": [number | null] }>();

const draft = ref(props.modelValue == null ? "" : String(props.modelValue));
const editing = ref(false);
watch(
  () => props.modelValue,
  (v) => {
    if (!editing.value) draft.value = v == null ? "" : String(v);
  },
);
const blank = computed(() => props.empty !== undefined);
/** floats out of ↑/↓ arithmetic: 0.35 + 0.05 is 0.39999999999999997 */
const clean = (n: number): number => Number(n.toFixed(6));
function clamp(n: number): number {
  if (props.min != null) n = Math.max(props.min, n);
  if (props.max != null) n = Math.min(props.max, n);
  return clean(n);
}
const shown = (): string => (props.modelValue == null ? "" : String(props.modelValue));
/** Enter fires change *and* blur, so this runs twice: it has to land on the same value both times. */
function commit() {
  editing.value = false;
  const raw = draft.value.trim().replace(",", ".");
  if (!raw && blank.value) {
    draft.value = "";
    emit("update:modelValue", props.empty ?? null);
    return;
  }
  const n = Number(raw);
  if (raw && Number.isFinite(n)) {
    const v = clamp(n);
    draft.value = String(v); // what was committed, not what was typed: 9 in a 0–5 field reads 5
    emit("update:modelValue", v);
  } else {
    draft.value = shown(); // unreadable or empty where empty means nothing: snap back
  }
}
function nudge(by: number) {
  const from = Number(draft.value) || props.modelValue || 0;
  const next = clamp(from + by);
  draft.value = String(next);
  editing.value = false;
  emit("update:modelValue", next);
}
function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    nudge((e.key === "ArrowUp" ? 1 : -1) * props.step * (e.shiftKey ? 10 : 1));
  } else if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  else if (e.key === "Escape") {
    draft.value = shown();
    editing.value = false;
    (e.target as HTMLInputElement).blur();
  }
}
</script>

<template>
  <span
    class="input inline-flex items-center gap-1 py-0.5"
    :class="disabled && 'pointer-events-none opacity-40'"
  >
    <span v-if="prefix" class="shrink-0 text-zinc-400">{{ prefix }}</span>
    <input
      v-model="draft"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      class="w-full min-w-0 bg-transparent outline-none"
      :class="[mono && 'font-mono', align === 'right' && 'text-right']"
      :placeholder="placeholder"
      :aria-label="label"
      :disabled="disabled"
      @focus="editing = true"
      @change="commit"
      @blur="commit"
      @keydown="onKey"
    />
    <span v-if="unit" class="shrink-0 text-[11px] text-zinc-400">{{ unit }}</span>
  </span>
</template>
