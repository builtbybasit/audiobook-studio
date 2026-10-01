<script setup lang="ts">
// What can be done to the ticked speakers at once: merge them into another, or remove them. It
// sticks to the bottom of the window, so rows ticked far down a long cast still have it in reach.
// Neither asks first — the toast's Undo puts back exactly what moved, as the row's own × does.
import { computed } from "vue";

import { useCast } from "@/queries";
import { useCastStore } from "@/stores/cast";
import { UiCombobox } from "@/ui";

const props = defineProps<{ bookId: string; selected: ReadonlySet<string> }>();
const emit = defineEmits<{ clear: [] }>();

const castStore = useCastStore();
const { characters: cast } = useCast(props.bookId);

// every speaker to merge into, built once per change of the cast rather than per selection
const castOpts = computed(() =>
  cast.value.map((c) => ({
    value: c.name,
    label: c.name,
    color: c.color,
    keywords: c.aliases.join(" "),
  })),
);
const intoOpts = computed(() => castOpts.value.filter((o) => !props.selected.has(o.value)));

function mergeInto(into: string | number | null) {
  void castStore.mergeMany(props.bookId, [...props.selected], String(into));
  emit("clear");
}
function remove() {
  void castStore.removeMany(props.bookId, [...props.selected]);
  emit("clear");
}
</script>

<template>
  <div
    class="sticky bottom-4 z-10 flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-4 py-2 text-sm shadow-lg dark:border-violet-500/40 dark:bg-zinc-900"
  >
    <b>{{ selected.size }} selected</b> → merge into
    <UiCombobox
      action
      :options="intoOpts"
      placeholder="choose a speaker…"
      size="xs"
      class="w-56"
      @pick="mergeInto"
    />
    <button
      class="btn-ghost btn-xs text-red-600 dark:text-red-400"
      title="Their lines go to the Narrator"
      @click="remove"
    >
      Remove
    </button>
    <button class="ml-auto text-xs text-zinc-500" @click="emit('clear')">clear</button>
  </div>
</template>
