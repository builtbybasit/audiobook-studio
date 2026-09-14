<script setup lang="ts">
// Select built on reka-ui. Options: [{ value, label, group?, disabled?, color? }]. `nullValue` lets a
// v-model of null map to a real option (reka needs a concrete value), e.g. "Narrator’s voice".
import { computed } from "vue";
import {
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectLabel,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "reka-ui";
import { Check as CheckIcon, ChevronDown as ChevronDownIcon } from "@lucide/vue";
import type { UiOption } from "@/ui/types";

const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null;
    options?: UiOption[];
    placeholder?: string;
    /** option value that stands for null */
    nullValue?: string | number;
    size?: "xs" | "sm";
    disabled?: boolean;
    block?: boolean;
  }>(),
  {
    modelValue: undefined,
    options: () => [],
    placeholder: "Choose…",
    nullValue: undefined,
    size: "sm",
  },
);
const emit = defineEmits<{ "update:modelValue": [string | number | null] }>();
const NULL = "__null__";
const EMPTY = "__empty__"; // reka forbids '' as an item value; map it
const key = (v: string | number | null): string => (v === "" ? EMPTY : String(v));
const inner = computed({
  get: () =>
    props.modelValue == null
      ? props.nullValue !== undefined
        ? NULL
        : undefined
      : key(props.modelValue),
  set: (v: string | undefined) => {
    if (v === NULL) return emit("update:modelValue", null);
    const opt = props.options.find((o) => key(o.value) === v);
    emit("update:modelValue", opt ? opt.value : (v ?? null));
  },
});
const groups = computed(() => {
  const map = new Map<string, UiOption[]>();
  for (const o of props.options) {
    const g = o.group ?? "";
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(o);
  }
  return [...map.entries()];
});
const currentLabel = computed(() =>
  props.modelValue == null
    ? props.nullValue !== undefined
      ? String(props.nullValue)
      : ""
    : (props.options.find((o) => o.value === props.modelValue)?.label ?? String(props.modelValue)),
);
</script>

<template>
  <SelectRoot v-model="inner" :disabled="disabled">
    <SelectTrigger
      class="ui-select-trigger"
      :class="[
        size === 'xs' ? 'py-0.5 text-xs' : 'py-1 text-sm',
        block && 'w-full',
        modelValue == null && nullValue !== undefined && 'italic text-zinc-400',
      ]"
    >
      <SelectValue :placeholder="placeholder" class="min-w-0 flex-1 truncate text-left">
        <slot name="value" :label="currentLabel">{{ currentLabel || placeholder }}</slot>
      </SelectValue>
      <ChevronDownIcon class="ml-1 icon-sm text-zinc-400" aria-hidden />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="ui-popup"
        :style="{
          minWidth: 'var(--reka-select-trigger-width)',
          maxHeight: 'min(320px, var(--reka-select-content-available-height))',
        }"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-if="nullValue !== undefined"
            :value="NULL"
            class="ui-item italic text-zinc-500"
            ><SelectItemText>{{ nullValue }}</SelectItemText
            ><SelectItemIndicator class="ml-auto text-violet-500"
              ><CheckIcon class="icon-sm" /></SelectItemIndicator
          ></SelectItem>
          <template v-for="[g, opts] in groups" :key="g">
            <SelectGroup>
              <SelectLabel
                v-if="g"
                class="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400"
                >{{ g }}</SelectLabel
              >
              <SelectItem
                v-for="o in opts"
                :key="key(o.value)"
                :value="key(o.value)"
                :disabled="o.disabled"
                class="ui-item"
              >
                <span
                  v-if="o.color"
                  class="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                  :style="{ background: o.color }"
                ></span>
                <SelectItemText>{{ o.label }}</SelectItemText>
                <span v-if="o.hint" class="ml-2 text-[10px] text-zinc-400">{{ o.hint }}</span>
                <SelectItemIndicator class="ml-auto pl-2 text-violet-500"
                  ><CheckIcon class="icon-sm"
                /></SelectItemIndicator>
              </SelectItem>
            </SelectGroup>
          </template>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
