<script setup lang="ts">
// A character's description, hidden behind a button until asked for: descriptions are written from
// the whole book, so can spoil. The default slot replaces the revealed text (the Cast page puts its
// editor there); `label` and `small` fit it into a tag.
import { ref } from "vue";

withDefaults(
  defineProps<{
    text?: string;
    /** false shows it straight away (the Narrator has nothing to give away) */
    hidden?: boolean;
    empty?: string;
    label?: string;
    /** a button the size of the tag it sits in */
    small?: boolean;
  }>(),
  {
    text: "",
    hidden: true,
    empty: "No description yet.",
    label: "description hidden — spoilers · show",
  },
);
const revealed = ref(false);
</script>

<template>
  <button
    v-if="text && hidden && !revealed"
    type="button"
    class="rounded border border-dashed border-zinc-300 italic text-zinc-400 hover:border-violet-400 hover:text-violet-500 dark:border-zinc-700"
    :class="small ? 'px-1' : 'px-2 py-1'"
    @click="revealed = true"
  >
    {{ label }}
  </button>
  <slot v-else
    ><span v-if="!text" class="italic text-zinc-400">{{ empty }}</span
    ><template v-else>{{ text }}</template></slot
  >
</template>
