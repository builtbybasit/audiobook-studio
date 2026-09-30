<script setup lang="ts">
// A character's description, hidden until asked for. The model writes descriptions from the whole
// book, so one read before its chapter can give away who someone turns out to be; the reader and the
// cast list show a button in its place, and the text once it is pressed.
import { ref } from "vue";

withDefaults(
  defineProps<{
    text?: string;
    /** false shows it straight away — the Narrator has nothing to give away */
    hidden?: boolean;
    /** what is said when there is no text at all */
    empty?: string;
  }>(),
  { text: "", hidden: true, empty: "No description yet." },
);
const revealed = ref(false);
</script>

<template>
  <span v-if="!text" class="italic text-zinc-400">{{ empty }}</span>
  <template v-else-if="revealed || !hidden">{{ text }}</template>
  <button
    v-else
    type="button"
    class="rounded border border-dashed border-zinc-300 px-2 py-1 italic text-zinc-400 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
    @click="revealed = true"
  >
    description hidden — spoilers · show
  </button>
</template>
