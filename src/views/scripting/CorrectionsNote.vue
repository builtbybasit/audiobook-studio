<script setup lang="ts">
// Warns that a re-script drops hand corrections; the old script stays in history for Restore.
import { plural } from "@/lib/contents";
import { scriptsUnread } from "@/components/ReadFailure.vue";

defineProps<{
  /** corrected lines in what would be re-scripted; null while their scripts are still being read */
  edits: number | null;
  /** scripts that could not be read */
  unread?: number;
  scope: "this selection" | "this chapter";
}>();
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
