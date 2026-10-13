<script setup lang="ts">
// A character's description, hidden until asked for. The model writes descriptions from the whole
// book, so one read before its chapter can give away who someone turns out to be; the reader and the
// cast list show a button in its place, and the text once it is pressed. The default slot replaces
// what is shown once it is — the Cast page's record puts the editable description there. The same
// holds for who wears a mask the scripting model linked, which `label` and `small` fit into a tag.
import { ref } from "vue";

withDefaults(
  defineProps<{
    text?: string;
    /** false shows it straight away — the Narrator has nothing to give away */
    hidden?: boolean;
    /** what is said when there is no text at all */
    empty?: string;
    /** what the button says in its place */
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
