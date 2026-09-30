<script setup lang="ts">
// What a re-script does to the corrections made by hand: it does not carry them. The new run's
// script replaces the old one outright, and the old one — corrections and all — is kept in the
// chapter's history, where Restore brings it back. The run settings and the reader's Re-script
// popover both say so, with the count, so replacing a chapter somebody has worked on is never a
// surprise.
import { plural } from "@/lib/contents";
import { scriptsUnread } from "@/components/ReadFailure.vue";

defineProps<{
  /** corrected lines in what would be re-scripted; null while their scripts are still being read */
  edits: number | null;
  /** how many of those scripts could not be read, so the count never comes */
  unread?: number;
  /** what the count is of, as the sentence names it */
  scope: "this selection" | "this chapter";
}>();
/** read the scripts that could not be, again */
defineEmits<{ retry: [] }>();
</script>

<template>
  <p class="text-[11px] leading-snug text-zinc-500">
    <template v-if="edits === null && unread">
      {{ scriptsUnread(unread) }}, so the corrected lines are not counted.
      <button class="text-violet-600 hover:underline dark:text-violet-400" @click="$emit('retry')">
        Retry
      </button></template
    >
    <template v-else-if="edits === null">Counting the corrected lines…</template>
    <template v-else-if="edits">
      <span class="text-amber-700 dark:text-amber-400"
        >{{ plural(edits, "corrected line") }} in {{ scope }} {{ edits === 1 ? "is" : "are" }} not
        carried into the new script.</span
      >
      The script it replaces keeps them in the chapter's history, where Restore brings it
      back.</template
    >
    <template v-else>No manual corrections in {{ scope }}.</template>
  </p>
</template>
