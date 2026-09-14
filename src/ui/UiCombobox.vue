<script setup lang="ts">
// Searchable picker (reka Combobox) for long lists such as the cast. Options as in UiSelect.
// `action` mode: shows a placeholder, emits `pick` and resets — for "merge into…" style controls.
// `custom` mode: free text is allowed — Enter or blur commits whatever was typed when it matches no option.
import { computed, ref } from "vue";
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxLabel,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
} from "reka-ui";
import { Check as CheckIcon, ChevronDown as ChevronDownIcon } from "@lucide/vue";
import type { UiOption } from "@/ui/types";

const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null;
    options?: UiOption[];
    placeholder?: string;
    /** the box is a command launcher: picking emits `pick` and clears, rather than binding a value */
    action?: boolean;
    /** allow a value typed by hand that isn't in `options` */
    custom?: boolean;
    size?: "xs" | "sm";
    block?: boolean;
  }>(),
  { modelValue: undefined, options: () => [], placeholder: "Search…", size: "sm" },
);
const emit = defineEmits<{
  "update:modelValue": [string | number | null];
  pick: [string | number | null];
}>();
const term = ref("");
const open = ref(false);
const inner = computed({
  get: () =>
    props.action
      ? null
      : (props.options.find((o) => o.value === props.modelValue) ??
        (props.custom && props.modelValue
          ? { value: props.modelValue, label: String(props.modelValue) }
          : null)),
  set: (o: UiOption | null) => {
    if (!o) return;
    if (props.action) emit("pick", o.value);
    else emit("update:modelValue", o.value);
    term.value = "";
  },
});
function commitCustom(): boolean {
  if (!props.custom) return false;
  const v = term.value.trim();
  if (
    v &&
    v !== props.modelValue &&
    !props.options.some((o) => o.label.toLowerCase() === v.toLowerCase())
  ) {
    emit("update:modelValue", v);
    term.value = "";
    open.value = false;
    return true;
  }
  return false;
}
function onKey(e: KeyboardEvent) {
  const input = e.target as HTMLInputElement;
  if (e.key === "Escape") {
    open.value = false;
    input.blur();
    return;
  }
  if (e.key === "Enter") {
    // reka commits the highlighted item; if nothing is highlighted, take the first match (or the typed text)
    const highlighted = document.querySelector("[role=listbox] [data-highlighted]");
    if (highlighted && open.value) return;
    const first = groups.value[0]?.[1]?.[0];
    if (first && term.value && open.value) {
      e.preventDefault();
      inner.value = first;
      open.value = false;
      input.blur();
    } else if (commitCustom()) {
      e.preventDefault();
      input.blur();
    }
  }
}
function onBlur() {
  commitCustom();
}
const groups = computed(() => {
  const q = term.value.toLowerCase();
  const map = new Map();
  for (const o of props.options) {
    if (q && !o.label.toLowerCase().includes(q) && !(o.keywords ?? "").toLowerCase().includes(q))
      continue;
    const g = o.group ?? "";
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(o);
  }
  return [...map.entries()];
});
</script>

<template>
  <ComboboxRoot
    v-model="inner"
    v-model:open="open"
    :ignore-filter="true"
    :reset-search-term-on-blur="true"
    :class="block && 'w-full'"
  >
    <ComboboxAnchor
      class="ui-select-trigger"
      :class="[size === 'xs' ? 'py-0.5 text-xs' : 'py-1 text-sm', block && 'w-full']"
    >
      <span
        v-if="!action && inner?.color && !open"
        class="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
        :style="{ background: inner.color }"
      ></span>
      <ComboboxInput
        v-model="term"
        :display-value="(o) => o?.label ?? ''"
        :placeholder="action ? placeholder : (inner?.label ?? placeholder)"
        class="min-w-0 flex-1 bg-transparent placeholder-zinc-400 focus:outline-none"
        :class="action && 'italic'"
        @focus="
          (e: FocusEvent) => {
            (e.target as HTMLInputElement).select();
            open = true;
          }
        "
        @keydown="onKey"
        @blur="onBlur"
      />
      <ComboboxTrigger class="ml-1 shrink-0 text-zinc-400"
        ><ChevronDownIcon class="icon-sm"
      /></ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        :side-offset="4"
        class="ui-popup"
        :style="{ minWidth: 'var(--reka-combobox-trigger-width)', maxHeight: '320px' }"
      >
        <ComboboxViewport class="p-1">
          <ComboboxEmpty class="px-2 py-2 text-xs text-zinc-500">{{
            custom && term ? `↵ to use “${term}”` : "No match."
          }}</ComboboxEmpty>
          <template v-for="[g, opts] in groups" :key="g">
            <ComboboxGroup>
              <ComboboxLabel
                v-if="g"
                class="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400"
                >{{ g }}</ComboboxLabel
              >
              <ComboboxItem
                v-for="o in opts"
                :key="String(o.value)"
                :value="o"
                :text-value="o.label"
                class="ui-item"
              >
                <span
                  v-if="o.color"
                  class="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                  :style="{ background: o.color }"
                ></span>
                <span class="truncate">{{ o.label }}</span>
                <span v-if="o.hint" class="ml-2 text-[10px] text-zinc-400">{{ o.hint }}</span>
                <ComboboxItemIndicator v-if="!action" class="ml-auto pl-2 text-violet-500"
                  ><CheckIcon class="icon-sm"
                /></ComboboxItemIndicator>
              </ComboboxItem>
            </ComboboxGroup>
          </template>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
